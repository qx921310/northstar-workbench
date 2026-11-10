const { chromium } = require('playwright');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.NORTHSTAR_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1688, height: 620 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => {
      localStorage.setItem('northstar.theme', 'day');
      window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: 'main' } }, invoke: async command => {
        if (command === 'get_desktop_context') return { environment: 'development', agents: [] };
        if (command === 'get_sidebar_counts') return {};
        if (command === 'list_services') return Array.from({ length: 2 }, (_, i) => ({ id: `service-${i}`, name: `服务 ${i}`, description: '测试服务', reachable: true, checks: [] }));
        if (command === 'list_mail_accounts') return [{ id: 'a', provider: 'gmail', address: 'test@example.invalid', connectionState: 'connected' }];
        if (command === 'get_gmail_setup') return {};
        if (command === 'get_mail_message') return { id: '1-0', threadId: '1', from: 'sender@example.invalid', subject: '测试邮件', date: '', snippet: '', labels: [], htmlBody: `<table><tr><td>${'longunbrokencontent'.repeat(100)}</td><td>邮件内容</td></tr></table>` };
        if (command === 'sync_mail_messages') return { order: Array.from({ length: 20 }, (_, i) => `1-${i}`), unread: [], newMessages: Array.from({ length: 20 }, (_, i) => ({ id: `1-${i}`, threadId: '1', from: 'sender@example.invalid', subject: '测试很长的邮件标题'.repeat(40), date: '', snippet: '', labels: [] })) };
        return [];
      } };
    });
    await page.goto('http://127.0.0.1:4189/');
    const nav = name => page.locator('.sidebar').getByRole('button', { name, exact: true });
    await nav('我的服务').click();
    await page.getByText('服务 0', { exact: true }).waitFor();
    const content = page.locator('.services-content');
    const initial = await content.evaluate(el => el.scrollHeight - el.clientHeight);
    assert(initial > 32 && initial < 100, `expected short scroll range, got ${initial}`);
    await page.evaluate(() => {
      const fixed = document.querySelector('.services-fixed');
      window.__headerChanges = [];
      new MutationObserver(() => window.__headerChanges.push(fixed.classList.contains('compact'))).observe(fixed, { attributes: true, attributeFilter: ['class'] });
      document.querySelector('.services-content').scrollTop = 35;
    });
    await page.waitForTimeout(900);
    assert.deepEqual(await page.evaluate(() => window.__headerChanges), [true], 'header must not repeatedly collapse and expand');
    assert(await page.locator('.services-fixed.compact').isVisible());
    assert((await content.evaluate(el => el.scrollTop)) > 32, 'scroll position should not be clamped across threshold');
    await content.evaluate(el => { el.scrollTop = 0; });
    await page.waitForFunction(() => !document.querySelector('.services-fixed').classList.contains('compact'));
    for (const height of [630, 640]) {
      await page.setViewportSize({ width: 1688, height });
      await page.waitForTimeout(250);
      const max = await content.evaluate(el => el.scrollHeight - el.clientHeight);
      assert(max > 32 && max < 100, `expected short scroll range at ${height}, got ${max}`);
      await page.evaluate(() => { window.__headerChanges = []; document.querySelector('.services-content').scrollTop = 35; });
      await page.waitForTimeout(700);
      assert.deepEqual(await page.evaluate(() => window.__headerChanges), [true], `header should remain stable at ${height}`);
      await content.evaluate(el => { el.scrollTop = 0; });
      await page.waitForFunction(() => !document.querySelector('.services-fixed').classList.contains('compact'));
    }
    await page.setViewportSize({ width: 1688, height: 620 });
    await page.waitForTimeout(250);
    await page.evaluate(() => { window.__headerChanges = []; });
    await content.hover();
    await page.mouse.wheel(0, 45);
    await page.waitForTimeout(900);
    assert.deepEqual(await page.evaluate(() => window.__headerChanges), [true], 'mouse wheel should not cause header oscillation');
    await page.setViewportSize({ width: 1688, height: 900 });
    await nav('收件箱').click();
    await page.getByLabel(/选择邮件/).first().waitFor();
    for (const width of [1688, 1350, 680]) {
      await page.setViewportSize({ width, height: 900 });
      const dimensions = await page.evaluate(() => {
        const content = document.querySelector('.inbox-content');
        const category = document.querySelector('.mail-category-bar');
        const rows = document.querySelector('.message-list');
        return { overflow: getComputedStyle(content).overflowX, categoryOverflow: getComputedStyle(category).overflowX, categoryFits: category.scrollWidth <= category.clientWidth + 1, rowsFit: rows.scrollWidth <= rows.clientWidth + 1 };
      });
      assert.equal(dimensions.overflow, 'hidden');
      assert.notEqual(dimensions.categoryOverflow, 'auto');
      assert(dimensions.categoryFits && dimensions.rowsFit, `mail content should fit at ${width}: ${JSON.stringify(dimensions)}`);
    }
    await page.getByLabel(/选择邮件/).first().locator('..').getByRole('button').click();
    await page.locator('.message-html').waitFor();
    assert(await page.locator('.message-html').evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'long unbroken email content must wrap');
    assert.deepEqual(errors, []);
    console.log('PASS: stable service header with short scroll range and no horizontal mail scrollbar');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
