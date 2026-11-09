// Run npm run build and npm run preview -- --host 127.0.0.1 --port 4189 before npm run test:ui.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({executablePath: process.env.NORTHSTAR_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
 const page=await browser.newPage({viewport:{width:1350,height:900}}), errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{window.__calls=[];window.__TAURI_INTERNALS__={invoke:async(cmd,args={})=>{
 window.__calls.push([cmd,args]);
 if(cmd==='get_desktop_context')return {environment:'development',vaultPath:'test',taskDirectory:'test',agents:[{name:'DSH',installed:true}]};
 if(cmd==='get_sidebar_counts')return {openTasks:0,unreadMail:0};
 if(cmd==='list_obsidian_notes')return Array.from({length:30},(_,i)=>({file:`${i}.md`,title:`测试笔记 ${i}`,preview:'摘要'}));
 if(cmd==='read_obsidian_note')return '# 标题\n\n**加粗内容**\n\n- 项目一\n\n| 名称 | 状态 |\n|---|---|\n| 项目 | 完成 |\n\n<script>alert(1)</script>';
 if(cmd==='list_obsidian_tasks')return Array.from({length:40},(_,i)=>({id:String(i),title:'任务 '+i,details:'',raw:'',completed:false,file:'test.md',line:i}));
 if(cmd==='list_services')return Array.from({length:20},(_,i)=>({id:'s'+i,name:'服务 '+i,description:'测试',reachable:true,checks:[]}));
 if(cmd==='list_mail_accounts')return [{id:'mock',provider:'gmail',address:'test@example.invalid',label:'test',authType:'app_password',connectionState:'connected'}];
 if(cmd==='get_gmail_setup')return {configured:false,clientSecretConfigured:false};
 if(cmd==='sync_mail_messages') {let arr=Array.from({length:20},(_,i)=>({id:'1-'+(i+1),threadId:'1',from:'sender',subject:`mail ${i}`,date:'2026',snippet:'',labels:i%2?[]:['UNREAD']}));return {order:arr.map(a=>a.id),unread:arr.filter(a=>a.labels.length).map(a=>a.id),newMessages:arr};}
 if(cmd==='get_mail_message')return {id:args.messageId,threadId:'1',from:'sender',subject:'详情',date:'',snippet:'',labels:[],body:'测试正文'};
 if(cmd==='mark_mail_read'){if(sessionStorage.getItem('fail-mark'))throw '模拟失败';return null;}
 return null;}};});
 await page.goto('http://127.0.0.1:4189/'); const nav=name=>page.locator('.sidebar').getByRole('button',{name,exact:true});
 assert.equal(await page.locator('.home-intro .lead, .home-intro .eyebrow').count(),0);
 await nav('笔记').click();await page.getByRole('button',{name:/测试笔记 0/}).click();
 await page.locator('.note-markdown h1').getByText('标题').waitFor();assert.equal(await page.locator('.note-markdown strong').textContent(),'加粗内容');assert.equal(await page.locator('.note-markdown table td').count(),2);assert.equal(await page.locator('.note-markdown script').count(),0);
 await page.getByRole('button',{name:/返回列表/}).click();
 for(const n of ['待办','笔记','我的服务']){await nav(n).click(); await page.waitForTimeout(300);const section=page.locator('main > section');await section.evaluate(el=>{el.scrollTop=el.scrollHeight});await page.waitForTimeout(200);assert(await section.evaluate(el=>el.classList.contains('module-scrolled')),n+' compact'); assert(await section.locator('.module-sticky span').evaluate(el=>getComputedStyle(el).opacity) > 0,n+' header visible'); }
 await nav('收件箱').click(); await page.getByRole('button',{name:/mail 0/}).waitFor();let count=await page.evaluate(()=>window.__calls.filter(([c])=>c==='sync_mail_messages').length);
 await page.getByRole('button',{name:/mail 0/}).click();await page.getByText('测试正文').waitFor();await page.waitForFunction(()=>window.__calls.some(([c])=>c==='mark_mail_read'));await page.getByRole('button',{name:/返回列表/}).click();
 assert.equal(await page.getByRole('button',{name:/mail 0/}).locator('[aria-label="未读"]').count(),0);
 await nav('首页').click();await nav('收件箱').click();await page.getByRole('button',{name:/mail 0/}).waitFor();assert.equal(await page.evaluate(()=>window.__calls.filter(([c])=>c==='sync_mail_messages').length),count);
 await page.evaluate(()=>sessionStorage.setItem('fail-mark','1'));await page.getByRole('button',{name:/mail 2/}).click();await page.getByText(/未能同步已读状态/).waitFor();await page.getByRole('button',{name:/返回列表/}).click();assert.equal(await page.getByRole('button',{name:/mail 2/}).locator('[aria-label="未读"]').count(),1);
 assert.deepEqual(errors,[]);console.log('PASS: Markdown, sticky modules, seen success/failure, revisit without resync');await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
