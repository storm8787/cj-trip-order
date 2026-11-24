/** Mock Local/Navi APIs only; never connects to Kakao or Render. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = root + 'tests/fixtures/toolbox-client.html';
const REST = 'MOCK_REST_NOT_A_REAL_KEY';
const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; };
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
const pause = ms => new Promise(r => setTimeout(r, ms));
const docs = [
  { id:'a', place_name:'검증 출발지', address_name:'검증 지번 1', road_address_name:'검증 도로 1', x:'127.92', y:'36.99' },
  { id:'b', place_name:'검증 출장지', address_name:'검증 지번 2', road_address_name:'', x:'127.93', y:'36.98' }
];
const requests = [];
let calls = 0, naviStatus = 200;
const upstream = http.createServer(async (req, res) => {
  calls++;
  const url = new URL(req.url, 'http://localhost');
  requests.push({ path:url.pathname, query:Object.fromEntries(url.searchParams), auth:req.headers.authorization });
  const send = body => { if (!res.destroyed) { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(body)); } };
  if (url.pathname.startsWith('/v1/')) {
    if (naviStatus !== 200) { res.statusCode = naviStatus; return send({message:REST}); }
    let body = ''; for await (const chunk of req) body += chunk;
    if (url.pathname.includes('/destinations/')) {
      const data = JSON.parse(body);
      return send({ routes:data.destinations.map(d => ({ key:d.key, result_code:0,
        summary:{distance: data.origin.x < d.x ? 1200 : 1800, duration: data.origin.x < d.x ? 120 : 180} })) });
    }
    return send({ routes:[{result_code:0,summary:{distance:2000,duration:200}}] });
  }
  const query = url.searchParams.get('query');
  if (query?.startsWith('status')) {
    res.statusCode = Number(query.slice(6)); return send({ message:REST, environment:'PRIVATE_ENV' });
  }
  if (query === 'network') return req.socket.destroy();
  if (query === 'timeout') { await pause(300); return send({documents:docs,meta:{is_end:true}}); }
  if (query === 'body-timeout') { res.writeHead(200, {'Content-Type':'application/json'}); res.write('{'); await pause(300); return res.end('}'); }
  if (query === 'slow' || query?.startsWith('parallel')) await pause(80);
  if (query === 'bad-json') { res.end('not JSON '+REST); return; }
  if (query === 'bad-meta') return send({documents:docs,meta:{}});
  let documents = docs;
  if (url.pathname.endsWith('/address.json')) documents = [
    {address_name:'전체 주소',x:'127.92',y:'36.99',address:{address_name:'지번 주소'},road_address:{address_name:'도로명 주소',building_name:'건물명'}},
    {address_name:'중첩 주소 없는 결과',x:'127.93',y:'36.98'}
  ];
  if (query === 'empty') documents = [];
  if (query === 'missing') documents = [...docs, ...[
    {x:'',y:'36.99'}, {x:null,y:'36.99'}, {x:'127.92'}, {x:'NaN',y:'36.99'},
    {x:'127.92',y:'91'}, {x:true,y:'36.99'}, {x:'181',y:'36.99'}
  ]];
  send({documents, meta:{is_end:query !== 'more',total_count:9999,pageable_count:45}});
});
let upPort;
const apps = new Set();
async function app(env = {}) {
  const probe = http.createServer(); const port = await listen(probe); await close(probe);
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import {server} from './server/server.mjs';
    server.on('request', req => process.send({origin:req.headers.origin ?? '(absent)',method:req.method}));
  `], {cwd:root, env:{...process.env,
    PORT:String(port), KAKAO_REST_API_KEY:REST, KAKAO_JAVASCRIPT_KEY:'',
    KAKAO_LOCAL_BASE:`http://127.0.0.1:${upPort}`, KAKAO_NAVI_BASE:`http://127.0.0.1:${upPort}`,
    SEARCH_RATE_LIMIT_PER_MIN:'1000', SEARCH_TIMEOUT_MS:'150', SEARCH_DAILY_CALL_BUDGET:'1000',
    SEARCH_UPSTREAM_CONCURRENCY:'4', DAILY_CALL_BUDGET:'5000', ALLOWED_ORIGINS:'', ALLOW_FILE_ORIGIN:'false',
    ...env}, stdio:['ignore','pipe','pipe','ipc']});
  const observedOrigins = []; child.on('message', message => observedOrigins.push(message));
  const logs = []; child.stdout.on('data', d => logs.push(String(d))); child.stderr.on('data', d => logs.push(String(d)));
  const base = `http://127.0.0.1:${port}`;
  for (let i=0;i<100;i++) {
    if (child.exitCode !== null) throw new Error('app exited: '+logs.join(''));
    try { if ((await fetch(base+'/api/health')).ok) break; } catch {}
    await pause(20);
  }
  const stop = async () => { if (child.exitCode === null) { child.kill(); await once(child,'exit'); } apps.delete(stop); };
  apps.add(stop);
  return {base, stop, logs, observedOrigins};
}
const searchPath = (query='normal', rest={}) => '/api/search?' + new URLSearchParams({type:'keyword',query,...rest});
async function json(base, path=searchPath(), options={}) { const r=await fetch(base+path,options); return {status:r.status, body:await r.json(), headers:r.headers}; }
const matrixRequest = {method:'POST', headers:{'Content-Type':'application/json'},body:JSON.stringify({points:[{lat:36.99,lng:127.92},{lat:36.98,lng:127.93}]})};

test('Local search and CORS integration (Mock)', async t => {
  upPort = await listen(upstream);
  t.after(async () => { for (const stop of apps) await stop(); await close(upstream); });
  const normal = await app();
  await t.test('keyword contract, normalization and upstream authentication', async () => {
    const r = await json(normal.base,searchPath('  충주시청  '));
    assert.equal(r.status,200); assert.equal(r.body.items.length,2);
    assert.deepEqual(r.body.items[0],{id:'a',name:'검증 출발지',roadAddress:'검증 도로 1',address:'검증 지번 1',lat:36.99,lng:127.92});
    assert.equal(r.body.hasMore,false); assert.equal(r.body.omittedCount,0);
    const sent=requests.at(-1); assert.equal(sent.path,'/v2/local/search/keyword.json');
    assert.equal(sent.query.query,'충주시청'); assert.equal(sent.query.page,'1'); assert.equal(sent.query.size,'15');
    assert.equal(sent.auth,'KakaoAK '+REST);
  });
  await t.test('address results do not invent place IDs or missing nested data', async () => {
    const r=await json(normal.base,searchPath('주소',{type:'address',size:'30'}));
    assert.deepEqual(r.body.items[0],{id:null,name:'건물명',roadAddress:'도로명 주소',address:'지번 주소',lat:36.99,lng:127.92});
    assert.deepEqual(r.body.items[1],{id:null,name:'중첩 주소 없는 결과',roadAddress:'',address:'중첩 주소 없는 결과',lat:36.98,lng:127.93});
    assert.equal(requests.at(-1).path,'/v2/local/search/address.json');
  });
  await t.test('empty, pagination and excluded invalid coordinates', async () => {
    assert.deepEqual((await json(normal.base,searchPath('empty'))).body,{items:[],page:1,hasMore:false,omittedCount:0});
    assert.equal((await json(normal.base,searchPath('more',{page:'2'}))).body.hasMore,true);
    assert.equal((await json(normal.base,searchPath('more',{page:'45'}))).body.hasMore,false);
    const r=await json(normal.base,searchPath('missing')); assert.equal(r.body.items.length,2); assert.equal(r.body.omittedCount,7);
  });
  await t.test('invalid requests never call upstream', async () => {
    const before=calls;
    for (const params of [{type:'url'},{query:''},{query:'   '},{query:'x'.repeat(101)},{query:'a\nb'},
      {page:'0'},{page:'46'},{page:'1.2'},{page:'abc'},{size:'0'},{size:'16'},{type:'address',size:'31'}]) {
      assert.equal((await json(normal.base,searchPath('valid',params))).status,400,JSON.stringify(params));
    }
    for (const path of ['/api/search?type=keyword&query=a&query=b','/api/search?query=a',searchPath()+'&url=https://example.com']) {
      assert.equal((await json(normal.base,path)).status,400);
    }
    assert.equal((await json(normal.base,searchPath(),{method:'POST'})).status,405);
    assert.equal((await json(normal.base,searchPath('x'.repeat(4200)))).status,414);
    assert.equal(calls,before);
  });
  await t.test('missing key, auth, permission, quota, timeout, network and malformed responses', async () => {
    const noKey=await app({KAKAO_REST_API_KEY:''}); const before=calls;
    assert.equal((await json(noKey.base)).body.code,'NO_KEY'); assert.equal(calls,before); await noKey.stop();
    for (const [query,status,code] of [['status401',502,'KEY_INVALID'],['status403',502,'KEY_FORBIDDEN'],
      ['status429',429,'QUOTA'],['status500',502,'UPSTREAM'],['timeout',504,'TIMEOUT'],['body-timeout',504,'TIMEOUT'],
      ['network',502,'NETWORK'],['bad-json',502,'BAD_RESPONSE'],['bad-meta',502,'BAD_RESPONSE']]) {
      const r=await json(normal.base,searchPath(query)); assert.equal(r.status,status,query); assert.equal(r.body.code,code,query);
      assert.ok(!JSON.stringify(r.body).includes(REST)); assert.ok(!JSON.stringify(r.body).includes('PRIVATE_ENV'));
    }
    assert.ok(!normal.logs.join('').includes(REST)); assert.ok(!normal.logs.join('').includes('충주시청'));
  });
  await t.test('per-IP rate limit is separate from matrix requests', async () => {
    const a=await app({SEARCH_RATE_LIMIT_PER_MIN:'1',SEARCH_DAILY_CALL_BUDGET:'1'});
    assert.equal((await json(a.base)).status,200);
    assert.equal((await json(a.base)).body.code,'RATE_LIMIT');
    assert.equal((await json(a.base,'/api/matrix',matrixRequest)).status,200); await a.stop();
  });
  await t.test('in-flight deduplication, concurrency rejection and no persistent cache', async () => {
    const a=await app({SEARCH_UPSTREAM_CONCURRENCY:'1'}); const before=calls;
    const first=json(a.base,searchPath('slow'));
    await pause(20);
    const second=json(a.base,searchPath('slow'));
    const busy=await json(a.base,searchPath('other')); assert.equal(busy.body.code,'SEARCH_BUSY');
    const [one,two]=await Promise.all([first,second]); assert.deepEqual(one.body,two.body); assert.equal(calls-before,1);
    await json(a.base,searchPath('slow')); assert.equal(calls-before,2); await a.stop();
  });
  await t.test('daily budget reserves failed and concurrent calls before fetch', async () => {
    const a=await app({SEARCH_DAILY_CALL_BUDGET:'2'}); const before=calls;
    const results=await Promise.all([json(a.base,searchPath('status401')),json(a.base,searchPath('parallel1')),json(a.base,searchPath('parallel2'))]);
    assert.equal(calls-before,2); assert.equal(results.filter(r=>r.body.code==='DAILY_BUDGET').length,1);
    assert.equal((await json(a.base)).body.code,'DAILY_BUDGET'); assert.equal(calls-before,2); await a.stop();
    const zero=await app({SEARCH_DAILY_CALL_BUDGET:'0'}); const n=calls;
    assert.equal((await json(zero.base)).body.code,'DAILY_BUDGET'); assert.equal(calls,n); await zero.stop();
  });
  await t.test('road budget also reserves before concurrent upstream calls', async () => {
    const a=await app({DAILY_CALL_BUDGET:'1'}); const before=calls;
    const results=await Promise.all([json(a.base,'/api/matrix',matrixRequest),json(a.base,'/api/matrix',matrixRequest)]);
    for (const r of results) { assert.equal(r.status,429); assert.equal(r.body.code,'DAILY_BUDGET'); }
    assert.equal(calls-before,1);
    assert.equal((await json(a.base,'/api/matrix',matrixRequest)).body.code,'DAILY_BUDGET'); assert.equal(calls-before,1); await a.stop();
  });
  await t.test('failed road calls consume the road budget without exposing errors or key', async () => {
    const a=await app({DAILY_CALL_BUDGET:'1',UPSTREAM_CONCURRENCY:'1'}); const before=calls;
    try {
      naviStatus=401;
      const r=await json(a.base,'/api/matrix',matrixRequest);
      assert.equal(r.body.code,'KEY_INVALID'); assert.equal(calls-before,1);
      assert.ok(!JSON.stringify(r.body).includes(REST));
      assert.equal((await json(a.base,'/api/matrix',matrixRequest)).body.code,'DAILY_BUDGET');
      assert.equal(calls-before,1); assert.ok(!a.logs.join('').includes(REST));
    } finally { naviStatus=200; await a.stop(); }
  });
  await t.test('CORS applies to all APIs and errors; null requires explicit opt-in', async () => {
    const a=await app({ALLOWED_ORIGINS:'https://allowed.example,null,*'});
    for (const origin of ['https://allowed.example',a.base]) {
      const r=await json(a.base,searchPath(),{headers:{Origin:origin}});
      assert.equal(r.status,200); assert.equal(r.headers.get('access-control-allow-origin'),origin);
      assert.equal(r.headers.get('access-control-allow-credentials'),null);
      const fail=await json(a.base,searchPath('',{}),{headers:{Origin:origin}});
      assert.equal(fail.status,400); assert.equal(fail.headers.get('access-control-allow-origin'),origin);
    }
    // Wildcard legacy web-origin compatibility still cannot enable opaque origins.
    assert.equal((await json(a.base,searchPath(),{headers:{Origin:'null'}})).status,403); await a.stop();
    for (const path of ['/api/health','/api/config',searchPath(),'/api/matrix']) {
      const r=await json(normal.base,path,{headers:{Origin:'https://denied.example'}});
      assert.equal(r.status,403); assert.equal(r.headers.get('access-control-allow-origin'),null);
    }
    const deniedPre=await fetch(normal.base+'/api/matrix',{method:'OPTIONS',headers:{Origin:'null','Access-Control-Request-Method':'POST'}});
    assert.equal(deniedPre.status,403); assert.equal(deniedPre.headers.get('access-control-allow-origin'),null);
    const enabled=await app({ALLOW_FILE_ORIGIN:'true',ALLOWED_ORIGINS:'https://allowed.example'});
    for (const origin of ['null','https://allowed.example']) {
      const pre=await fetch(enabled.base+'/api/matrix',{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type'}});
      assert.equal(pre.status,204); assert.equal(pre.headers.get('access-control-allow-origin'),origin);
      assert.equal(pre.headers.get('vary'),'Origin');
      const getPre=await fetch(enabled.base+'/api/search',{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'GET'}});
      assert.equal(getPre.status,204); assert.equal(getPre.headers.get('access-control-allow-origin'),origin);
      const post=await json(enabled.base,'/api/matrix',{...matrixRequest,headers:{...matrixRequest.headers,Origin:origin}});
      assert.equal(post.status,200); assert.notEqual(post.body.matrix[0][1].distance,post.body.matrix[1][0].distance);
      for (const headers of [{'Access-Control-Request-Method':'DELETE'}, {'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'Authorization'}]) {
        const r=await fetch(enabled.base+'/api/search',{method:'OPTIONS',headers:{Origin:origin,...headers}}); assert.equal(r.status,403);
      }
      const bad=await json(enabled.base,'/api/matrix',{method:'POST',headers:{Origin:origin},body:'not json'});
      assert.equal(bad.status,400); assert.equal(bad.headers.get('access-control-allow-origin'),origin);
    }
    const tooLarge=await json(enabled.base,'/api/matrix',{method:'POST',headers:{Origin:'null'},body:'x'.repeat(70000)});
    assert.equal(tooLarge.status,413); assert.equal(tooLarge.headers.get('access-control-allow-origin'),'null');
    await enabled.stop();
  });
  await t.test('real Chromium same-origin, allowed/denied web origin, file off/on, readable API errors', async () => {
    const web=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(fs.readFileSync(fixture));});
    const webPort=await listen(web), webBase=`http://127.0.0.1:${webPort}`;
    const enabled=await app({ALLOW_FILE_ORIGIN:'true',ALLOWED_ORIGINS:webBase});
    const browser=await chromium.launch();
    try {
      for (const [pageUrl,base,allowed] of [
        [enabled.base+'/tests/fixtures/toolbox-client.html',enabled.base,true],
        [webBase,enabled.base,true], [webBase,normal.base,false],
        [pathToFileURL(fixture).href,normal.base,false], [pathToFileURL(fixture).href,enabled.base,true]
      ]) {
        const targetApp = base === normal.base ? normal : enabled;
        const startIndex = targetApp.observedOrigins.length;
        const context=await browser.newContext(); const page=await context.newPage();
        await page.goto(pageUrl); await page.fill('#base',base); await page.click('#search');
        await page.waitForFunction(()=>window.result!==null);
        const result=await page.evaluate(()=>window.result);
        assert.equal(Boolean(result.error),!allowed,pageUrl+' -> '+base);
        if (allowed) {
          await page.locator('#items button').nth(0).click(); await page.locator('#items button').nth(1).click();
          await page.click('#matrix'); await page.waitForFunction(()=>window.result?.matrix || window.result?.error);
          const matrix=await page.evaluate(()=>window.result); assert.equal(matrix.matrix.length,2);
          assert.equal(matrix.matrix[0][1].distance,1200); assert.equal(matrix.matrix[1][0].distance,1800);
          await page.fill('#query','status403'); await page.click('#search'); await page.waitForFunction(()=>window.result?.error);
          assert.match((await page.evaluate(()=>window.result)).error,/KEY_FORBIDDEN/);
          const failure=await page.evaluate(async base=>{
            const r=await fetch(base+'/api/matrix',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'omit',body:'null'});
            return {status:r.status,body:await r.json()};
          },base);
          assert.equal(failure.status,400); assert.equal(failure.body.code,'BAD_POINTS');
        }
        if (pageUrl.startsWith('file:')) assert.ok(targetApp.observedOrigins.slice(startIndex).some(h=>h.origin==='null'),'server observed actual file request Origin: null');
        await context.close();
      }
    } finally { await browser.close(); await close(web); await enabled.stop(); }
  });
});
