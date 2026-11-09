/**
 * 도로거리 모드 검증
 *
 * 실제 카카오모빌리티 서버에는 접속하지 않습니다.
 * 가짜 상위 서버(KAKAO_NAVI_BASE)를 띄우고, 진짜 server/server.mjs 를 그 앞에 세운 뒤,
 * 진짜 출장방문순서추천.html 을 Chromium 으로 열어 끝까지 돌립니다.
 *
 * 따라서 여기서 통과한 것은 "모의 거리표 기준 통과"이며,
 * 실제 카카오 API 동작을 보증하지 않습니다.
 *
 * 실행:  node tests/road.mjs
 */
import { chromium } from 'playwright';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name + (extra ? ' :: ' + extra : '')); console.log('  FAIL  ' + name + (extra ? ' :: ' + extra : '')); }
}
const section = t => console.log('\n=== ' + t + ' ===');

/* ──────────────────────────────────────────────────────────── 시험용 지점
 * 좌표는 "직선거리 최단 순서"와 "도로거리 최단 순서"가 서로 달라지도록
 * 일부러 꾸민 값입니다. 실제 장소의 좌표가 아닙니다.
 *
 *            N(다리 없음)
 *   A ─────────────── B      A와 B는 직선으로는 가깝지만
 *   │     강 ~~~~~    │      강을 건널 다리가 없어 크게 돌아가야 한다
 *   C ─────────────── D
 */
const PTS = [
  { name: '출발지',  lat: 36.9900, lng: 127.9200 },   // 0
  { name: '강북 A',  lat: 36.9980, lng: 127.9300 },   // 1
  { name: '강남 B',  lat: 36.9820, lng: 127.9320 },   // 2
  { name: '서쪽 C',  lat: 36.9890, lng: 127.8600 }    // 3
];

/**
 * 모의 도로거리표(미터). 직선거리와 일부러 다르게, 그리고 비대칭으로 만든다.
 * 1↔2 는 강 때문에 아주 멀고, 1→2 와 2→1 도 서로 다르다(일방통행 가정).
 */
const ROAD = {
  '0-1': 1500,  '1-0': 1600,
  '0-2': 2100,  '2-0': 2000,
  '0-3': 5200,  '3-0': 5100,
  '1-2': 24000, '2-1': 19000,     // 강 우회 — 방향에 따라 크게 다름
  '1-3': 6000,  '3-1': 6100,
  '2-3': 6400,  '3-2': 6300
};
const DUR = k => Math.round(ROAD[k] / 1000 * 90);   // 1 km 당 90초로 가정

/* ──────────────────────────────────────────────── 가짜 카카오모빌리티 서버 */
let upstreamMode = 'ok';          // ok | missing-pair | key-invalid | quota | timeout
let upstreamHits = { multi: 0, single: 0 };

function idxOf(x, y) {
  for (let i = 0; i < PTS.length; i++) {
    if (Math.abs(PTS[i].lng - x) < 1e-9 && Math.abs(PTS[i].lat - y) < 1e-9) return i;
  }
  return -1;
}
function routeFor(i, j) {
  const k = `${i}-${j}`;
  // 'missing-pair' 모드에서는 1→2 구간만 경로가 없다고 응답한다
  if (upstreamMode === 'missing-pair' && k === '1-2') return { result_code: 701, result_msg: '경로 없음' };
  const d = ROAD[k];
  if (d === undefined) return { result_code: 701, result_msg: '경로 없음' };
  return { result_code: 0, summary: { distance: d, duration: DUR(k) } };
}

const upstream = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (status, obj) => {
    const b = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(b);
  };
  if (upstreamMode === 'key-invalid') return send(401, { msg: 'unauthorized' });
  if (upstreamMode === 'quota')       return send(429, { msg: 'quota exceeded' });
  if (upstreamMode === 'timeout')     return;        // 아무 응답도 하지 않는다

  // 인증 헤더가 실제로 붙는지 확인
  if (!/^KakaoAK\s+\S+/.test(req.headers.authorization || '')) return send(401, { msg: 'no auth' });

  if (u.pathname === '/v1/destinations/directions') {
    upstreamHits.multi++;
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let p;
      try { p = JSON.parse(body); } catch { return send(400, {}); }
      const oi = idxOf(p.origin.x, p.origin.y);
      const radius = Number(p.radius);
      const routes = [];
      for (const d of (p.destinations || [])) {
        const di = idxOf(d.x, d.y);
        const r = routeFor(oi, di);
        // 반경 밖이면 응답에서 빠진다 — 실제 API 동작을 흉내낸다
        if (r.result_code === 0 && r.summary.distance > radius) continue;
        routes.push({ key: d.key, ...r });
      }
      send(200, { trans_id: 't', routes });
    });
    return;
  }
  if (u.pathname === '/v1/directions') {
    upstreamHits.single++;
    const [ox, oy] = u.searchParams.get('origin').split(',').map(Number);
    const [dx, dy] = u.searchParams.get('destination').split(',').map(Number);
    return send(200, { routes: [routeFor(idxOf(ox, oy), idxOf(dx, dy))] });
  }
  send(404, {});
});

/* ─────────────────────────────────────── 독립 구현: 비대칭 Held-Karp 최솟값 */
function heldKarpAsym(D, n, ret) {
  const SZ = 1 << n;
  const dp = Array.from({ length: SZ }, () => new Float64Array(n).fill(Infinity));
  for (let j = 0; j < n; j++) dp[1 << j][j] = D[0][j + 1];
  for (let m = 1; m < SZ; m++) {
    for (let j = 0; j < n; j++) {
      const cur = dp[m][j];
      if (!(m & (1 << j)) || cur === Infinity) continue;
      for (let k = 0; k < n; k++) {
        if (m & (1 << k)) continue;
        const v = cur + D[j + 1][k + 1];
        if (v < dp[m | (1 << k)][k]) dp[m | (1 << k)][k] = v;
      }
    }
  }
  let best = Infinity;
  for (let j = 0; j < n; j++) {
    const v = dp[SZ - 1][j] + (ret ? D[j + 1][0] : 0);
    if (v < best) best = v;
  }
  return best;
}
function roadMatrixKm(n) {
  const D = Array.from({ length: n + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) {
    if (i !== j) D[i][j] = ROAD[`${i}-${j}`] / 1000;
  }
  return D;
}

/* ───────────────────────────────────────────────────── 서버 기동 보조 */
const UP_PORT = 8911, APP_PORT = 8912;
function startApp(env = {}) {
  const p = spawn(process.execPath, [path.join(ROOT, 'server', 'server.mjs')], {
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      KAKAO_REST_API_KEY: 'TEST_DUMMY_KEY_NOT_REAL',
      KAKAO_NAVI_BASE: `http://127.0.0.1:${UP_PORT}`,
      KAKAO_RADIUS: '10000',
      UPSTREAM_TIMEOUT_MS: '1500',
      RATE_LIMIT_PER_MIN: '100',
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  p.stdout.on('data', () => {});
  p.stderr.on('data', d => console.log('  [server] ' + String(d).trim()));
  return p;
}
async function waitUp(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return true; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

/* ════════════════════════════════════════════════════════════════ 실행 */
await new Promise(r => upstream.listen(UP_PORT, r));
const browser = await chromium.launch();
let app = startApp();
const BASE = `http://127.0.0.1:${APP_PORT}`;

try {
  ok('길찾기 서버가 기동됨', await waitUp(BASE + '/api/health'));

  /* ---------------- 1. 서버 계약 ---------------- */
  section('1. 서버 상태와 키 보호');
  {
    const h = await (await fetch(BASE + '/api/health')).json();
    ok('health 가 도로거리 사용 가능을 보고', h.road === true);
    ok('health 가 길찾기 기준을 DISTANCE 로 보고', h.priority === 'DISTANCE', h.priority);
    ok('health 가 최대 지점 수를 보고', h.maxPoints === 9, String(h.maxPoints));
    ok('health 응답에 REST 키가 들어 있지 않음',
      !JSON.stringify(h).includes('TEST_DUMMY_KEY_NOT_REAL'));

    const page = JSON.stringify(h);
    ok('health 가 키 존재 여부만 알려 주고 값은 숨김', page.includes('"road":true') && !page.includes('KakaoAK'));
  }

  /* ---------------- 2. 입력 검증 ---------------- */
  section('2. 서버 입력 검증');
  {
    const bad = [
      [{ points: [] }, '지점이 2곳 이상'],
      [{ points: Array.from({ length: 10 }, () => ({ lat: 36.99, lng: 127.92 })) }, '최대'],
      [{ points: [{ lat: 'x', lng: 1 }, { lat: 36.99, lng: 127.92 }] }, '숫자'],
      [{ points: [{ lat: 1.0, lng: 1.0 }, { lat: 36.99, lng: 127.92 }] }, '대한민국 범위']
    ];
    for (const [body, want] of bad) {
      const r = await fetch(BASE + '/api/matrix', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      const j = await r.json();
      ok(`잘못된 입력을 거부: ${want}`, r.status === 400 && (j.error || '').includes(want),
        `${r.status} ${j.error || ''}`);
    }
    const r = await fetch(BASE + '/api/matrix', { method: 'GET' });
    ok('GET 요청은 거부', r.status === 405);
  }

  /* ---------------- 3. 거리표 조회 전략 ---------------- */
  section('3. 거리표 조회 — 순서마다 호출하지 않고 구간만 1회씩');
  {
    upstreamHits = { multi: 0, single: 0 };
    const r = await fetch(BASE + '/api/matrix', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ points: PTS.map(p => ({ lat: p.lat, lng: p.lng })) })
    });
    const j = await r.json();
    ok('거리표 조회 성공', r.ok && Array.isArray(j.matrix), String(r.status));
    ok('4지점 → 12개 방향 구간을 모두 채움',
      j.missing.length === 0 && j.stats.pairs === 12, JSON.stringify(j.stats));
    ok('다중 목적지 API 를 지점 수만큼만 호출 (4회)', upstreamHits.multi === 4, String(upstreamHits.multi));
    ok('전체 호출이 방향 구간 수(12)보다 훨씬 적음',
      upstreamHits.multi + upstreamHits.single < 12,
      `multi=${upstreamHits.multi} single=${upstreamHits.single}`);

    ok('A→B 와 B→A 를 서로 다른 값으로 돌려줌',
      j.matrix[1][2].distance === 24000 && j.matrix[2][1].distance === 19000,
      `${j.matrix[1][2].distance} / ${j.matrix[2][1].distance}`);
    ok('대각선은 0', j.matrix[2][2].distance === 0);
    ok('소요시간도 함께 돌려줌', j.matrix[0][1].duration === DUR('0-1'));
    ok('응답에 REST 키가 들어 있지 않음',
      !JSON.stringify(j).includes('TEST_DUMMY_KEY_NOT_REAL'));
  }

  /* ---------------- 4. 반경 밖 구간은 단건으로 보충 ---------------- */
  section('4. radius(10km) 밖 구간 — 일괄 조회로 못 받으면 단건으로 보충');
  {
    // 반경을 3km 로 낮추면 대부분 구간이 일괄 조회에서 빠진다
    app.kill(); await new Promise(r => setTimeout(r, 300));
    app = startApp({ KAKAO_RADIUS: '3000' });
    await waitUp(BASE + '/api/health');

    upstreamHits = { multi: 0, single: 0 };
    const r = await fetch(BASE + '/api/matrix', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ points: PTS.map(p => ({ lat: p.lat, lng: p.lng })) })
    });
    const j = await r.json();
    ok('반경을 좁혀도 12개 구간을 모두 채움', r.ok && j.missing.length === 0,
      JSON.stringify(j.stats));
    ok('반경 밖 구간은 단건 호출로 보충됨', upstreamHits.single > 0,
      `multi=${upstreamHits.multi} single=${upstreamHits.single}`);
    ok('보충한 값도 비대칭이 유지됨',
      j.matrix[1][2].distance === 24000 && j.matrix[2][1].distance === 19000);

    app.kill(); await new Promise(r => setTimeout(r, 300));
    app = startApp();
    await waitUp(BASE + '/api/health');
  }

  /* ---------------- 5. 최적해 교차검증 ---------------- */
  section('5. 도로거리 최적해 — 독립 Held-Karp 와 교차검증');
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', e => { fail++; failures.push('pageerror: ' + e.message); console.log('  FAIL  콘솔 예외: ' + e.message); });
  await page.goto(BASE + '/%EC%B6%9C%EC%9E%A5%EB%B0%A9%EB%AC%B8%EC%88%9C%EC%84%9C%EC%B6%94%EC%B2%9C.html');
  await page.waitForFunction(() => !!window.__CJ__);
  {
    const D = roadMatrixKm(3);
    for (const ret of [true, false]) {
      const got = await page.evaluate(([D, ret]) => {
        const o = { lat: 0, lng: 0 };                       // 거리표를 주면 좌표는 쓰이지 않는다
        const s = [{ lat: 0, lng: 0 }, { lat: 0, lng: 0 }, { lat: 0, lng: 0 }];
        const r = window.__CJ__.solveBestOrder(o, s, ret, D);
        return { total: r.total, order: r.order, legs: r.legs, evaluated: r.evaluated };
      }, [D, ret]);
      const want = heldKarpAsym(D, 3, ret);
      ok(`비대칭 거리표 최솟값 일치 (복귀 ${ret ? '포함' : '미포함'})`,
        Math.abs(got.total - want) < 1e-9, `${got.total.toFixed(6)} vs ${want.toFixed(6)}`);
      ok(`구간 수가 맞음 (복귀 ${ret ? '포함' : '미포함'})`,
        got.legs.length === 3 + (ret ? 1 : 0));
      ok(`모든 출장지를 정확히 한 번씩 (복귀 ${ret ? '포함' : '미포함'})`,
        new Set(got.order).size === 3);
      ok(`전수 비교 3! = 6가지 (복귀 ${ret ? '포함' : '미포함'})`, got.evaluated === 6);
    }
  }

  /* ---------------- 6. 직선 최단 ≠ 도로 최단 ---------------- */
  section('6. 직선거리 최단 순서와 도로거리 최단 순서가 달라지는 사례');
  {
    const cmp = await page.evaluate(([pts, D]) => {
      const o = { lat: pts[0].lat, lng: pts[0].lng };
      const s = pts.slice(1).map(p => ({ lat: p.lat, lng: p.lng }));
      const straight = window.__CJ__.solveBestOrder(o, s, true);
      const road = window.__CJ__.solveBestOrder(o, s, true, D);
      return {
        sOrder: straight.order.join(','), sTotal: straight.total,
        rOrder: road.order.join(','), rTotal: road.total
      };
    }, [PTS, roadMatrixKm(3)]);
    ok('두 기준의 추천 순서가 실제로 다름', cmp.sOrder !== cmp.rOrder,
      `직선 [${cmp.sOrder}] vs 도로 [${cmp.rOrder}]`);
    console.log(`        직선거리 최단: ${cmp.sOrder} (${cmp.sTotal.toFixed(2)} km)`);
    console.log(`        도로거리 최단: ${cmp.rOrder} (${cmp.rTotal.toFixed(2)} km)`);

    // 직선 최단 순서를 도로거리로 재면 도로 최단보다 길어야 한다
    const worse = await page.evaluate(([D, order]) => {
      let prev = 0, sum = 0;
      for (const k of order) { sum += D[prev][k + 1]; prev = k + 1; }
      sum += D[prev][0];
      return sum;
    }, [roadMatrixKm(3), cmp.sOrder.split(',').map(Number)]);
    ok('직선 기준 순서를 도로거리로 재면 더 길다', worse > cmp.rTotal + 1e-9,
      `${worse.toFixed(2)} km > ${cmp.rTotal.toFixed(2)} km`);
  }

  /* ---------------- 7. 화면 끝까지 ---------------- */
  section('7. 화면에서 도로거리 모드로 끝까지 계산');
  {
    await page.waitForFunction(() => window.__CJ__.state.server.checked === true);
    ok('서버가 있으면 도로거리 모드가 기본값',
      await page.evaluate(() => window.__CJ__.state.calcMode === 'road'));
    ok('계산 기준 버튼이 도로거리로 눌려 있음',
      (await page.getAttribute('#modeRoad', 'aria-pressed')) === 'true');

    // 좌표 직접 입력으로 지점을 넣는다 (장소 검색은 이 테스트의 관심사가 아님)
    await page.evaluate(pts => {
      const st = window.__CJ__.state;
      st.origin = { name: pts[0].name, address: '', lat: pts[0].lat, lng: pts[0].lng, source: '테스트' };
      st.stops = pts.slice(1).map(p => ({ name: p.name, address: '', lat: p.lat, lng: p.lng, source: '테스트' }));
    }, PTS);

    await page.click('#btnSolve');
    await page.waitForSelector('#cardResult:not(.hidden)', { timeout: 15000 });
    const r = await page.evaluate(() => {
      const res = window.__CJ__.state.result;
      return {
        mode: res.mode, total: res.total, totalDuration: res.totalDuration,
        legs: res.legs.length, legDurations: res.legDurations,
        names: res.seq.map(p => p.name),
        heroLabel: document.querySelector('#resultTotalLabel').textContent,
        hero: document.querySelector('#resultTotal').textContent,
        meta: document.querySelector('#resultMeta').textContent,
        chip: document.querySelector('#resultModeChip').textContent,
        durNote: document.querySelector('#resultDurNote').textContent,
        caveat: document.querySelector('#resultCaveat').textContent,
        heads: [...document.querySelectorAll('#resultTable th')].map(t => t.textContent)
      };
    });
    ok('결과가 도로거리 모드로 표시됨', r.mode === 'road');
    ok('총거리 제목이 “총 주행거리”', r.heroLabel === '총 주행거리', r.heroLabel);
    ok('계산 기준 칩이 표시됨', r.chip.includes('자동차 도로거리 최단'), r.chip);
    ok('예상 운전시간이 표시됨', r.meta.includes('예상 운전시간'), r.meta);
    ok('체류시간 제외 안내가 있음', r.durNote.includes('체류시간은 포함하지 않습니다'), r.durNote);
    ok('교통상황 미반영 안내가 있음', r.caveat.includes('실시간 교통상황은 반영하지 않습니다'), r.caveat);
    ok('구간 표에 소요시간 열이 생김', r.heads.includes('소요시간'), r.heads.join('/'));
    ok('구간별 소요시간이 모두 채워짐',
      r.legDurations.length === r.legs && r.legDurations.every(d => typeof d === 'number'));
    ok('총 소요시간이 구간 합계와 일치',
      Math.abs(r.totalDuration - r.legDurations.reduce((a, b) => a + b, 0)) < 1e-9);

    const want = heldKarpAsym(roadMatrixKm(3), 3, true);
    ok('화면이 만든 도로거리 총합이 독립 DP 최솟값과 일치',
      Math.abs(r.total - want) < 1e-6, `${r.total.toFixed(6)} vs ${want.toFixed(6)}`);

    // 복사 본문
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.click('#btnCopy');
    await page.waitForFunction(() => document.querySelector('#toastHost').textContent.includes('복사'));
    const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
    ok('복사 본문에 계산 기준이 들어감', clip.includes('계산 기준: 자동차 도로거리 최단'));
    ok('복사 본문에 총 주행거리가 들어감', clip.includes('총 주행거리:'));
    ok('복사 본문에 예상 운전시간과 체류시간 제외가 들어감',
      clip.includes('예상 운전시간:') && clip.includes('체류시간 제외'));
    ok('복사 본문에 구간별 소요시간이 들어감', /직전 구간 .+ \/ .+분/.test(clip));
    ok('복사 본문에 교통상황 미반영 안내가 들어감', clip.includes('실시간 교통상황'));

    // 인쇄에도 결과가 남는지
    await page.emulateMedia({ media: 'print' });
    ok('인쇄 시 결과가 보이고 입력은 숨겨짐', await page.evaluate(() =>
      getComputedStyle(document.querySelector('#cardResult')).display !== 'none' &&
      getComputedStyle(document.querySelector('#btnSolve').closest('section')).display === 'none'));
    await page.emulateMedia({ media: 'screen' });
  }

  /* ---------------- 8. 직선거리 모드로 전환 ---------------- */
  section('8. 같은 지점을 직선거리 모드로 다시 계산');
  {
    await page.click('#modeStraight');
    ok('모드를 바꾸면 이전 결과를 버림',
      await page.evaluate(() => document.querySelector('#cardResult').classList.contains('hidden')));
    await page.click('#btnSolve');
    await page.waitForSelector('#cardResult:not(.hidden)');
    const r = await page.evaluate(() => ({
      mode: window.__CJ__.state.result.mode,
      dur: window.__CJ__.state.result.totalDuration,
      label: document.querySelector('#resultTotalLabel').textContent,
      heads: [...document.querySelectorAll('#resultTable th')].map(t => t.textContent),
      caveat: document.querySelector('#resultCaveat').textContent
    }));
    ok('직선거리 모드로 계산됨', r.mode === 'straight');
    ok('총거리 제목이 “총 직선거리”로 돌아옴', r.label === '총 직선거리', r.label);
    ok('직선거리 모드에는 소요시간 열이 없음', !r.heads.includes('소요시간'), r.heads.join('/'));
    ok('직선거리 모드는 소요시간을 계산하지 않음', r.dur === null);
    ok('직선거리 주의 문구로 돌아옴', r.caveat.includes('실제 자동차 최단경로와 다를 수 있습니다'));
  }

  /* ---------------- 9. 출장지 8곳 ---------------- */
  section('9. 출장지 8곳 (지점 9개 = 방향 구간 72개)');
  {
    // 9개 지점을 쓰기 위해 모의 거리표를 넓힌다 — 상위 서버가 아니라 거리표만 바꿔 계산 검증
    const N = 8;
    const D = Array.from({ length: N + 1 }, (_, i) =>
      Array.from({ length: N + 1 }, (_, j) => i === j ? 0 : ((i * 7 + j * 13) % 23) + 1 + (i > j ? 0.5 : 0)));
    const got = await page.evaluate(([D, N]) => {
      const o = { lat: 0, lng: 0 };
      const s = Array.from({ length: N }, () => ({ lat: 0, lng: 0 }));
      const r = window.__CJ__.solveBestOrder(o, s, true, D);
      return { total: r.total, evaluated: r.evaluated, order: r.order, legs: r.legs.length };
    }, [D, N]);
    ok('8곳에서 8! = 40,320가지를 모두 비교', got.evaluated === 40320, String(got.evaluated));
    ok('8곳 비대칭 최솟값이 독립 DP와 일치',
      Math.abs(got.total - heldKarpAsym(D, N, true)) < 1e-9,
      `${got.total.toFixed(6)} vs ${heldKarpAsym(D, N, true).toFixed(6)}`);
    ok('8곳 모두 정확히 한 번씩', new Set(got.order).size === 8 && got.legs === 9);
    ok('서버 상한이 9지점이라 8곳까지 조회 가능',
      await page.evaluate(() => window.__CJ__.state.server.maxPoints >= 9));
  }

  /* ---------------- 10. 구간 조회 실패 ---------------- */
  section('10. 구간 경로 없음 — 직선거리로 메우지 않음');
  {
    upstreamMode = 'missing-pair';
    await page.click('#modeRoad');
    await page.click('#btnSolve');
    await page.waitForFunction(() =>
      document.querySelector('#solveMsg').textContent.includes('찾지 못했습니다'),
      null, { timeout: 15000 });
    const t = await page.textContent('#solveMsg');
    ok('경로 없는 구간을 한국어로 안내', t.includes('도로 경로를 찾지 못했습니다'), t.slice(0, 80));
    ok('어느 구간인지 알려 줌', t.includes('강북 A → 강남 B'), t.replace(/\s+/g, ' ').slice(0, 160));
    ok('직선거리로 메우지 않았다고 밝힘', t.includes('직선거리로 메우면'));
    ok('결과를 만들지 않음',
      await page.evaluate(() => document.querySelector('#cardResult').classList.contains('hidden')));
    ok('직선거리로 다시 계산하는 버튼을 제공',
      (await page.locator('#solveMsg button').count()) === 1);

    // 그 버튼으로 바로 빠져나갈 수 있어야 한다
    await page.click('#solveMsg button');
    await page.waitForSelector('#cardResult:not(.hidden)');
    ok('버튼을 누르면 직선거리로 계산됨',
      await page.evaluate(() => window.__CJ__.state.result.mode === 'straight'));
    upstreamMode = 'ok';
  }

  /* ---------------- 11. 키 오류 · 한도 초과 · 타임아웃 ---------------- */
  section('11. 키 오류 / 한도 초과 / 타임아웃을 구분해 안내');
  {
    const cases = [
      ['key-invalid', '카카오 REST API 키가 거부되었습니다'],
      ['quota',       '호출 한도를 넘었습니다'],
      ['timeout',     '제때 오지 않았습니다']
    ];
    for (const [mode, want] of cases) {
      upstreamMode = mode;
      await page.click('#modeRoad');
      await page.click('#btnSolve');
      await page.waitForFunction(
        w => document.querySelector('#solveMsg').textContent.includes(w),
        want, { timeout: 20000 }).catch(() => {});
      const t = await page.textContent('#solveMsg');
      ok(`${mode} 를 구분해 안내`, t.includes(want), t.replace(/\s+/g, ' ').slice(0, 110));
      ok(`${mode} 일 때 결과를 만들지 않음`,
        await page.evaluate(() => document.querySelector('#cardResult').classList.contains('hidden')));
      ok(`${mode} 안내에 영어 개발자 메시지가 없음`, !/Error|undefined|NaN|\[object/.test(t));
    }
    upstreamMode = 'ok';
  }

  /* ---------------- 12. 서버 없이도 동작 ---------------- */
  section('12. 서버 없는 정적 배포본 — 직선거리 모드로 동작');
  {
    const c2 = await browser.newContext();
    const p2 = await c2.newPage();
    await p2.goto('file://' + path.join(ROOT, '출장방문순서추천.html'));
    await p2.waitForFunction(() => !!window.__CJ__);
    await p2.waitForFunction(() => window.__CJ__.state.server.checked === true, null, { timeout: 15000 });
    ok('서버가 없으면 도로거리 모드가 꺼짐',
      await p2.evaluate(() => window.__CJ__.state.server.road === false));
    ok('도로거리 버튼이 비활성화됨', await p2.isDisabled('#modeRoad'));
    ok('기본 계산 기준이 직선거리',
      await p2.evaluate(() => window.__CJ__.state.calcMode === 'straight'));
    ok('이유를 한국어로 안내',
      (await p2.textContent('#modeHint')).includes('길찾기 서버가 연결되지 않아'));

    await p2.evaluate(pts => {
      const st = window.__CJ__.state;
      st.origin = { name: pts[0].name, address: '', lat: pts[0].lat, lng: pts[0].lng, source: '테스트' };
      st.stops = pts.slice(1).map(p => ({ name: p.name, address: '', lat: p.lat, lng: p.lng, source: '테스트' }));
    }, PTS);
    await p2.click('#btnSolve');
    await p2.waitForSelector('#cardResult:not(.hidden)');
    ok('서버 없이 직선거리 계산이 끝까지 동작',
      await p2.evaluate(() => window.__CJ__.state.result.mode === 'straight' &&
        window.__CJ__.state.result.legs.length === 4));
    await c2.close();
  }

  /* ---------------- 13. 키가 없는 서버 ---------------- */
  section('13. REST 키 없이 서버만 띄운 경우');
  {
    app.kill(); await new Promise(r => setTimeout(r, 300));
    app = startApp({ KAKAO_REST_API_KEY: '' });
    await waitUp(BASE + '/api/health');
    const h = await (await fetch(BASE + '/api/health')).json();
    ok('health 가 도로거리 불가를 보고', h.road === false);
    const r = await fetch(BASE + '/api/matrix', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ points: PTS.map(p => ({ lat: p.lat, lng: p.lng })) })
    });
    const j = await r.json();
    ok('거리표 요청을 503 과 NO_KEY 로 거절', r.status === 503 && j.code === 'NO_KEY', `${r.status} ${j.code}`);
    ok('거절 사유를 한국어로 설명', (j.error || '').includes('REST API 키'));
  }

  await ctx.close();

} finally {
  await browser.close();
  app.kill();
  upstream.close();
}

console.log('\n────────────────────────────────────────');
console.log(`통과 ${pass}건 / 실패 ${fail}건`);
if (fail) { console.log('\n실패 목록:'); failures.forEach(f => console.log(' - ' + f)); }
console.log('\n주의: 가짜 상위 서버(모의 거리표) 기준입니다.');
console.log('실제 카카오모빌리티 API 는 이 스크립트에서 호출하지 않습니다.');
process.exit(fail ? 1 : 0);
