// 隔离浏览器回归：两源传递、素材、冲突保护、失败重试和权限边界。
const {chromium} = require('/home/asus/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert = require('node:assert/strict');
const [publicUrl, localUrl] = process.argv.slice(2);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB0cAAAAASUVORK5CYII=', 'base64');

(async () => {
  const browser = await chromium.launch({executablePath:'/usr/bin/google-chrome', args:['--no-sandbox']});
  const context = await browser.newContext({viewport:{width:1440,height:1000}});
  const errors = [];
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  const editor = async () => {
    const page = await context.newPage();
    await page.goto(publicUrl + '/editor.html');
    await page.waitForFunction(() => /载入|恢复/.test(document.querySelector('#save-state').textContent));
    return page;
  };
  const publish = async (page, success) => {
    const windowPromise = page.waitForEvent('popup');
    await page.locator('#header-publish').click();
    const popup = await windowPromise;
    await page.waitForFunction(() => ['success','error'].includes(document.querySelector('#publish-status').dataset.state));
    const status = await page.locator('#publish-status').getAttribute('data-state');
    assert.equal(status, success ? 'success' : 'error', await page.locator('#publish-status').innerText());
    return popup;
  };
  try {
    const viewer = await context.newPage();
    await viewer.goto(publicUrl + '/');
    await viewer.locator('.header-action').waitFor();
    const oldPdf = await viewer.locator('.header-action').getAttribute('href');
    const page = await editor();
    const stale = await editor();
    await page.locator('[data-field="intro"]').fill('在线修改经桥接发布');
    await page.locator('.project-link').first().click();
    await page.locator('[data-upload-kind="new-media"]').setInputFiles({name:'bridge.png',mimeType:'image/png',buffer:png});
    await page.waitForFunction(() => document.querySelectorAll('.media-card').length === 1);
    await publish(page, true);
    let actual = await (await page.request.get(localUrl + '/content.json')).json();
    assert.equal(actual.profile.intro, '在线修改经桥接发布');
    const asset = actual.projects[0].media[0].src;
    assert.deepEqual(await (await page.request.get(localUrl + '/' + asset)).body(), png);
    assert.equal((await (await page.request.get(publicUrl + '/content.json')).json()).profile.intro, actual.profile.intro);
    await viewer.bringToFront();
    await viewer.evaluate(() => window.dispatchEvent(new Event('focus')));
    await viewer.locator('.hero-intro').filter({hasText:'在线修改经桥接发布'}).waitFor();
    assert.notEqual(await viewer.locator('.header-action').getAttribute('href'), oldPdf);
    console.log('通过：在线修改和新增素材一次点击传递并保存，已打开的网页自动更新，PDF链接版本随内容更新。');

    await stale.locator('[data-field="intro"]').fill('过期窗口不应覆盖新版本');
    await publish(stale, false);
    actual = await (await page.request.get(localUrl + '/content.json')).json();
    assert.equal(actual.profile.intro, '在线修改经桥接发布');
    assert.match(await stale.locator('#publish-status').innerText(), /已更新/);
    console.log('通过：过期编辑窗口被拦截，已发布内容保持完整。');

    const retry = await editor();
    await retry.locator('[data-field="intro"]').fill('失败后已保存的草稿');
    await retry.request.post(publicUrl + '/test/fail-next');
    await publish(retry, false);
    assert.equal((await (await retry.request.get(localUrl + '/content.json')).json()).profile.intro, '失败后已保存的草稿');
    await retry.reload();
    await retry.waitForFunction(() => /载入|恢复/.test(document.querySelector('#save-state').textContent));
    assert.equal(await retry.locator('[data-field="intro"]').inputValue(), '失败后已保存的草稿');
    await retry.locator('[data-field="intro"]').fill('刷新后继续修改并重试成功');
    await publish(retry, true);
    assert.equal((await (await retry.request.get(localUrl + '/content.json')).json()).profile.intro, '刷新后继续修改并重试成功');
    console.log('通过：本机保存后发布失败，刷新并继续编辑仍能一键重试。');

    assert.equal(await retry.evaluate(async () => {
      const {trustedMessage} = await import('./editor-publish.js');
      const id = 'a'.repeat(32);
      return trustedMessage({source:window,origin:'https://evil.invalid',data:{id}},window,location.origin,id)
        || trustedMessage({source:window,origin:location.origin,data:{id:'b'.repeat(32)}},window,location.origin,id)
        || trustedMessage({source:window,origin:location.origin,data:{id}},null,location.origin,id);
    }), false);
    const blocked = await editor();
    await blocked.evaluate(() => { window.open = () => null; });
    await blocked.locator('#header-publish').click();
    await blocked.waitForFunction(() => document.querySelector('#publish-status').dataset.state === 'error');
    assert.match(await blocked.locator('#publish-status').innerText(), /拦截/);
    console.log('通过：错误来源、会话与窗口不被信任，弹窗拦截给出明确错误。');
    await blocked.setViewportSize({width:390,height:844});
    assert.equal(await blocked.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

    const slowContext = await browser.newContext();
    await slowContext.addInitScript(() => {
      const schedule = window.setTimeout.bind(window);
      window.setTimeout = (callback, duration, ...args) => schedule(callback, duration === 120000 ? 80 : duration, ...args);
    });
    const slow = await slowContext.newPage();
    await slow.goto(publicUrl + '/editor.html');
    await slow.waitForFunction(() => /载入|恢复/.test(document.querySelector('#save-state').textContent));
    const timeoutMessage = await slow.evaluate(async () => {
      const {publishThroughLocal} = await import('./editor-publish.js');
      try {
        await publishThroughLocal({prepare:async () => { await new Promise(resolve => setTimeout(resolve, 300)); return {}; }});
        return '';
      } catch (error) { return error.message; }
    });
    assert.match(timeoutMessage, /超时/);
    await slowContext.close();
    console.log('通过：慢准备阶段明确返回超时，移动端更新按钮无横向溢出。');
    assert.deepEqual(errors, []);
  } finally {
    await context.close(); await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
