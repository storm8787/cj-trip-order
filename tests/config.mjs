/** 공개 설정/자동 SDK 초기화 회귀 검증. 카카오 SDK는 Mock이며 실제 API를 호출하지 않습니다. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const key = '0123456789abcdef0123456789abcdef';
const rest = 'mock-rest-never-public';
const child = spawn(process.execPath, ['server/server.mjs'], {
  cwd: root, env: { ...process.env, PORT:'18989', KAKAO_JAVASCRIPT_KEY:key,
    KAKAO_REST_API_KEY:rest, CONFIG_TEST_SECRET:'mock-other-private' }, stdio:['ignore','pipe','pipe']
});
let logs = '';
child.stdout.on('data', d => { logs += d; });
child.stderr.on('data', d => { logs += d; });
let browser, count = 0;
function check(condition, name){ assert.ok(condition, name); console.log('PASS '+name); count++; }
const base = 'http://127.0.0.1:18989';
const sdk = `window.kakao={maps:{load:cb=>cb(),services:{Status:{OK:'OK',ZERO_RESULT:'ZERO_RESULT'},
 Places:function(){this.keywordSearch=(q,cb)=>cb([{id:q,place_name:q,x:'127.92',y:'36.99'}],'OK')},
 Geocoder:function(){this.addressSearch=(q,cb)=>cb([{address_name:q,x:'127.93',y:'36.98'}],'OK')}}}};`;
try {
  for(let i=0;i<100;i++){
    try{ if((await fetch(base+'/api/health')).ok) break; }catch{}
    await new Promise(r=>setTimeout(r,50));
  }
  const response = await fetch(base+'/api/config');
  const body = await response.text();
  assert.deepEqual(JSON.parse(body),{kakaoJavascriptKey:key});
  check(!body.includes(rest) && !body.includes('mock-other-private'), '공개 설정은 JavaScript 키만 반환');
  check(response.headers.get('cache-control')==='no-store', '설정 응답 캐시 금지');
  check((await fetch(base+'/api/config',{method:'POST'})).status===405,'설정은 GET만 허용');
  const html = await (await fetch(base+'/%EC%B6%9C%EC%9E%A5%EB%B0%A9%EB%AC%B8%EC%88%9C%EC%84%9C%EC%B6%94%EC%B2%9C.html')).text();
  check(!html.includes(rest) && !html.includes(key), 'HTML에 환경변수 키를 삽입하지 않음');
  const rootResponse = await fetch(base+'/', { redirect:'manual' });
  check(rootResponse.status===200 && !rootResponse.headers.has('location'), '루트 요청은 리다이렉트 없이 200 응답');
  check((await rootResponse.text())===html, '루트에서 한글 파일과 동일한 앱 HTML 제공');
  const index = await (await fetch(base+'/index.html')).text();
  check(index.includes('location.replace('), 'GitHub Pages용 index.html 유지');
  browser = await chromium.launch();
  async function pageFor(config, behavior='ok', saved=true){
    const context = await browser.newContext();
    if(saved) await context.addInitScript(() => localStorage.setItem('cjTripOrder.kakaoJsKey','saved-manual-key'));
    const page = await context.newPage();
    const errors=[]; page.on('pageerror',e=>errors.push(e));
    const keys=[];
    await page.route('https://dapi.kakao.com/**', route=>{
      keys.push(new URL(route.request().url()).searchParams.get('appkey'));
      return behavior==='fail' ? route.abort() : route.fulfill({contentType:'application/javascript',body:sdk});
    });
    if(config!==undefined) await page.route('**/api/config', route=> config===404
      ? route.fulfill({status:404,body:'Not Found'})
      : route.fulfill({json:config}));
    await page.goto(base+'/');
    await page.waitForFunction(()=>window.__CJ__ && !window.__CJ__.state.configPending && ['idle','ready','error'].includes(window.__CJ__.state.sdk));
    assert.deepEqual(errors,[]);
    return {context,page,keys};
  }
  let t=await pageFor();
  check(t.page.url()===base+'/', 'SDK 초기화 후에도 주소창 루트 유지');
  check(t.keys.length===1 && t.keys[0]===key,'서버 키가 저장 키보다 먼저 자동 적용');
  check(await t.page.locator('#btnSettings').isHidden(),'자동 설정 환경에서 설정 UI 숨김');
  check(await t.page.evaluate(()=>localStorage.getItem('cjTripOrder.kakaoJsKey'))==='saved-manual-key','자동 키를 localStorage에 저장하지 않음');
  await t.page.click('#btnOriginSearch');
  await t.page.locator('#originResults button').first().waitFor();
  check((await t.page.locator('#originResults').innerText()).includes('충주시청'),'설정 없이 장소 검색');
  await t.page.click('#oModeAddress');
  await t.page.click('#btnOriginSearch');
  await t.page.locator('#originResults button').first().waitFor();
  check((await t.page.locator('#originResults').innerText()).includes('충주시청'),'자동 설정으로 주소 검색');
  check(t.page.url()===base+'/', '장소·주소 검색 후에도 주소창 루트 유지');
  await t.context.close();
  for(const config of [{kakaoJavascriptKey:''},404]){
    t=await pageFor(config);
    check(t.keys[0]==='saved-manual-key' && await t.page.locator('#btnSettings').isVisible(),'키 없는 서버/정적 호스팅에서 기존 저장 키 적용');
    await t.page.click('#btnSettings');
    await t.page.fill('#apiKey','abcdef0123456789abcdef0123456789');
    await t.page.click('#btnKeyApply');
    check(await t.page.locator('#apiKey').isVisible() && await t.page.evaluate(()=>window.__CJ__.state.key)==='abcdef0123456789abcdef0123456789','수동 입력 키 적용');
    await t.context.close();
  }
  t=await pageFor({kakaoJavascriptKey:''},'ok',false);
  check(await t.page.evaluate(()=>window.__CJ__.state.sdk)==='idle', '처음 접속한 수동 환경은 키 입력 대기 상태');
  await t.page.click('#btnSettings');
  await t.page.fill('#apiKey', key);
  await t.page.click('#btnKeyApply');
  await t.page.waitForFunction(()=>window.__CJ__.state.sdk==='ready');
  check(t.keys[0]===key && await t.page.evaluate(()=>localStorage.getItem('cjTripOrder.kakaoJsKey'))===null, '수동 키로 SDK 로드하며 저장 미동의 시 저장하지 않음');
  await t.page.check('#chkSaveKey');
  check(await t.page.evaluate(()=>localStorage.getItem('cjTripOrder.kakaoJsKey'))===key, '수동 키 저장 동의 동작');
  await t.page.click('#btnKeyClear');
  check(await t.page.evaluate(()=>localStorage.getItem('cjTripOrder.kakaoJsKey'))===null, '수동 저장 키 삭제 동작');
  await t.context.close();
  for(const [config,behavior] of [[{kakaoJavascriptKey:'invalid'},'ok'],[null,'ok'],[{},'ok'],[undefined,'fail']]){
    t=await pageFor(config,behavior);
    check(await t.page.locator('#btnSettings').isHidden() && (await t.page.locator('#sdkNote').innerText()).includes('관리자'),'잘못된 관리자 설정/SDK 실패는 관리자 확인 안내');
    check(await t.page.evaluate(()=>window.__CJ__.state.sdk)==='error','잘못된 설정에서 저장 키로 우회하지 않음');
    await t.context.close();
  }
  t=await pageFor();
  await t.page.evaluate(()=>{ window.kakao.maps.services.Places=function(){this.keywordSearch=(q,cb)=>cb([],'ERROR')}; });
  await t.page.click('#btnOriginSearch');
  await t.page.waitForFunction(()=>document.getElementById('originMsg').textContent.includes('관리자'));
  check(!(await t.page.locator('#originMsg').innerText()).includes('키를 입력'), '검색 API 거부 시 직원에게 키 입력을 요구하지 않음');
  await t.context.close();
  check(!logs.includes(rest) && !logs.includes(key) && !logs.includes('mock-other-private'),'서버 로그에 키/기타 비밀 환경변수 없음');
  console.log(`${count} checks passed (Mock)`);
} finally {
  await browser?.close();
  child.kill();
  if(child.exitCode===null) await once(child,'exit');
}
