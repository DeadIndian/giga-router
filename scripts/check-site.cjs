// Real-browser checks for the public website, served under a Pages-style subpath.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { chromium } = require('playwright');
const { buildSite } = require('./build-site.cjs');
const { serveSite } = require('./preview-site.cjs');

async function check() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'giga-site-check-'));
  const screenshots = process.env.SITE_SCREENSHOT_DIR;
  let server, browser;
  try {
    buildSite({ directory, repository: 'fixture-owner/fixture-project', siteUrl: 'https://fixture-owner.github.io/fixture-project' });
    server = serveSite(directory, '/fixture-project/');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    const url = `${origin}/fixture-project/`;
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
    page.on('requestfailed', request => errors.push(request.url()));
    await page.goto(url);
    await page.getByRole('heading', { level: 1 }).waitFor();
    assert.match(await page.title(), /Giga Router/);
    assert.equal(await page.locator('link[rel="canonical"]').getAttribute('href'), 'https://fixture-owner.github.io/fixture-project/');
    assert.match(await page.locator('#preview-code').textContent(), /github.com\/fixture-owner\/fixture-project.git\ncd fixture-project/);
    const anchors = await page.locator('a[href^="#"]').evaluateAll(links => links.map(link => link.getAttribute('href')));
    for (const anchor of anchors.filter(value => value !== '#')) assert.equal(await page.locator(anchor).count(), 1, `Missing anchor ${anchor}`);

    await page.getByRole('tab', { name: 'Failover', exact: true }).click();
    assert.equal(await page.locator('.route-row').nth(0).getAttribute('data-state'), 'skipped');
    assert.equal(await page.locator('.route-row').nth(1).getAttribute('data-state'), 'selected');
    await page.getByRole('tab', { name: 'Failover', exact: true }).press('ArrowRight');
    assert.equal(await page.getByRole('tab', { name: 'Capabilities', exact: true }).getAttribute('aria-selected'), 'true');
    assert.match(await page.locator('#route-intent').textContent(), /image input/);

    await page.getByRole('button', { name: 'Copy preview commands', exact: true }).click();
    // Windows normalizes clipboard text to CRLF; compare the command content.
    const copiedPreview = await page.evaluate(() => navigator.clipboard.readText());
    assert.equal(copiedPreview.replace(/\r\n/g, '\n'), (await page.locator('#preview-code').textContent()).trim());
    await page.getByRole('tab', { name: 'Docker install', exact: true }).click();
    assert.equal(await page.locator('#install-preview').isVisible(), false);
    assert.equal(await page.locator('#install-docker').isVisible(), true);
    await page.getByRole('button', { name: 'Copy Docker start command', exact: true }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'docker compose up -d --build --wait');
    await page.getByRole('tab', { name: 'Docker install', exact: true }).press('ArrowLeft');
    assert.equal(await page.locator('#install-preview').isVisible(), true);

    for (const width of [360, 390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 960 });
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished)));
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 0, `${width}px viewport overflows by ${overflow}px`);
      if (width <= 390) {
        await page.getByRole('button', { name: 'Toggle navigation', exact: true }).click();
        assert.equal(await page.locator('#navigation').isVisible(), true);
        await page.locator('#navigation').getByRole('link', { name: 'Quick start', exact: true }).click();
        assert.equal(await page.locator('#navigation').isVisible(), false);
      }
      if (screenshots && [390, 1440].includes(width)) {
        fs.mkdirSync(screenshots, { recursive: true });
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
        await page.screenshot({ path: path.join(screenshots, `website-${width}.png`), fullPage: true, animations: 'disabled' });
      }
    }
    await page.getByText('Does this run on GitHub Pages?', { exact: false }).click();
    assert.equal(await page.locator('.faq-list details').first().getAttribute('open'), '');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior), 'auto');
    assert.deepEqual(errors, []);

    const noJs = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
    const staticPage = await noJs.newPage();
    await staticPage.goto(url);
    assert.equal(await staticPage.locator('#navigation').isVisible(), true);
    assert.equal(await staticPage.locator('#preview-code').isVisible(), true);
    assert.equal((await staticPage.locator('img').evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0))), true);
    console.log('Website passed: project-path assets, repository links, routing scenarios, keyboard tabs, clipboard, mobile navigation, FAQ, reduced motion, and no-JS content. Layouts fit at 360, 390, 768, 1024, and 1440px.');
  } finally {
    await browser?.close();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
check().catch(error => { console.error(error); process.exitCode = 1; });
