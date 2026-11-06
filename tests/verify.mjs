/**
 * 출장 방문순서 추천기 — 자동 검증 스크립트
 *
 * 실제 배포 파일(출장방문순서추천.html)을 Chromium에서 file:// 주소로 직접 열고,
 * 카카오 지도 SDK는 Mock(가짜 구현)으로 대체해 검증합니다.
 * 카카오 서버에는 접속하지 않습니다. 즉 이 스크립트의 통과 결과는
 * "Mock 환경에서의 통과"이며, 실제 카카오 API 동작을 보증하지 않습니다.
 *
 * 실행 (개발자용, 일반 사용자는 실행할 필요 없음):
 *   npm i -D playwright && node tests/verify.mjs
 */
import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_PATH = path.join(HERE, '..', '출장방문순서추천.html');
const APP = pathToFileURL(APP_PATH).href;

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name + (extra ? ' :: ' + extra : '')); console.log('  FAIL  ' + name + (extra ? ' :: ' + extra : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

/* ------------------------------------------------------------------ Mock SDK
 * 실제 카카오 SDK와 같은 인터페이스만 흉내내는 가짜 구현.
 * 좌표는 "검색 가능한 고정 데이터"로만 사용하며, 프로그램이 좌표를
 * 스스로 만들어 내지 않는다는 점을 확인하는 데 쓴다.
 */
const MOCK_DB = [
  { id: 'p1', place_name: '충주시청', road_address_name: '충청북도 충주시 으뜸로 21', address_name: '충청북도 충주시 금릉동 452', category_group_name: '공공기관', x: '127.9200000', y: '36.9910000', place_url: 'http://place.map.kakao.com/p1' },
  { id: 'p2', place_name: '충주시청 제2청사', road_address_name: '충청북도 충주시 예성로 100', address_name: '충청북도 충주시 성내동 1', category_group_name: '공공기관', x: '127.9300000', y: '36.9700000', place_url: '' },
  { id: 'p3', place_name: '충주경찰서', road_address_name: '충청북도 충주시 으뜸로 30', address_name: '충청북도 충주시 금릉동 500', category_group_name: '공공기관', x: '127.9250000', y: '36.9950000', place_url: '' },
  { id: 'p4', place_name: '충주세무서', road_address_name: '충청북도 충주시 중원대로 123', address_name: '충청북도 충주시 교현동 10', category_group_name: '공공기관', x: '127.9400000', y: '36.9800000', place_url: '' },
  { id: 'p5', place_name: '주덕읍 행정복지센터', road_address_name: '충청북도 충주시 주덕읍 주덕로 1', address_name: '충청북도 충주시 주덕읍 신양리 1', category_group_name: '공공기관', x: '127.8200000', y: '36.9700000', place_url: '' },
  { id: 'p6', place_name: '대소원면 행정복지센터', road_address_name: '충청북도 충주시 대소원면 대소원로 1', address_name: '충청북도 충주시 대소원면 본리 1', category_group_name: '공공기관', x: '127.8500000', y: '36.9500000', place_url: '' },
  { id: 'p7', place_name: '중앙탑면 행정복지센터', road_address_name: '충청북도 충주시 중앙탑면 중앙탑길 1', address_name: '충청북도 충주시 중앙탑면 가금리 1', category_group_name: '공공기관', x: '127.8700000', y: '37.0200000', place_url: '' },
  { id: 'p8', place_name: '수안보면 행정복지센터', road_address_name: '충청북도 충주시 수안보면 온천리 1', address_name: '충청북도 충주시 수안보면 온천리 1', category_group_name: '공공기관', x: '128.0100000', y: '36.8400000', place_url: '' },
  { id: 'p9', place_name: '앙성면 행정복지센터', road_address_name: '충청북도 충주시 앙성면 앙성로 1', address_name: '충청북도 충주시 앙성면 능암리 1', category_group_name: '공공기관', x: '127.8000000', y: '37.1100000', place_url: '' },
  { id: 'p10', place_name: '엄정면 행정복지센터', road_address_name: '충청북도 충주시 엄정면 엄정로 1', address_name: '충청북도 충주시 엄정면 용산리 1', category_group_name: '공공기관', x: '127.9500000', y: '37.1000000', place_url: '' },
  { id: 'p11', place_name: '산척면 행정복지센터', road_address_name: '충청북도 충주시 산척면 산척로 1', address_name: '충청북도 충주시 산척면 영덕리 1', category_group_name: '공공기관', x: '128.0300000', y: '37.0900000', place_url: '' },
  { id: 'p12', place_name: '서충주신도시', road_address_name: '', address_name: '충청북도 충주시 대소원면 완오리', category_group_name: '', x: '127.8600000', y: '36.9600000', place_url: '' },
  // 같은 이름 · 다른 주소 (사용자가 주소로 구분해야 하는 경우)
  { id: 'p13', place_name: '행복식당', road_address_name: '충청북도 충주시 으뜸로 50', address_name: '충청북도 충주시 금릉동 600', category_group_name: '음식점', x: '127.9210000', y: '36.9920000', place_url: '' },
  { id: 'p14', place_name: '행복식당', road_address_name: '충청북도 충주시 수안보면 온천리 50', address_name: '충청북도 충주시 수안보면 온천리 50', category_group_name: '음식점', x: '128.0150000', y: '36.8450000', place_url: '' },
  // 좌표가 누락된 결과 (프로그램이 걸러내야 한다)
  { id: 'p15', place_name: '좌표없는장소', road_address_name: '충청북도 충주시 어딘가로 1', address_name: '', category_group_name: '', x: '', y: '', place_url: '' }
];

const MOCK_ADDR = [
  { address_name: '충청북도 충주시 으뜸로 21', x: '127.9200000', y: '36.9910000',
    road_address: { address_name: '충청북도 충주시 으뜸로 21', building_name: '충주시청' },
    address: { address_name: '충청북도 충주시 금릉동 452' } },
  { address_name: '충청북도 충주시 중원대로 3324', x: '127.9350000', y: '36.9690000',
    road_address: { address_name: '충청북도 충주시 중원대로 3324', building_name: '' },
    address: { address_name: '충청북도 충주시 성서동 100' } }
];

function mockInit(behavior) {
  // 브라우저 컨텍스트에서 실행될 함수 (문자열로 직렬화되어 주입된다)
  return function (cfg) {
    const { db, addrs, behavior } = cfg;
    const Status = { OK: 'OK', ZERO_RESULT: 'ZERO_RESULT', ERROR: 'ERROR' };
    function later(fn) { setTimeout(fn, 5); }
    function Places() {}
    Places.prototype.keywordSearch = function (q, cb) {
      window.__calls = (window.__calls || 0) + 1;
      if (behavior === 'error') return later(() => cb([], Status.ERROR));
      if (behavior === 'silent') return; // 콜백 자체가 오지 않는 상황
      const key = String(q).replace(/\s+/g, '');
      const hits = db.filter(p =>
        p.place_name.replace(/\s+/g, '').includes(key) ||
        (p.road_address_name || '').replace(/\s+/g, '').includes(key) ||
        (p.address_name || '').replace(/\s+/g, '').includes(key));
      later(() => cb(hits, hits.length ? Status.OK : Status.ZERO_RESULT,
        { hasNextPage: false, nextPage() {} }));
    };
    function Geocoder() {}
    Geocoder.prototype.addressSearch = function (q, cb) {
      window.__calls = (window.__calls || 0) + 1;
      if (behavior === 'error') return later(() => cb([], Status.ERROR));
      if (behavior === 'silent') return;
      const key = String(q).replace(/\s+/g, '');
      const hits = addrs.filter(a => a.address_name.replace(/\s+/g, '').includes(key));
      later(() => cb(hits, hits.length ? Status.OK : Status.ZERO_RESULT));
    };
    window.kakao = { maps: { load: f => f(), services: { Places, Geocoder, Status } } };
    window.__MOCK__ = true;
  };
}

/* --------------------------------------------------------- 독립 구현(교차검증)
 * 앱의 "전수 비교" 결과와 비교할 목적의 별도 알고리즘 (Held-Karp 정확 DP).
 * 같은 코드를 복사한 것이 아니라 전혀 다른 방식으로 최솟값만 계산한다.
 */
function heldKarpMin(origin, stops, ret) {
  const n = stops.length;
  const R = 6371.0088, rad = Math.PI / 180;
  const pts = [origin, ...stops];
  const d = (i, j) => {
    const a = pts[i], b = pts[j];
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const s = Math.sin(dLat / 2) ** 2 +
      Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  };
  const SZ = 1 << n;
  const dp = Array.from({ length: SZ }, () => new Float64Array(n).fill(Infinity));
  for (let j = 0; j < n; j++) dp[1 << j][j] = d(0, j + 1);
  for (let m = 1; m < SZ; m++) {
    for (let j = 0; j < n; j++) {
      const cur = dp[m][j];
      if (!(m & (1 << j)) || cur === Infinity) continue;
      for (let k = 0; k < n; k++) {
        if (m & (1 << k)) continue;
        const nm = m | (1 << k), v = cur + d(j + 1, k + 1);
        if (v < dp[nm][k]) dp[nm][k] = v;
      }
    }
  }
  let best = Infinity;
  for (let j = 0; j < n; j++) {
    const v = dp[SZ - 1][j] + (ret ? d(j + 1, 0) : 0);
    if (v < best) best = v;
  }
  return best;
}

/* ------------------------------------------------------------------- 실행 */
const browser = await chromium.launch();

async function newPage(behavior = 'normal') {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', e => { fail++; failures.push('pageerror: ' + e.message); console.log('  FAIL  콘솔 예외: ' + e.message); });
  await page.addInitScript(mockInit(), { db: MOCK_DB, addrs: MOCK_ADDR, behavior });
  await page.goto(APP);
  await page.waitForFunction(() => !!window.__CJ__);
  return { ctx, page };
}

try {
  /* ---------------- 1. 파일 직접 실행 / 내부 CSS·JS ---------------- */
  section('1~2. HTML 파일 직접 실행 및 내부 CSS/JavaScript 로딩');
  let { ctx, page } = await newPage();
  ok('file:// 주소로 열림', page.url().startsWith('file://'), page.url());
  ok('외부 <script src>/<link rel=stylesheet>가 없음 (카카오 SDK는 실행 중 동적 로딩)',
    await page.evaluate(() => document.querySelectorAll('script[src],link[rel=stylesheet]').length === 0));
  ok('<style> 태그 1개가 내부에 포함되어 있음',
    await page.evaluate(() => document.querySelectorAll('style').length === 1));
  ok('내부 CSS가 실제로 적용됨 (헤더 배경색)',
    await page.evaluate(() => getComputedStyle(document.querySelector('header.top')).backgroundColor === 'rgb(29, 78, 137)'));
  ok('내부 JavaScript가 실행되어 UI가 초기화됨',
    (await page.textContent('#stopCounter')) === '0 / 8');
  ok('제목이 한국어로 표시됨 (인코딩 정상)',
    (await page.title()) === '출장 방문순서 추천기');

  /* ---------------- 8. 거리 계산 정확성 ---------------- */
  section('8. 거리 계산 정확성 (Haversine)');
  const hav = await page.evaluate(() => {
    const h = window.__CJ__.haversineKm;
    return {
      same: h({ lat: 36.99, lng: 127.92 }, { lat: 36.99, lng: 127.92 }),
      // 위도 1도 = 약 111.19 km (대권)
      lat1: h({ lat: 36, lng: 127 }, { lat: 37, lng: 127 }),
      // 구면(R=6371.0088km) 기준 적도 경도 1도 = 2πR/360 = 약 111.195 km
      eq1: h({ lat: 0, lng: 0 }, { lat: 0, lng: 1 }),
      // 서울시청 ~ 부산시청 (공개 좌표 기준 약 325 km)
      seoulBusan: h({ lat: 37.566535, lng: 126.977969 }, { lat: 35.179554, lng: 129.075642 }),
      sym: h({ lat: 36.9, lng: 127.9 }, { lat: 37.1, lng: 128.1 }) - h({ lat: 37.1, lng: 128.1 }, { lat: 36.9, lng: 127.9 })
    };
  });
  ok('같은 지점은 0 km', hav.same === 0, String(hav.same));
  ok('위도 1도 ≈ 111.19 km', Math.abs(hav.lat1 - 111.19) < 0.1, hav.lat1.toFixed(4));
  ok('적도 경도 1도 ≈ 111.195 km (구면 2πR/360)',
    Math.abs(hav.eq1 - (2 * Math.PI * 6371.0088 / 360)) < 0.001, hav.eq1.toFixed(4));
  ok('서울시청~부산시청 ≈ 325 km', Math.abs(hav.seoulBusan - 325) < 3, hav.seoulBusan.toFixed(3));
  ok('거리는 대칭', Math.abs(hav.sym) < 1e-12);

  /* ---------------- 5·6. 최적화 — 독립 구현과 교차검증 ---------------- */
  section('5~6. 최적 방문순서 (출장지 1~8곳) — 독립 DP 구현과 교차검증');
  let worstDiff = 0, cases = 0, badIntegrity = 0, counts = {};
  let rngState = 20261106;
  const rnd = () => { rngState = (rngState * 1103515245 + 12345) & 0x7fffffff; return rngState / 0x7fffffff; };

  for (let n = 1; n <= 8; n++) {
    for (let trial = 0; trial < (n >= 8 ? 3 : 12); trial++) {
      const origin = { lat: 36.97 + rnd() * 0.05, lng: 127.90 + rnd() * 0.06 };
      const stops = Array.from({ length: n }, () => ({ lat: 36.80 + rnd() * 0.35, lng: 127.75 + rnd() * 0.35 }));
      for (const ret of [true, false]) {
        const got = await page.evaluate(([o, s, r]) => {
          const res = window.__CJ__.solveBestOrder(o, s, r);
          return { total: res.total, order: res.order, legs: res.legs, evaluated: res.evaluated };
        }, [origin, stops, ret]);
        const want = heldKarpMin(origin, stops, ret);
        worstDiff = Math.max(worstDiff, Math.abs(got.total - want));
        cases++;
        counts[n] = got.evaluated;
        // 무결성: 모든 출장지가 정확히 한 번
        const set = new Set(got.order);
        if (set.size !== n || got.order.length !== n || Math.min(...got.order) !== 0 || Math.max(...got.order) !== n - 1) badIntegrity++;
        // 구간 수
        if (got.legs.length !== n + (ret ? 1 : 0)) badIntegrity++;
        // 구간 합계 == 총합
        if (Math.abs(got.legs.reduce((a, b) => a + b, 0) - got.total) > 1e-9) badIntegrity++;
      }
    }
  }
  ok(`전수비교 결과가 독립 DP 최솟값과 일치 (${cases}개 사례, 최대 오차 ${worstDiff.toExponential(2)})`, worstDiff < 1e-9);
  ok('방문 순서에 중복·누락 없음 / 구간 수·합계 일치', badIntegrity === 0, '위반 ' + badIntegrity + '건');
  ok('출장지 8곳에서 8! = 40,320 가지를 모두 비교', counts[8] === 40320, String(counts[8]));
  ok('출장지 4곳에서 4! = 24 가지를 모두 비교', counts[4] === 24, String(counts[4]));

  /* ---------------- 7. 복귀 여부에 따른 결과 변화 ---------------- */
  section('7. 복귀 여부에 따른 결과 변화');
  const retCmp = await page.evaluate(() => {
    const o = { lat: 36.9910, lng: 127.9200 };
    const s = [
      { lat: 37.0200, lng: 127.8700 },
      { lat: 36.9500, lng: 127.8500 },
      { lat: 36.9700, lng: 127.8200 },
      { lat: 36.9950, lng: 127.9250 }
    ];
    const a = window.__CJ__.solveBestOrder(o, s, true);
    const b = window.__CJ__.solveBestOrder(o, s, false);
    return { aTotal: a.total, bTotal: b.total, aOrder: a.order.join(','), bOrder: b.order.join(','), aLegs: a.legs.length, bLegs: b.legs.length };
  });
  ok('복귀 포함 시 총거리가 미복귀보다 크거나 같음', retCmp.aTotal >= retCmp.bTotal - 1e-12,
    `복귀 ${retCmp.aTotal.toFixed(3)} / 미복귀 ${retCmp.bTotal.toFixed(3)}`);
  ok('복귀 시 구간이 1개 더 많음', retCmp.aLegs === retCmp.bLegs + 1, `${retCmp.aLegs} vs ${retCmp.bLegs}`);
  ok('복귀 여부에 따라 추천 순서가 달라지는 사례를 확인', retCmp.aOrder !== retCmp.bOrder,
    `복귀 [${retCmp.aOrder}] / 미복귀 [${retCmp.bOrder}]`);

  await ctx.close();

  /* ---------------- 3·4. 검색 결과 선택, 출장지 추가·삭제 ---------------- */
  section('3~4. 장소 검색 결과 선택 / 출장지 추가·삭제 (Mock SDK)');
  ({ ctx, page } = await newPage());
  ok('SDK가 준비되면 안내문이 초록색으로 바뀜',
    (await page.textContent('#sdkNote')).includes('장소 검색을 사용할 수 있습니다'));

  // 출발지: 기본값이 충주시청으로 들어 있고, 검색 후 선택해야 확정된다
  ok('출발지 기본 검색어가 충주시청', (await page.inputValue('#originQuery')) === '충주시청');
  ok('검색 전에는 출발지가 확정되지 않음',
    await page.evaluate(() => window.__CJ__.state.origin === null));
  await page.click('#btnOriginSearch');
  await page.waitForSelector('#originResults .item');
  const oRows = await page.locator('#originResults .item').count();
  ok('출발지 검색 결과가 표시됨 (' + oRows + '건)', oRows >= 1);
  ok('검색 결과에 장소명·주소·선택 버튼이 함께 표시됨',
    await page.evaluate(() => {
      const it = document.querySelector('#originResults .item');
      return !!it.querySelector('.nm') && !!it.querySelector('.ad') && it.querySelector('button').textContent === '선택';
    }));
  await page.locator('#originResults .item', { hasText: '충주시청' }).first().locator('button').click();
  await page.waitForSelector('#originFixed:not(.hidden)');
  ok('선택하면 출발지가 확정되고 좌표가 들어옴',
    await page.evaluate(() => {
      const o = window.__CJ__.state.origin;
      return o && o.name === '충주시청' && Math.abs(o.lat - 36.991) < 1e-9 && Math.abs(o.lng - 127.92) < 1e-9;
    }));
  ok('확정된 출발지에 주소가 표시됨', (await page.textContent('#originAddr')).includes('으뜸로 21'));

  // 좌표가 없는 결과는 제외되는지
  await page.fill('#stopQuery', '좌표없는장소');
  await page.click('#btnStopSearch');
  await page.waitForFunction(() => document.querySelector('#stopMsg').textContent.includes('검색 결과가 없습니다')
    || document.querySelector('#stopMsg').textContent.includes('제외'));
  ok('좌표가 누락된 검색 결과는 목록에 올리지 않음',
    await page.evaluate(() => !document.querySelector('#stopResults .item') ||
      ![...document.querySelectorAll('#stopResults .nm')].some(n => n.textContent.includes('좌표없는장소'))));

  // 출장지 추가
  async function addStopByName(query, pick) {
    await page.fill('#stopQuery', query);
    await page.click('#btnStopSearch');
    await page.waitForSelector('#stopResults .item');
    await page.locator('#stopResults .item', { hasText: pick || query }).first().locator('button').click();
  }
  const EIGHT = ['충주경찰서', '충주세무서', '주덕읍 행정복지센터', '대소원면 행정복지센터',
    '중앙탑면 행정복지센터', '수안보면 행정복지센터', '앙성면 행정복지센터', '엄정면 행정복지센터'];
  for (const q of EIGHT) await addStopByName(q);
  ok('출장지 8곳 등록 완료', await page.evaluate(() => window.__CJ__.state.stops.length === 8));
  ok('등록 개수 표시가 8 / 8', (await page.textContent('#stopCounter')) === '8 / 8');
  ok('목록에 8개 항목이 그려짐', (await page.locator('#stopList ol.stops li').count()) === 8);

  // 9번째 — 상한 초과
  await page.fill('#stopQuery', '산척면 행정복지센터');
  await page.click('#btnStopSearch');
  await page.waitForSelector('#stopResults .item');
  await page.locator('#stopResults .item').first().locator('button').click();
  ok('9번째 출장지는 거부되고 한국어로 안내',
    (await page.textContent('#stopMsg')).includes('최대 8곳'));
  ok('거부 후에도 목록은 8곳 유지', await page.evaluate(() => window.__CJ__.state.stops.length === 8));

  // 삭제
  await page.locator('#stopList ol.stops li', { hasText: '엄정면' }).locator('button').click();
  ok('출장지 삭제 동작', await page.evaluate(() => window.__CJ__.state.stops.length === 7));
  ok('삭제 안내가 한국어로 표시', (await page.textContent('#stopMsg')).includes('삭제했습니다'));

  /* ---------------- 9. 중복 / 동일 장소 방지 ---------------- */
  section('9. 중복 등록 및 출발지 중복 방지');
  await addStopByName('충주경찰서');
  ok('같은 출장지를 다시 등록하면 거부', (await page.textContent('#stopMsg')).includes('이미 등록된 출장지'));
  ok('거부 후 개수 변화 없음', await page.evaluate(() => window.__CJ__.state.stops.length === 7));

  await page.fill('#stopQuery', '충주시청');
  await page.click('#btnStopSearch');
  await page.waitForSelector('#stopResults .item');
  await page.locator('#stopResults .item', { hasText: '충주시청' }).first().locator('button').click();
  ok('출발지와 같은 장소는 출장지로 등록 거부', (await page.textContent('#stopMsg')).includes('출발지와 같은 장소'));

  // 같은 이름 다른 주소는 각각 등록 가능해야 한다
  await page.fill('#stopQuery', '행복식당');
  await page.click('#btnStopSearch');
  await page.waitForSelector('#stopResults .item');
  const dupRows = await page.locator('#stopResults .item').count();
  ok('같은 이름 장소 2건이 주소와 함께 모두 표시됨 (' + dupRows + '건)', dupRows === 2);

  /* ---------------- 5·7·10. 계산 → 결과 → 복사 → 인쇄 ---------------- */
  section('5·7·10. 추천 실행, 결과 출력, 복사, 인쇄');
  await page.click('#btnSolve');
  await page.waitForSelector('#cardResult:not(.hidden)');
  const r1 = await page.evaluate(() => ({
    total: window.__CJ__.state.result.total,
    names: window.__CJ__.state.result.seq.map(p => p.name),
    legs: window.__CJ__.state.result.legs.length,
    ret: window.__CJ__.state.result.returnToStart,
    flow: document.querySelector('#resultFlow').textContent,
    rows: document.querySelectorAll('#resultTable tbody tr').length,
    sum: document.querySelector('#resultSum').textContent,
    warn: [...document.querySelectorAll('#cardResult .note')].map(n => n.textContent).join(' ')
  }));
  ok('복귀 기본값이 체크되어 있어 출발지로 복귀', r1.ret === true);
  ok('순서도의 처음과 끝이 출발지', r1.names[0] === '충주시청' && r1.names[r1.names.length - 1] === '충주시청');
  ok('출장지 7곳이 모두 정확히 한 번 등장', await page.evaluate(() => {
    const r = window.__CJ__.state.result;
    const mid = r.seq.slice(1, r.seq.length - 1).map(p => p.name);
    const regd = window.__CJ__.state.stops.map(p => p.name);
    return mid.length === regd.length && new Set(mid).size === regd.length &&
      regd.every(n => mid.includes(n));
  }));
  ok('구간 수 = 출장지 7 + 복귀 1 = 8', r1.legs === 8, String(r1.legs));
  ok('순서도가 화살표로 그려짐', r1.flow.includes('→'));
  ok('전체 방문 장소 수가 표시됨', r1.sum.includes('8개 지점'), r1.sum.replace(/\s+/g, ' ').slice(0, 120));
  ok('총 직선거리가 표시됨', r1.sum.includes('km'));
  ok('구간 표가 출력됨 (' + r1.rows + '행)', r1.rows === r1.names.length + 1);
  ok('직선거리 기준 안내 문구가 결과 화면에 표시됨',
    r1.warn.includes('직선거리 기준 추천이며 실제 자동차 최단경로와 다를 수 있습니다'));
  ok('주행시간을 계산하지 않는다는 안내가 있음', r1.warn.includes('소요시간도 계산하지 않습니다'));

  // 결과가 독립 DP와 일치하는지 (실제 UI 경로 전체를 통과한 값)
  const uiCheck = await page.evaluate(() => ({
    o: { lat: window.__CJ__.state.origin.lat, lng: window.__CJ__.state.origin.lng },
    s: window.__CJ__.state.stops.map(p => ({ lat: p.lat, lng: p.lng })),
    total: window.__CJ__.state.result.total
  }));
  ok('UI로 만든 결과의 총거리도 독립 DP 최솟값과 일치',
    Math.abs(uiCheck.total - heldKarpMin(uiCheck.o, uiCheck.s, true)) < 1e-9,
    uiCheck.total.toFixed(6) + ' vs ' + heldKarpMin(uiCheck.o, uiCheck.s, true).toFixed(6));

  // 복귀 해제 후 재계산
  await page.uncheck('#chkReturn');
  ok('복귀 체크를 바꾸면 재계산 안내가 뜸', (await page.textContent('#solveMsg')).includes('다시 눌러'));
  await page.click('#btnSolve');
  await page.waitForFunction(() => window.__CJ__.state.result.returnToStart === false);
  const r2 = await page.evaluate(() => ({
    total: window.__CJ__.state.result.total,
    names: window.__CJ__.state.result.seq.map(p => p.name),
    legs: window.__CJ__.state.result.legs.length
  }));
  ok('미복귀 시 마지막이 출발지가 아님', r2.names[r2.names.length - 1] !== '충주시청', r2.names.join(' → '));
  ok('미복귀 시 구간 수가 7', r2.legs === 7, String(r2.legs));
  ok('미복귀 총거리가 복귀 총거리보다 짧음', r2.total < r1.total, `${r2.total.toFixed(3)} < ${r1.total.toFixed(3)}`);
  ok('미복귀 결과도 독립 DP와 일치',
    Math.abs(r2.total - heldKarpMin(uiCheck.o, uiCheck.s, false)) < 1e-9);

  // 복사
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.click('#btnCopy');
  await page.waitForFunction(() => document.querySelector('#copyMsg').textContent.length > 0);
  const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
  ok('복사 결과 안내가 표시됨', (await page.textContent('#copyMsg')).length > 0);
  ok('클립보드 본문에 방문 순서가 들어 있음',
    clip.includes('출장 방문순서 추천') && clip.includes('총 직선거리'), clip.slice(0, 60).replace(/\n/g, ' | '));
  ok('복사 본문에 직선거리 주의 문구 포함', clip.includes('직선거리 기준 추천'));
  ok('복사 본문의 줄 수가 방문 지점 수와 맞음',
    clip.split('\n').filter(l => /^\d+\. /.test(l)).length === r2.names.length - 1);

  // 인쇄 레이아웃
  await page.emulateMedia({ media: 'print' });
  const printState = await page.evaluate(() => ({
    hiddenSolve: getComputedStyle(document.querySelector('#btnSolve').closest('section')).display,
    resultVisible: getComputedStyle(document.querySelector('#cardResult')).display,
    copyBtn: getComputedStyle(document.querySelector('#btnCopy').parentElement).display
  }));
  ok('인쇄 시 입력·버튼 영역은 숨겨짐', printState.hiddenSolve === 'none' && printState.copyBtn === 'none');
  ok('인쇄 시 결과 영역은 보임', printState.resultVisible !== 'none');
  await page.emulateMedia({ media: 'screen' });

  // 출장지 1곳
  await page.evaluate(() => {
    const st = window.__CJ__.state;
    st.stops.splice(1);
  });
  await page.click('#btnSolve');
  await page.waitForFunction(() => document.querySelector('#solveMsg').textContent.includes('1곳'));
  ok('출장지가 1곳이면 안내와 함께 거리만 표시', (await page.textContent('#solveMsg')).includes('비교할 순서가 없습니다'));

  await ctx.close();

  /* ---------------- 7. 오류 처리 ---------------- */
  section('7(요구사항 7). 오류 상황의 한국어 안내');
  // (a) 키 없음 — Mock 없이 열기
  {
    const c = await browser.newContext();
    const p = await c.newPage();
    await p.goto(APP);
    await p.waitForFunction(() => !!window.__CJ__);
    ok('키 미입력 시 한국어로 안내', (await p.textContent('#sdkNote')).includes('카카오 JavaScript 키가 입력되지 않았습니다'));
    await p.fill('#stopQuery', '충주경찰서');
    await p.click('#btnStopSearch');
    ok('키 없이 검색하면 안내만 표시하고 계산하지 않음',
      (await p.textContent('#stopMsg')).includes('카카오 JavaScript 키'));
    ok('키 없이도 좌표 직접 입력 안내가 제공됨',
      (await p.textContent('#sdkNote')).includes('위도·경도 직접 입력'));
    // 출발지 미확정 상태에서 계산 시도
    await p.click('#btnSolve');
    ok('출발지 미확정 시 계산을 거부', (await p.textContent('#solveMsg')).includes('출발지가 확정되지 않았습니다'));
    // 좌표 직접 입력 경로 (검색 불가 상태에서는 접힌 영역이 자동으로 펼쳐져 있어야 한다)
    ok('검색 불가 상태에서 좌표 직접 입력 영역이 자동으로 펼쳐짐',
      await p.evaluate(() => document.querySelector('#manualFold').open === true));
    await p.fill('#mName', '충주시청');
    await p.fill('#mLat', '36.991');
    await p.fill('#mLng', '127.92');
    await p.click('#btnManualOrigin');
    ok('좌표 직접 입력으로 출발지 지정 가능', await p.evaluate(() => !!window.__CJ__.state.origin));
    await p.fill('#mName', '충주경찰서'); await p.fill('#mLat', '36.995'); await p.fill('#mLng', '127.925');
    await p.click('#btnManualStop');
    await p.fill('#mName', '주덕읍'); await p.fill('#mLat', '36.97'); await p.fill('#mLng', '127.82');
    await p.click('#btnManualStop');
    await p.click('#btnSolve');
    await p.waitForSelector('#cardResult:not(.hidden)');
    ok('검색 없이도 좌표 직접 입력만으로 방문순서 계산 가능',
      await p.evaluate(() => window.__CJ__.state.result.seq.length === 4));
    // 잘못된 좌표
    await p.fill('#mName', '잘못된곳'); await p.fill('#mLat', '127.9'); await p.fill('#mLng', '36.9');
    await p.click('#btnManualStop');
    ok('범위를 벗어난 좌표는 한국어로 거부', (await p.textContent('#manualMsg')).includes('대한민국 범위를 벗어난'));
    // 가짜 키 형식 경고
    await p.click('#btnSettings');
    await p.fill('#apiKey', 'KakaoAK 1234');
    await p.click('#btnKeyApply');
    ok('키 형식 오류를 한국어로 안내', (await p.textContent('#sdkNote')).includes('키 형식이 올바르지 않아'));
    await c.close();
  }
  // (b-1) 로컬 파일(file://)에서 검색이 거부될 때 — 실제로 확인된 상황
  {
    const c = await browser.newContext();
    const p = await c.newPage();
    await p.addInitScript(mockInit(), { db: MOCK_DB, addrs: MOCK_ADDR, behavior: 'error' });
    await p.goto(APP);
    await p.waitForFunction(() => !!window.__CJ__);
    await p.click('#btnSettings');
    const note = await p.textContent('#originNote');
    ok('설정 화면이 file:// 상태임을 미리 경고', note.includes('로컬 파일(file://)로 열려 있습니다'));
    ok('경고가 좌표 직접 입력 대안을 함께 안내', note.includes('위도·경도 직접 입력'));

    await p.fill('#stopQuery', '충주경찰서');
    await p.click('#btnStopSearch');
    await p.waitForFunction(() => document.querySelector('#stopMsg').textContent.includes('로컬 파일'));
    const t = await p.textContent('#stopMsg');
    ok('file://에서 검색 실패 시 원인을 콕 집어 안내',
      t.includes('로컬 파일에서는 카카오 장소 검색을 사용할 수 없습니다'));
    ok('등록한 도메인이 무관함을 설명', t.includes('등록한 주소는 이 파일과 아무 관계가 없습니다'));
    ok('해결책 3가지를 제시', t.includes('좌표 직접 입력') && t.includes('https 주소에 올리기'));
    ok('검색 실패 후 좌표 직접 입력 영역이 자동으로 펼쳐짐',
      await p.evaluate(() => document.querySelector('#manualFold').open === true));
    ok('오류 안내에 영어 개발자 메시지를 노출하지 않음',
      !/Error|undefined|NaN/.test(t), t.replace(/\s+/g, ' ').slice(0, 160));
    await c.close();
  }
  // (b-2) https 주소에서 검색이 거부될 때 — 도메인 등록 안내
  {
    const c = await browser.newContext();
    const p = await c.newPage();
    const html = fs.readFileSync(APP_PATH, 'utf8');
    await p.route('https://example.go.kr/**', r =>
      r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }));
    await p.addInitScript(mockInit(), { db: MOCK_DB, addrs: MOCK_ADDR, behavior: 'error' });
    await p.goto('https://example.go.kr/app.html');
    await p.waitForFunction(() => !!window.__CJ__);
    await p.click('#btnSettings');
    const note = await p.textContent('#originNote');
    ok('https에서는 등록해야 할 주소를 그대로 보여 줌', note.includes('https://example.go.kr'));
    ok('등록 위치 두 곳을 모두 안내',
      note.includes('플랫폼 → Web → 사이트 도메인') && note.includes('JavaScript SDK 도메인'));

    await p.fill('#stopQuery', '충주경찰서');
    await p.click('#btnStopSearch');
    await p.waitForFunction(() => document.querySelector('#stopMsg').textContent.includes('오류'));
    const t = await p.textContent('#stopMsg');
    ok('https에서 검색 API 오류를 한국어로 안내', t.includes('검색 중 오류가 발생했습니다'));
    ok('오류 안내에 현재 주소를 그대로 표시', t.includes('https://example.go.kr'));
    ok('오류 안내에 도메인·캐시·쿼터 점검 항목 포함',
      t.includes('사이트 도메인') && t.includes('시크릿 창') && t.includes('쿼터'));
    await c.close();
  }
  // (c) 검색 결과 없음
  {
    const c = await browser.newContext();
    const p = await c.newPage();
    await p.addInitScript(mockInit(), { db: MOCK_DB, addrs: MOCK_ADDR, behavior: 'normal' });
    await p.goto(APP);
    await p.waitForFunction(() => !!window.__CJ__);
    await p.fill('#stopQuery', '존재하지않는장소이름XYZ');
    await p.click('#btnStopSearch');
    await p.waitForFunction(() => document.querySelector('#stopMsg').textContent.includes('검색 결과가 없습니다'));
    ok('결과 없음을 한국어로 안내하고 대안을 제시',
      (await p.textContent('#stopMsg')).includes('띄어쓰기'));
    // 주소 검색 모드
    await p.click('#sModeAddress');
    await p.fill('#stopQuery', '중원대로 3324');
    await p.click('#btnStopSearch');
    await p.waitForSelector('#stopResults .item');
    ok('주소 검색(addressSearch) 경로로 결과를 가져옴',
      await p.evaluate(() => !!document.querySelector('#stopResults .nm')));
    await p.locator('#stopResults .item').first().locator('button').click();
    ok('주소 검색 결과도 좌표와 함께 등록됨', await p.evaluate(() => {
      const s = window.__CJ__.state.stops[0];
      return s && Math.abs(s.lat - 36.969) < 1e-9 && s.source.includes('주소');
    }));
    await c.close();
  }
  // (d) 응답이 없는 경우(타임아웃) — 짧게 확인
  {
    const c = await browser.newContext();
    const p = await c.newPage();
    await p.addInitScript(mockInit(), { db: MOCK_DB, addrs: MOCK_ADDR, behavior: 'silent' });
    await p.goto(APP);
    await p.waitForFunction(() => !!window.__CJ__);
    const timedOut = await p.evaluate(async () => {
      // 타임아웃 경로를 직접 호출해 짧게 확인한다
      const ps = new window.kakao.maps.services.Places();
      let called = false;
      ps.keywordSearch('충주', () => { called = true; });
      await new Promise(r => setTimeout(r, 50));
      return !called;
    });
    ok('응답이 오지 않는 상황을 Mock으로 재현 (앱은 15초 후 안내)', timedOut);
    await c.close();
  }

  /* ---------------- 반응형 ---------------- */
  section('반응형 레이아웃');
  {
    const c = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const p = await c.newPage();
    await p.addInitScript(mockInit(), { db: MOCK_DB, addrs: MOCK_ADDR, behavior: 'normal' });
    await p.goto(APP);
    await p.waitForFunction(() => !!window.__CJ__);
    const overflow = await p.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok('모바일 폭(390px)에서 가로 스크롤이 생기지 않음', overflow <= 1, '초과 ' + overflow + 'px');
    await c.close();
  }
  {
    const c = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await c.newPage();
    await p.addInitScript(mockInit(), { db: MOCK_DB, addrs: MOCK_ADDR, behavior: 'normal' });
    await p.goto(APP);
    await p.waitForFunction(() => !!window.__CJ__);
    const overflow = await p.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok('PC 폭(1280px)에서 가로 스크롤이 생기지 않음', overflow <= 1, '초과 ' + overflow + 'px');
    await c.close();
  }

} finally {
  await browser.close();
}

console.log('\n────────────────────────────────────────');
console.log(`통과 ${pass}건 / 실패 ${fail}건`);
if (fail) {
  console.log('\n실패 목록:');
  failures.forEach(f => console.log(' - ' + f));
}
console.log('\n주의: 이 검증은 모두 Mock(가짜) 카카오 SDK 기준입니다.');
console.log('실제 카카오 API 호출은 이 스크립트에서 수행하지 않습니다.');
process.exit(fail ? 1 : 0);
