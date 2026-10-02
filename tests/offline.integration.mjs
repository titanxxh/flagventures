import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {extname, join, normalize, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright';

// Serve dist/ under /flagventures/ the way GitHub Pages does.
const root = resolve('dist');
const types = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8'};
const server = createServer(async (request, response) => {
  const path = decodeURIComponent(new URL(request.url, 'http://local').pathname);
  if (!path.startsWith('/flagventures/')) { response.writeHead(404).end(); return; }
  const file = normalize(join(root, path.slice('/flagventures/'.length) || 'index.html'));
  if (!file.startsWith(root)) { response.writeHead(403).end(); return; }
  try {
    const body = await readFile(file.endsWith('/') ? join(file, 'index.html') : file);
    response.writeHead(200, {'content-type': types[extname(file)] || 'application/octet-stream'}).end(body);
  } catch { response.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}/flagventures/`;
const browser = await chromium.launch({headless: true, ...(process.env.CHROME_EXECUTABLE ? {executablePath: process.env.CHROME_EXECUTABLE} : {channel: 'chrome'})});
try {
  const context = await browser.newContext({viewport: {width: 390, height: 844}});
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href');
  const manifest = await (await page.request.get(new URL(manifestHref, base).href)).json();
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, './');
  for (const icon of manifest.icons) {
    const response = await page.request.get(new URL(icon.src, base).href);
    assert.equal(response.status(), 200, icon.src);
    assert.equal(response.headers()['content-type'], 'image/png', icon.src);
  }
  assert.ok(manifest.icons.some(icon => icon.purpose === 'maskable' && icon.sizes === '512x512'));
  assert.equal((await page.request.get(new URL(await page.locator('link[rel="apple-touch-icon"]').getAttribute('href'), base).href)).status(), 200);

  // The service worker takes control and caches the app; then the network goes away.
  await page.evaluate(() => navigator.serviceWorker.ready);
  if (!(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)))) {
    await page.evaluate(() => new Promise(done => navigator.serviceWorker.addEventListener('controllerchange', done, {once: true})));
  }
  await context.setOffline(true);
  const offline = await context.newPage();
  offline.on('pageerror', error => errors.push(error.message));
  await offline.goto(`${base}#lesson=cover-2`);
  await offline.locator('#field .player').first().waitFor();
  assert.match(await offline.locator('#lessonTitle').textContent(), /覆盖|Cover/, 'a new tab opens the shared link offline');
  await page.reload();
  await page.locator('#field .player').first().waitFor();
  await page.locator('#play').click();
  await page.waitForFunction(() => Number(document.querySelector('#seek').value) > .1);
  await context.setOffline(false);
  assert.deepEqual(errors, []);

  // The downloaded single file neither links a manifest nor registers a worker.
  const local = await browser.newPage();
  const localErrors = [];
  local.on('console', message => { if (message.type() === 'error') localErrors.push(message.text()); });
  await local.goto(pathToFileURL(resolve('dist/Flagventures.html')).href);
  await local.locator('#field .player').first().waitFor();
  assert.equal(await local.locator('link[rel="manifest"]').count(), 0);
  assert.equal(await local.evaluate(() => Boolean(navigator.serviceWorker?.controller)), false);
  assert.deepEqual(localErrors, []);
  console.log('PASS installable online copy: manifest and icons, offline reload and playback through the service worker; file copy stays self-contained');
} finally {
  await browser.close();
  server.close();
}
