const { chromium } = require('playwright');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.NORTHSTAR_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1350, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem('northstar.theme', 'day');
      window.__calls = [];
      window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: 'main' } }, invoke: async (command, args = {}) => {
        window.__calls.push([command, args]);
        if (command === 'get_desktop_context') return { environment: 'development', agents: [] };
        if (command === 'get_sidebar_counts') return { openTasks: 0, unreadMail: 0 };
        if (['list_services', 'list_obsidian_tasks', 'list_mail_accounts', 'list_local_notes', 'list_local_folders'].includes(command)) return [];
        return null;
      } };
    });
    await page.goto('http://127.0.0.1:4189/');
    await page.getByLabel('窗口操作').waitFor();
    assert.equal(await page.locator('.space-card svg').count(), 4);
    assert.equal(await page.locator('.dock-icon svg').count(), 7);
    const noOverlap = await page.evaluate(() => {
      const a = document.querySelector('.version-indicator').getBoundingClientRect();
      const b = document.querySelector('.window-controls').getBoundingClientRect();
      return a.right <= b.left;
    });
    assert(noOverlap, 'version controls overlap window controls');
    await page.setViewportSize({ width: 680, height: 500 });
    assert(await page.getByLabel('关闭窗口').isVisible());
    assert(await page.getByLabel('主导航').isVisible());
    assert(await page.evaluate(() => {
      const a = document.querySelector('.version-indicator').getBoundingClientRect();
      const b = document.querySelector('.window-controls').getBoundingClientRect();
      return a.right <= b.left;
    }), 'small window controls overlap');
    await page.setViewportSize({ width: 1350, height: 900 });
    await page.getByLabel('最小化窗口').click();
    await page.getByLabel('最大化或还原窗口').click();
    await page.getByLabel('关闭窗口').click();
    await page.waitForFunction(() => ['plugin:window|minimize', 'plugin:window|toggle_maximize', 'plugin:window|close'].every(cmd => window.__calls.some(([name]) => name === cmd)));
    assert.equal(await page.locator('.window-resize').count(), 0);
    const nav = name => page.locator('.sidebar').getByRole('button', { name, exact: true });
    for (const name of ['待办', '热点', '我的 Agent', '笔记', '收件箱', '我的服务']) {
      await nav(name).click();
      assert(await page.locator('main').isVisible(), `${name} page is not visible`);
      const h = page.locator('main h1').first();
      assert(await h.isVisible(), `${name} title is not visible`);
      assert(await h.evaluate(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; }), `${name} title is clipped`);
    }
    await page.setViewportSize({ width: 680, height: 500 });
    for (const name of ['待办', '热点', '我的 Agent', '笔记', '收件箱', '我的服务']) {
      await nav(name).click();
      assert(await page.locator('main h1').first().isVisible(), `${name} title is hidden in small window`);
      assert(await page.getByLabel('关闭窗口').isVisible());
    }
    await page.setViewportSize({ width: 1350, height: 900 });
    await page.getByLabel('切换夜间模式').click();
    assert(await page.locator('.app-shell.night').count());
    await nav('待办').click();
    await page.getByRole('button', {name: /添加一件事/}).click();
    const placeholder = await page.getByPlaceholder('待办标题').evaluate(element => getComputedStyle(element, '::placeholder').color);
    assert.equal(placeholder, 'rgb(173, 187, 206)', 'dark placeholder should remain legible');
    await nav('首页').click();
    const themed = await page.locator('.space-card i').first().evaluate(element => ({ bg: getComputedStyle(element).backgroundColor, fg: getComputedStyle(element).color }));
    assert.notEqual(themed.bg, themed.fg);
    assert.deepEqual(errors, []);
    console.log('PASS: icon family, window controls, theme and all module navigation');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
