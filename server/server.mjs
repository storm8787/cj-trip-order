/**
 * 출장 방문순서 추천기 — 도로거리·Local 검색용 최소 서버
 *
 * 이 서버는 도로거리와 업무도구함용 장소·주소 검색을 중계합니다.
 * 카카오모빌리티 길찾기 API는 **REST API 키**를 요구하는데,
 * REST 키는 브라우저에 두면 그대로 유출되므로 서버에서만 다뤄야 합니다.
 * 기존 사이트는 장소 검색용 JavaScript 키를 공개 설정 API로 받아 SDK를 그대로 씁니다.
 *
 * 그 밖의 설계 원칙은 그대로입니다.
 *   - 의존성 0개. Node 18+ 내장 모듈만 사용합니다.
 *   - 데이터베이스 없음, 로그인 없음, 빌드 없음.
 *   - 이 서버 없이도 프로그램은 직선거리 모드로 완전히 동작합니다.
 *
 * 실행:
 *   KAKAO_REST_API_KEY=... node server/server.mjs
 *
 * 환경변수는 docs/ROAD_DISTANCE.md 참고.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/* ------------------------------------------------------------------ 설정 */
function boundedEnv(name, fallback, min, max) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid setting: ${name}`);
  return value;
}
const CFG = {
  port:        Number(process.env.PORT || 8787),
  key:         process.env.KAKAO_REST_API_KEY || '',
  javascriptKey: process.env.KAKAO_JAVASCRIPT_KEY || '',
  priority:    (process.env.KAKAO_PRIORITY || 'DISTANCE').toUpperCase(),
  // 다중 목적지 API의 radius 상한은 10,000 m 입니다. 그 이상은 지정할 수 없습니다.
  radius:      Math.min(Number(process.env.KAKAO_RADIUS || 10000), 10000),
  maxPoints:   Number(process.env.MAX_POINTS || 9),       // 출발지 1 + 출장지 8
  ratePerMin:  boundedEnv('RATE_LIMIT_PER_MIN', 20, 1, 10000),
  dailyCalls:  boundedEnv('DAILY_CALL_BUDGET', 5000, 0, 1000000),
  timeoutMs:   boundedEnv('UPSTREAM_TIMEOUT_MS', 10000, 1, 60000),
  concurrency: boundedEnv('UPSTREAM_CONCURRENCY', 4, 1, 32),
  // 정적 화면을 다른 곳(GitHub Pages, ChatGPT Sites 등)에 올렸을 때 허용할 출처
  allowOrigins: (process.env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean),
  searchRate: boundedEnv('SEARCH_RATE_LIMIT_PER_MIN', 30, 1, 10000),
  searchDailyCalls: boundedEnv('SEARCH_DAILY_CALL_BUDGET', 1000, 0, 1000000),
  searchTimeoutMs: boundedEnv('SEARCH_TIMEOUT_MS', 5000, 1, 60000),
  searchConcurrency: boundedEnv('SEARCH_UPSTREAM_CONCURRENCY', 4, 1, 32),
  allowFileOrigin: process.env.ALLOW_FILE_ORIGIN === 'true',
  serveStatic: process.env.SERVE_STATIC !== 'false'
};

// 기본값은 카카오모빌리티 운영 주소. 테스트에서만 가짜 상위 서버로 돌려 끼웁니다.
const NAVI_BASE   = (process.env.KAKAO_NAVI_BASE || 'https://apis-navi.kakaomobility.com')
                      .replace(/\/+$/, '');
// Only a server-side loopback override is accepted for Local API mock tests.
let LOCAL_BASE = 'https://dapi.kakao.com';
if (process.env.KAKAO_LOCAL_BASE) {
  const testBase = new URL(process.env.KAKAO_LOCAL_BASE);
  if (testBase.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(testBase.hostname) ||
      testBase.username || testBase.password || testBase.pathname !== '/' || testBase.search || testBase.hash) {
    throw new Error('KAKAO_LOCAL_BASE must be a loopback test server');
  }
  LOCAL_BASE = testBase.origin;
}
const NAVI_SINGLE = NAVI_BASE + '/v1/directions';
const NAVI_MULTI  = NAVI_BASE + '/v1/destinations/directions';

/** 키는 어떤 경로로도 밖으로 나가면 안 됩니다. 로그에도 남기지 않습니다. */
function log(...a) {
  const line = a.join(' ');
  if (CFG.key && line.includes(CFG.key)) return;   // 혹시 모를 사고 방지
  console.log(new Date().toISOString(), line);
}

/* ------------------------------------------------------------------ 호출량 제한 */
const buckets = new Map();           // ip -> { count, resetAt }
const searchBuckets = new Map();
const pendingSearches = new Map();
const searchBudget = { used: 0, resetAt: Date.now() + 86400e3, limit: CFG.searchDailyCalls };
const roadBudget = { used: 0, resetAt: Date.now() + 86400e3, limit: CFG.dailyCalls };

// Reserve synchronously before fetch: failed calls and concurrent calls count too.
function reserveCall(budget) {
  const now = Date.now();
  if (now >= budget.resetAt) { budget.used = 0; budget.resetAt = now + 86400e3; }
  if (budget.used >= budget.limit) throw new UpstreamError('DAILY_BUDGET');
  budget.used++;
}

function rateLimit(ip, store = buckets, limit = CFG.ratePerMin) {
  const now = Date.now();
  let b = store.get(ip);
  if (!b || now > b.resetAt) { b = { count: 0, resetAt: now + 60e3 }; store.set(ip, b); }
  if (b.count >= limit) return 'RATE_LIMIT';
  b.count++;
  return null;
}
// 오래된 버킷 정리
setInterval(() => {
  const now = Date.now();
  for (const store of [buckets, searchBuckets]) {
    for (const [ip, b] of store) if (now > b.resetAt) store.delete(ip);
  }
}, 60e3).unref();

/* ------------------------------------------------------------------ 입력 검증 */
const KR = { latMin: 33, latMax: 39.5, lngMin: 124, lngMax: 132 };

function validatePoints(raw) {
  if (!Array.isArray(raw)) return { error: '좌표 목록이 없습니다.' };
  if (raw.length < 2) return { error: '지점이 2곳 이상이어야 합니다.' };
  if (raw.length > CFG.maxPoints) {
    return { error: `지점은 최대 ${CFG.maxPoints}곳까지만 계산할 수 있습니다.` };
  }
  const pts = [];
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i] || {};
    const lat = Number(p.lat), lng = Number(p.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return { error: `${i + 1}번째 지점의 좌표가 숫자가 아닙니다.` };
    }
    if (lat < KR.latMin || lat > KR.latMax || lng < KR.lngMin || lng > KR.lngMax) {
      return { error: `${i + 1}번째 지점의 좌표가 대한민국 범위를 벗어났습니다.` };
    }
    pts.push({ lat, lng });
  }
  return { pts };
}

/* ------------------------------------------------------------------ Local search
 * Contract source: official documentation summary supplied by the user, 2026-11-24.
 * https://developers.kakao.com/docs/ko/local/dev-guide (not fetched in this cloud).
 */
function validateSearch(params) {
  const known = new Set(['type', 'query', 'page', 'size']);
  for (const key of params.keys()) {
    if (!known.has(key) || params.getAll(key).length !== 1) return null;
  }
  const type = params.get('type');
  if (!['keyword', 'address'].includes(type)) return null;
  const query = (params.get('query') || '').trim();
  if ([...query].length < 1 || [...query].length > 100 || /[\u0000-\u001f\u007f]/u.test(query)) return null;
  const pageRaw = params.get('page') ?? '1';
  const sizeRaw = params.get('size') ?? (type === 'keyword' ? '15' : '10');
  if (!/^[1-9]\d*$/.test(pageRaw) || !/^[1-9]\d*$/.test(sizeRaw)) return null;
  const page = Number(pageRaw), size = Number(sizeRaw);
  if (page > 45 || size > (type === 'keyword' ? 15 : 30)) return null;
  return { type, query, page, size };
}

function normalizeSearch(data, request) {
  if (!Array.isArray(data?.documents) || data.documents.length > request.size ||
      typeof data.meta?.is_end !== 'boolean') throw new UpstreamError('BAD_RESPONSE');
  const text = v => typeof v === 'string' ? v : '';
  const coordinate = (v, min, max) => {
    if ((typeof v !== 'string' && typeof v !== 'number') || String(v).trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= min && n <= max ? n : null;
  };
  const items = [];
  for (const d of data.documents) {
    const lat = coordinate(d?.y, -90, 90), lng = coordinate(d?.x, -180, 180);
    if (lat === null || lng === null) continue;
    const keyword = request.type === 'keyword';
    items.push({
      id: keyword && typeof d.id === 'string' ? d.id : null,
      name: keyword ? text(d.place_name) :
        (text(d.road_address?.building_name) || text(d.address_name) || text(d.address?.address_name)),
      roadAddress: keyword ? text(d.road_address_name) : text(d.road_address?.address_name),
      address: keyword ? text(d.address_name) : (text(d.address?.address_name) || text(d.address_name)),
      lat, lng
    });
  }
  return { items, page: request.page, hasMore: !data.meta.is_end && request.page < 45,
    omittedCount: data.documents.length - items.length };
}

async function searchLocal(request) {
  const key = JSON.stringify(request);
  if (pendingSearches.has(key)) return pendingSearches.get(key);
  if (pendingSearches.size >= CFG.searchConcurrency) throw new UpstreamError('SEARCH_BUSY');
  const url = new URL(`/v2/local/search/${request.type}.json`, LOCAL_BASE);
  url.search = new URLSearchParams({ query: request.query, page: String(request.page), size: String(request.size) });
  // No automatic fallback, retries or retained query/result cache.
  const pending = callKakao(url, { method: 'GET' }, searchBudget, CFG.searchTimeoutMs)
    .then(data => normalizeSearch(data, request));
  pendingSearches.set(key, pending);
  try { return await pending; }
  finally { pendingSearches.delete(key); }
}

function searchError(res, e) {
  const code = e instanceof UpstreamError ? e.code : 'UNKNOWN';
  const errors = {
    KEY_INVALID: [502, '서버의 카카오 REST API 키가 거부되었습니다. 관리자에게 문의해 주세요.'],
    KEY_FORBIDDEN: [502, '카카오 Local API 이용 권한을 확인해 주세요.'],
    QUOTA: [429, '카카오 검색 API 호출 한도를 넘었습니다.'],
    DAILY_BUDGET: [429, '이 서버의 검색 호출량 상한에 도달했습니다.'],
    SEARCH_BUSY: [429, '검색 요청을 처리 중입니다. 잠시 후 다시 시도해 주세요.'],
    TIMEOUT: [504, '검색 서버 응답 시간이 초과되었습니다.'],
    NETWORK: [502, '카카오 검색 서버에 연결하지 못했습니다.'],
    BAD_RESPONSE: [502, '카카오 검색 서버 응답을 처리하지 못했습니다.'],
    UPSTREAM: [502, '카카오 검색 서버가 요청을 처리하지 못했습니다.']
  };
  const [status, error] = errors[code] || [500, '검색을 완료하지 못했습니다.'];
  // Never log query strings, upstream response bodies, or error messages.
  log('search failed', code);
  return sendJson(res, status, { code, error });
}

/* ------------------------------------------------------------------ 거리 도우미 */
function haversineM(a, b) {
  const R = 6371008.8, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/* ------------------------------------------------------------------ 상위 API 호출 */
class UpstreamError extends Error {
  constructor(code, detail) { super(code); this.code = code; this.detail = detail || ''; }
}

async function callKakao(url, init, budget = roadBudget, timeoutMs = CFG.timeoutMs) {
  reserveCall(budget);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init, redirect: 'error', signal: ctl.signal,
      headers: { ...(init?.headers || {}), Authorization: `KakaoAK ${CFG.key}` }
    });
    if (res.status === 401) throw new UpstreamError('KEY_INVALID');
    if (res.status === 403) throw new UpstreamError('KEY_FORBIDDEN');
    if (res.status === 429) throw new UpstreamError('QUOTA');
    if (!res.ok) throw new UpstreamError('UPSTREAM');
    try { return await res.json(); }
    catch (e) {
      if (ctl.signal.aborted) throw new UpstreamError('TIMEOUT');
      throw new UpstreamError('BAD_RESPONSE');
    }
  } catch (e) {
    if (e instanceof UpstreamError) throw e;
    throw new UpstreamError(ctl.signal.aborted ? 'TIMEOUT' : 'NETWORK');
  } finally { clearTimeout(t); }
}

/** routes 항목 하나에서 거리·시간을 꺼낸다. 실패하면 null. */
function readRoute(r) {
  if (!r) return null;
  if (r.result_code !== undefined && r.result_code !== 0) return null;   // 경로 없음
  const s = r.summary || r;
  const distance = Number(s.distance), duration = Number(s.duration);
  if (!Number.isFinite(distance) || !Number.isFinite(duration)) return null;
  return { distance, duration };
}

/** 다중 목적지 길찾기 — 출발지 1곳 → 여러 목적지. radius 안쪽만 돌아옵니다. */
async function multiFrom(origin, targets) {
  const body = {
    origin: { x: origin.lng, y: origin.lat },
    destinations: targets.map(t => ({ x: t.pt.lng, y: t.pt.lat, key: String(t.j) })),
    radius: CFG.radius,
    priority: CFG.priority
  };
  const data = await callKakao(NAVI_MULTI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const out = new Map();
  for (const r of (data.routes || [])) {
    const v = readRoute(r);
    if (v && r.key !== undefined) out.set(String(r.key), v);
  }
  return out;
}

/** 단건 길찾기 — 일괄 조회로 못 받은 구간을 메웁니다. */
async function singlePair(a, b) {
  const q = new URLSearchParams({
    origin: `${a.lng},${a.lat}`,
    destination: `${b.lng},${b.lat}`,
    priority: CFG.priority
  });
  const data = await callKakao(`${NAVI_SINGLE}?${q}`, { method: 'GET' });
  return readRoute((data.routes || [])[0]);
}

async function pooled(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0, failure;
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (true) {
      const i = next++;
      if (failure || i >= tasks.length) return;
      try { results[i] = await tasks[i](); }
      catch (e) { failure ||= e; }
    }
  }));
  if (failure) throw failure;
  return results;
}

/**
 * 방향별 거리표를 만든다.
 *
 * 전략 — 순서 후보(최대 40,320가지)마다 부르지 않고, 구간만 한 번씩 조회한다.
 *   1) 각 출발점마다 다중 목적지 API 1회  → 지점 9개면 9회
 *   2) radius(최대 10 km) 밖이거나 응답에서 빠진 구간만 단건 API로 보충
 * A→B 와 B→A 는 서로 다른 값이므로 각각 조회한다.
 */
async function buildMatrix(pts) {
  const m = pts.length;
  const matrix = Array.from({ length: m }, () => new Array(m).fill(null));
  for (let i = 0; i < m; i++) matrix[i][i] = { distance: 0, duration: 0 };

  const stats = { multiCalls: 0, singleCalls: 0, pairs: m * (m - 1), outOfRadius: 0 };

  // 1) 일괄 조회. 직선거리가 이미 radius를 넘으면 도로거리는 반드시 넘으므로 빼고 보낸다.
  const batch = [];
  for (let i = 0; i < m; i++) {
    const targets = [];
    for (let j = 0; j < m; j++) {
      if (i === j) continue;
      if (haversineM(pts[i], pts[j]) > CFG.radius) { stats.outOfRadius++; continue; }
      targets.push({ j, pt: pts[j] });
    }
    if (targets.length) batch.push({ i, targets });
  }
  const batchRes = await pooled(
    batch.map(b => () => multiFrom(pts[b.i], b.targets)), CFG.concurrency);
  stats.multiCalls = batch.length;
  batch.forEach((b, k) => {
    const got = batchRes[k];
    for (const t of b.targets) {
      const v = got.get(String(t.j));
      if (v) matrix[b.i][t.j] = v;
    }
  });

  // 2) 빠진 구간을 단건으로 보충
  const gaps = [];
  for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) {
    if (i !== j && matrix[i][j] === null) gaps.push([i, j]);
  }
  const gapRes = await pooled(
    gaps.map(([i, j]) => () => singlePair(pts[i], pts[j])), CFG.concurrency);
  stats.singleCalls = gaps.length;
  gaps.forEach(([i, j], k) => { matrix[i][j] = gapRes[k]; });

  // 3) 그래도 없는 구간 보고 — 직선거리로 메우지 않는다.
  const missing = [];
  for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) {
    if (i !== j && matrix[i][j] === null) missing.push({ from: i, to: j });
  }
  return { matrix, missing, stats };
}

/* ------------------------------------------------------------------ HTTP */
function cors(req, res) {
  res.setHeader('Vary', 'Origin');
  const origin = req.headers.origin;
  if (!origin) return true; // Non-browser clients are not authenticated by CORS.
  let allowed = false;
  if (origin === 'null') {
    // Opaque origins also include sandboxed documents; this does not identify a file.
    allowed = CFG.allowFileOrigin;
  } else {
    try {
      const parsed = new URL(origin);
      const protocol = req.socket.encrypted ? 'https' :
        (req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http');
      const sameOrigin = origin === `${protocol}://${req.headers.host}`;
      allowed = ['http:', 'https:'].includes(parsed.protocol) && parsed.origin === origin &&
        (sameOrigin || CFG.allowOrigins.includes(origin) || CFG.allowOrigins.includes('*'));
    } catch { /* Malformed origin stays denied. */ }
  }
  if (!allowed) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '600');
  return true;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

function serveStatic(req, res, urlPath) {
  let p;
  try { p = decodeURIComponent(urlPath); }
  catch { return sendJson(res, 400, { code: 'BAD_REQUEST', error: '요청 주소가 올바르지 않습니다.' }); }
  // GitHub Pages 와 같은 하위 경로로 열어도 되게 한다
  if (p.startsWith('/cj-trip-order')) p = p.slice('/cj-trip-order'.length);
  // 서버 배포에서는 앱을 바로 제공해 주소창의 루트 경로를 유지한다.
  // GitHub Pages용 index.html과 한글 파일 직접 접속은 그대로 둔다.
  if (p === '' || p === '/') p = '/출장방문순서추천.html';
  const file = path.resolve(ROOT, '.' + p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('찾을 수 없습니다');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf) return xf.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => {
      n += c.length;
      if (n > limit) { reject(new Error('TOO_LARGE')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const allowed = cors(req, res);
  if (Buffer.byteLength(req.url || '') > 4096) {
    return sendJson(res, 414, { code: 'REQUEST_TOO_LARGE', error: '요청 주소가 너무 깁니다.' });
  }
  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch { return sendJson(res, 400, { code: 'BAD_REQUEST', error: '요청 주소가 올바르지 않습니다.' }); }

  if (!allowed) return sendJson(res, 403, { code: 'ORIGIN', error: '허용되지 않은 출처입니다.' });
  if (req.method === 'OPTIONS') {
    const method = req.headers['access-control-request-method'];
    const headers = String(req.headers['access-control-request-headers'] || '')
      .split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
    if ((method && !['GET', 'POST'].includes(method)) || headers.some(h => h !== 'content-type')) {
      return sendJson(res, 403, { code: 'PREFLIGHT', error: '허용되지 않은 메서드 또는 헤더입니다.' });
    }
    res.writeHead(204); return res.end();
  }

  // 명시적으로 허용한 공개 값만 반환합니다. CFG나 process.env를 직렬화하지 않습니다.
  if (url.pathname === '/api/config') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'GET 으로 요청해 주세요.' });
    return sendJson(res, 200, { kakaoJavascriptKey: CFG.javascriptKey });
  }

  /* 상태 확인은 REST 키의 존재 여부만 알립니다. */
  if (url.pathname === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      road: Boolean(CFG.key),
      priority: CFG.priority,
      maxPoints: CFG.maxPoints,
      radiusM: CFG.radius,
      provider: '카카오모빌리티 길찾기'
    });
  }

  if (url.pathname === '/api/search') {
    if (req.method !== 'GET') return sendJson(res, 405, { code: 'METHOD', error: 'GET 으로 요청해 주세요.' });
    const request = validateSearch(url.searchParams);
    if (!request) return sendJson(res, 400, { code: 'BAD_SEARCH', error: '검색 방식·검색어·페이지·결과 수를 확인해 주세요.' });
    if (!CFG.key) return sendJson(res, 503, { code: 'NO_KEY', error: '서버 검색 설정이 필요합니다. 관리자에게 문의해 주세요.' });
    if (rateLimit(clientIp(req), searchBuckets, CFG.searchRate)) {
      return sendJson(res, 429, { code: 'RATE_LIMIT', error: '검색 요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.' });
    }
    try { return sendJson(res, 200, await searchLocal(request)); }
    catch (e) { return searchError(res, e); }
  }

  if (url.pathname === '/api/matrix') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST 로 요청해 주세요.' });
    if (!CFG.key) {
      return sendJson(res, 503, {
        code: 'NO_KEY',
        error: '서버에 카카오 REST API 키가 설정되어 있지 않습니다.'
      });
    }
    const limited = rateLimit(clientIp(req));
    if (limited) {
      return sendJson(res, 429, {
        code: limited,
        error: '요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.'
      });
    }

    let payload;
    try { payload = JSON.parse(await readBody(req) || '{}'); }
    catch (e) {
      const tooLarge = e.message === 'TOO_LARGE';
      return sendJson(res, tooLarge ? 413 : 400, {
        code: tooLarge ? 'REQUEST_TOO_LARGE' : 'BAD_JSON', error: '요청 형식 또는 크기가 올바르지 않습니다.'
      });
    }

    const v = validatePoints(payload?.points);
    if (v.error) return sendJson(res, 400, { code: 'BAD_POINTS', error: v.error });

    try {
      const t0 = Date.now();
      const { matrix, missing, stats } = await buildMatrix(v.pts);
      log(`matrix pts=${v.pts.length} multi=${stats.multiCalls} single=${stats.singleCalls} ` +
          `missing=${missing.length} ${Date.now() - t0}ms`);
      return sendJson(res, 200, {
        matrix, missing, stats,
        priority: CFG.priority,
        provider: '카카오모빌리티 길찾기'
      });
    } catch (e) {
      const code = e instanceof UpstreamError ? e.code : 'UNKNOWN';
      log('matrix failed', code, e.detail || '');
      const map = {
        KEY_INVALID:   [502, '서버에 등록된 카카오 REST API 키가 거부되었습니다.'],
        KEY_FORBIDDEN: [502, '이 키로는 길찾기 API를 쓸 수 없습니다. 카카오모빌리티 이용 권한을 확인해 주세요.'],
        QUOTA:         [429, '카카오 길찾기 API 호출 한도를 넘었습니다.'],
        TIMEOUT:       [504, '카카오 길찾기 서버 응답이 제한 시간 안에 오지 않았습니다.'],
        NETWORK:       [502, '카카오 길찾기 서버에 연결하지 못했습니다.'],
        BAD_RESPONSE:  [502, '카카오 길찾기 서버가 예상과 다른 응답을 보냈습니다.'],
        UPSTREAM:      [502, '카카오 길찾기 서버가 요청을 처리하지 못했습니다.'],
        DAILY_BUDGET:  [429, '오늘 이 서버에 허용된 길찾기 호출량을 모두 썼습니다.']
      };
      const [status, msg] = map[code] || [500, '도로거리를 계산하지 못했습니다.'];
      return sendJson(res, status, { code, error: msg });
    }
  }

  if (CFG.serveStatic) return serveStatic(req, res, url.pathname);
  res.writeHead(404); res.end();
});

// NO_LISTEN=1 이면 포트를 열지 않습니다. 테스트가 함수만 가져다 쓸 때 씁니다.
if (process.env.NO_LISTEN !== '1') server.listen(CFG.port, () => {
  log(`출장 방문순서 추천기 서버 http://localhost:${CFG.port}`);
  log(`도로거리 모드: ${CFG.key ? '사용 가능' : '꺼짐 (KAKAO_REST_API_KEY 없음)'}`);
  log(`길찾기 기준: ${CFG.priority} · 일괄조회 반경 ${CFG.radius}m · 최대 ${CFG.maxPoints}지점`);
  if (CFG.allowOrigins.length) log(`허용 출처: ${CFG.allowOrigins.join(', ')}`);
});

export { buildMatrix, validatePoints, haversineM, readRoute, CFG, server };
