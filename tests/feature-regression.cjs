// Start the Vite preview on port 4189 before running this test.
const { chromium } = require('playwright'); const assert = require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.NORTHSTAR_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
 const page=await browser.newPage({viewport:{width:1350,height:900}}); const errors=[];page.on('pageerror',e=>errors.push(e.message));
 let fetches=0; await page.route('https://api.github.com/**',route=>{fetches++;return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({items:[{id:42,full_name:'test/repo',html_url:'https://github.com/test/repo',description:'repo',language:'Rust',stargazers_count:3}]})});});
 await page.addInitScript(()=>{window.__calls=[];window.__tasks=[];window.__TAURI_INTERNALS__={invoke:async(cmd,args={})=>{
  window.__calls.push([cmd,args]);
  if(cmd==='get_desktop_context')return {environment:'development',vaultPath:'test',taskDirectory:'test',agents:[]};
  if(cmd==='get_sidebar_counts')return {openTasks:0,unreadMail:0};
  if(cmd==='list_services')return [];if(cmd==='list_local_folders')return [];
  if(cmd==='list_obsidian_tasks')return window.__tasks;
  if(cmd==='create_obsidian_task'){window.__tasks=[{id:'a',title:args.title,details:args.details,raw:'line',completed:false,file:'待办事项/Northstar.md',line:0}];return window.__tasks[0]}
  if(cmd==='list_mail_accounts')return [{id:'mock',provider:'gmail',address:'test@example.invalid',label:'test',authType:'app_password',connectionState:'connected'}];
  if(cmd==='get_gmail_setup')return {configured:false,clientSecretConfigured:false};
  if(cmd==='sync_mail_messages'){let arr=Array.from({length:4},(_,i)=>({id:'1-'+(i+1),threadId:'1',from:'sender',subject:`mail ${i}`,date:'2026',snippet:'',labels:['UNREAD']}));return {order:arr.map(a=>a.id),unread:arr.map(a=>a.id),newMessages:arr};}
  if(cmd==='get_mail_message')return {id:args.messageId,threadId:'1',from:'sender',subject:'详情',date:'',snippet:'',labels:[],body:'预加载正文'};
  if(cmd==='mark_mail_read')return null;
  if(cmd==='batch_mail_action')return {succeeded:[args.messageIds[0]],failed:args.messageIds.slice(1).map(id=>({id,error:'模拟失败'}))};
  return null;}};});
 await page.goto('http://127.0.0.1:4189/'); const nav=n=>page.locator('.sidebar').getByRole('button',{name:n,exact:true});
 await nav('热点').click();await page.getByText('test/repo').waitFor(); assert.equal(fetches,1); await nav('首页').click();await nav('热点').click();await page.getByText('test/repo').waitFor();assert.equal(fetches,1);await page.getByRole('button',{name:'刷新',exact:true}).click();await page.waitForTimeout(200);assert.equal(fetches,2);
 await nav('待办').click();await page.getByRole('button',{name:/添加一件事/}).click();await page.getByPlaceholder('待办标题').fill('测试多事项');await page.getByLabel('事项 1',{exact:true}).fill('第一项');await page.getByRole('button',{name:'在事项 1 后增加'}).click();await page.getByLabel('事项 2',{exact:true}).fill('第二项');await page.getByRole('button',{name:'确认创建'}).click();await page.getByText('测试多事项').waitFor();assert.deepEqual(await page.locator('.task-detail-status span:last-child').allTextContents(),['第一项','第二项']);assert.equal((await page.evaluate(()=>window.__calls.find(([c])=>c==='create_obsidian_task')))[1].details,'第一项\n第二项');
 await nav('收件箱').click();await page.getByRole('button',{name:/mail 0/}).waitFor();await page.waitForFunction(()=>window.__calls.some(([c])=>c==='get_mail_message'));assert.equal(await page.evaluate(()=>window.__calls.filter(([c])=>c==='mark_mail_read').length),0);const before=await page.evaluate(()=>window.__calls.filter(([c,a])=>c==='get_mail_message'&&a.messageId==='1-1').length);await page.getByRole('button',{name:/mail 0/}).click();await page.getByText('预加载正文').waitFor();assert.equal(await page.evaluate(()=>window.__calls.filter(([c,a])=>c==='get_mail_message'&&a.messageId==='1-1').length),before);await page.getByRole('button',{name:/返回列表/}).click();
 await page.getByLabel('选择邮件 mail 1',{exact:true}).check();await page.getByLabel('选择邮件 mail 2',{exact:true}).check();await page.getByRole('button',{name:'删除',exact:true}).click();await page.getByRole('alert').getByText(/1 封未确认/).waitFor();assert.equal(await page.getByLabel('选择邮件 mail 1',{exact:true}).count(),0);assert(await page.getByLabel('选择邮件 mail 2',{exact:true}).isChecked());assert.equal((await page.evaluate(()=>window.__calls.find(([c])=>c==='batch_mail_action')))[1].action,'trash');
 assert.deepEqual(errors,[]);console.log('PASS: daily GitHub cache, multi-item tasks, body prefetch and partial batch handling');await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
