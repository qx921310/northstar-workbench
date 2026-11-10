// Render the same vector mark used by the UI as the Tauri icon source.
const { chromium } = require('playwright');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.NORTHSTAR_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(path.resolve('public/northstar-mark.svg')).href);
    await page.screenshot({ path: 'src-tauri/target/northstar-icon-source.png', omitBackground: true });
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
