// Start Vite preview on port 4189 before running.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({executablePath: process.env.NORTHSTAR_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  const context = await browser.newContext({viewport:{width:1350,height:900}});
  await context.addInitScript(() => {
    window.__calls=[];
    window.confirm=()=>{ throw new Error('Update must not require a second confirmation'); };
    window.__TAURI_INTERNALS__={invoke:async(cmd)=>{
      window.__calls.push(cmd);
      if(cmd==='get_desktop_context') return {environment:'production',vaultPath:'test',taskDirectory:'test',agents:[]};
      if(cmd==='plugin:app|version') return '0.1.6';
      if(cmd==='plugin:updater|check') return null;
      if(cmd==='ui_update_ready') return sessionStorage.getItem('test-update') ? 1 : 0;
      if(cmd==='check_ui_update') return sessionStorage.getItem('test-update') ? null : {revision:1};
      if(cmd==='apply_ui_update') {sessionStorage.setItem('test-update','applied'); setTimeout(()=>location.replace(location.pathname+'?_northstar_ui=1'),20); return null;}
      if(cmd==='get_sidebar_counts') return {openTasks:0,unreadMail:0};
      if(cmd==='list_services'||cmd==='list_obsidian_tasks') return [];
      return null;
    }};
  });
  const page=await context.newPage(); const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:4189/');
  await page.getByRole('button',{name:'应用界面更新 1'}).waitFor();
  await page.evaluate(()=>{const original=Date.now; Date.now=()=>original()+60000; window.dispatchEvent(new Event('focus'));});
  await page.waitForFunction(()=>window.__calls.filter(name=>name==='plugin:updater|check').length>=2 && window.__calls.filter(name=>name==='check_ui_update').length>=2);
  await page.getByRole('button',{name:'应用界面更新 1'}).click();
  await page.getByText('V0.1.7', {exact:true}).waitFor();
  assert.equal(await page.getByText('界面 1').count(),0);
  assert.equal(await page.getByRole('button',{name:'应用界面更新 1'}).count(),0);
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('test-update')),'applied');
  assert.equal(new URL(page.url()).searchParams.get('_northstar_ui'),'1');
  assert.deepEqual(errors,[]);
  console.log('UI update mock: verified one-click update, in-window reload, revision display and no installer call.');
  await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
