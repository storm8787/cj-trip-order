/**
 * 출장 방문순서 추천기 — 도로거리 계산용 최소 서버
 *
 * 이 서버가 존재하는 이유는 단 하나입니다.
 * 카카오모빌리티 길찾기 API는 **REST API 키**를 요구하는데,
 * REST 키는 브라우저에 두면 그대로 유출되므로 서버에서만 다뤄야 합니다.
 * (장소 검색용 JavaScript 키는 지금까지처럼 브라우저가 직접 씁니다.)
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
const CFG = {
  port:        Number(process.env.PORT || 8787),
  key:         process.env.KAKAO_REST_API_KEY || '',
  priority:    (process.env.KAKAO_PRIORITY || 'DISTANCE').toUpperCase(),
  // 다중 목적지 API의 radius 상한은 10,000 m 입니다. 그 이상은 지정할 수 없습니다.
  radius:      Math.min(Number(process.env.KAKAO_RADIUS || 10000), 10000),
  maxPoints:   Number(process.env.MAX_POINTS || 9),       // 출발지 1 + 출장지 8
  ratePerMin:  Number(process.env.RATE_LIMIT_PER_MIN || 20),
  dailyCalls:  Number(process.env.DAILY_CALL_BUDGET || 5000),
  timeoutMs:   Number(process.env.UPSTREAM_TIMEOUT_MS || 10000),
  concurrency: Number(process.env.UPSTREAM_CONCURRENCY || 4),
  // 정적 화면을 다른 곳(GitHub Pages, ChatGPT Sites 등)에 올렸을 때 허용할 출처
  allowOrigins: (process.env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean),
  serveStatic: process.env.SERVE_STATIC !== 'false'
};

// 기본값은 카카오모빌리티 운영 주소. 테스트에서만 가짜 상위 서버로 돌려 끼웁니다.
const NAVI_BASE   = (process.env.KAKAO_NAVI_BASE || 'https://apis-navi.kakaomobility.com')
                      .replace(/\/+$/, '');
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
let dailyUsed = 0, dailyResetAt = Date.now() + 86400e3;

function rateLimit(ip) {
  const now = Date.now();
  if (now > dailyResetAt) { dailyUsed = 0; dailyResetAt = now + 86400e3; }
  if (dailyUsed >= CFG.dailyCalls) return 'DAILY_BUDGET';
  let b = buckets.get(ip);
  if (!b || now > b.resetAt) { b = { count: 0, resetAt: now + 60e3 }; buckets.set(ip, b); }
  if (b.count >= CFG.ratePerMin) return 'RATE_LIMIT';
  b.count++;
  return null;
}
// 오래된 버킷 정리
setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of buckets) if (now > b.resetAt) buckets.delete(ip);
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

async function callKakao(url, init) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), CFG.timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      ...init,
      signal: ctl.signal,
      headers: { ...(init?.headers || {}), Authorization: `KakaoAK ${CFG.key}` }
    });
  } catch (e) {
    throw new UpstreamError(e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK');
  } finally {
    clearTimeout(t);
  }
  if (res.status === 401) throw new UpstreamError('KEY_INVALID');
  if (res.status === 403) throw new UpstreamError('KEY_FORBIDDEN');
  if (res.status === 429) throw new UpstreamError('QUOTA');
  if (!res.ok) throw new UpstreamError('UPSTREAM', String(res.status));
  try { return await res.json(); }
  catch { throw new UpstreamError('BAD_RESPONSE'); }
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
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= tasks.length) return;
      results[i] = await tasks[i]();
    }
  }));
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
  const origin = req.headers.origin;
  if (!origin) return true;

  // 브라우저는 같은 출처의 POST 에도 Origin 헤더를 붙인다.
  // 이 서버가 화면을 직접 서빙하는 기본 배포 형태가 여기에 해당하므로,
  // 같은 host 에서 온 요청은 허용 목록과 무관하게 통과시킨다.
  const host = req.headers.host;
  if (host) {
    try { if (new URL(origin).host === host) return true; } catch { /* 형식 불량 */ }
  }

  if (CFG.allowOrigins.includes(origin) || CFG.allowOrigins.includes('*')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
    return true;
  }
  return false;   // 허용 목록에 없는 출처는 브라우저가 응답을 버립니다
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
  let p = decodeURIComponent(urlPath);
  // GitHub Pages 와 같은 하위 경로로 열어도 되게 한다
  if (p.startsWith('/cj-trip-order')) p = p.slice('/cj-trip-order'.length);
  if (p === '' || p === '/') p = '/index.html';
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
      if (n > limit) { reject(new Error('TOO_LARGE')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const allowed = cors(req, res);

  if (req.method === 'OPTIONS') { res.writeHead(allowed ? 204 : 403); return res.end(); }

  /* 상태 확인 — 화면이 도로거리 모드를 켤 수 있는지 판단하는 데 씁니다.
     키 자체는 절대 내보내지 않고, 설정되어 있는지만 알려 줍니다. */
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

  if (url.pathname === '/api/matrix') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST 로 요청해 주세요.' });
    if (!allowed) return sendJson(res, 403, { code: 'ORIGIN', error: '허용되지 않은 출처입니다.' });
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
        error: limited === 'DAILY_BUDGET'
          ? '오늘 이 서버에 허용된 길찾기 호출량을 모두 썼습니다.'
          : '요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.'
      });
    }

    let payload;
    try { payload = JSON.parse(await readBody(req) || '{}'); }
    catch { return sendJson(res, 400, { code: 'BAD_JSON', error: '요청 형식이 올바르지 않습니다.' }); }

    const v = validatePoints(payload.points);
    if (v.error) return sendJson(res, 400, { code: 'BAD_POINTS', error: v.error });

    try {
      const t0 = Date.now();
      const { matrix, missing, stats } = await buildMatrix(v.pts);
      dailyUsed += stats.multiCalls + stats.singleCalls;
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
        UPSTREAM:      [502, '카카오 길찾기 서버가 요청을 처리하지 못했습니다.']
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
