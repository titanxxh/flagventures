import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import * as playwright from 'playwright';

// The main suites run in Chrome. This smoke test covers the same core paths in Firefox and in
// WebKit, Safari's engine, which most iPhones and iPads use. CI installs both with
// `npx playwright install --with-deps firefox webkit`; BROWSERS=chromium runs it locally.
const engines = (process.env.BROWSERS || 'firefox,webkit').split(',').map(name => name.trim()).filter(Boolean);
const url = pathToFileURL(resolve('dist/Flagventures.html')).href;
const pack = JSON.parse(await readFile('content/default.flagbook.json', 'utf8'));
const crossbuck = pack.lessons.find(lesson => lesson.id === 'crossbuck');

for (const engine of engines) {
  const launch = engine === 'chromium' && process.env.CHROME_EXECUTABLE ? {executablePath: process.env.CHROME_EXECUTABLE} : {};
  const browser = await playwright[engine].launch({headless: true, ...launch});
  const check = (condition, message) => assert.ok(condition, `${engine}: ${message}`);
  try {
    for (const colorScheme of ['light', 'dark']) {
      const context = await browser.newContext({viewport: {width: 1366, height: 657}, colorScheme});
      const page = await context.newPage();
      const errors = [], requests = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
      await page.goto(`${url}#lesson=crossbuck`);
      await page.waitForFunction(title => document.querySelector('#lessonTitle').textContent === title, crossbuck.title.zh);
      const seek = () => page.locator('#seek').evaluate(range => Number(range.value));

      if (colorScheme === 'dark') {
        const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
        const [r, g, b] = background.match(/\d+/g).map(Number);
        check(r + g + b < 200, `dark mode follows the system (${background})`);
        await context.close();
        continue;
      }

      check(await page.locator('#catalog [data-lesson]').count() === pack.lessons.length, 'the catalog lists every lesson');
      check(await page.locator('#field .player').count() === crossbuck.players.length, 'every player is drawn');
      check(await page.locator('#field [data-ball-action]').count() > 0, 'ball action markers are drawn');
      const paths = await page.locator('#field path').evaluateAll(nodes => nodes.map(node => node.getAttribute('d') || ''));
      check(paths.length > 0 && paths.every(d => !/NaN|Infinity/.test(d)), 'field geometry is finite');

      // Short laptop: field, caption and the whole control bar share the first screen.
      const layout = await page.evaluate(() => {
        const rect = selector => document.querySelector(selector).getBoundingClientRect();
        return {play: rect('#play').toJSON(), speed: rect('.speed').toJSON(), field: rect('#field').height, width: document.documentElement.scrollWidth};
      });
      check(layout.play.bottom <= 657 && layout.speed.bottom <= 657, `play and speed are in the first screen (${Math.round(layout.speed.bottom)})`);
      check(Math.abs(layout.play.top - layout.speed.top) < 8, 'the control bar is one row');
      check(layout.field >= 150, `the field stays usable (${Math.round(layout.field)}px)`);
      check(layout.width <= 1367, 'no horizontal scroll');

      // Playback, pause and keyframes.
      await page.locator('#play').click();
      await page.waitForFunction(() => Number(document.querySelector('#seek').value) > .3);
      await page.locator('#play').click();
      const paused = await seek();
      await page.waitForTimeout(300);
      check(await seek() === paused, 'pause holds the scene');
      await page.locator('#frames [data-frame="2"]').click();
      check(await page.locator('#frames [data-frame="2"]').getAttribute('aria-pressed') === 'true', 'a keyframe can be chosen');

      // Keyboard shortcuts.
      await page.locator('#lessonTitle').click();
      await page.keyboard.press('0');
      check(await seek() === 0, '0 resets');
      await page.keyboard.press('Space');
      await page.waitForFunction(() => Number(document.querySelector('#seek').value) > .1);
      await page.keyboard.press('Space');
      await page.keyboard.press(']');
      await page.waitForFunction(id => document.querySelector('#catalog [aria-current="true"]')?.dataset.lesson !== id, 'crossbuck');

      // Shared openings of ball sequences are said once.
      await page.locator('#catalog [data-lesson="qb-option"]').click();
      check(await page.locator('.ball-options-lead').isVisible(), 'shared sequence lead is shown');
      check((await page.locator('[data-ball-scenario]').first().textContent()).length < 12, 'buttons show only what differs');

      // Full screen toggles, browser history follows lessons.
      await page.locator('#fullscreen').click();
      check(await page.locator('.board.board-fullscreen').count() === 1, 'full screen opens');
      await page.locator('#fullscreen').click();
      check(await page.locator('.board.board-fullscreen').count() === 0, 'full screen closes');
      await page.goBack();
      await page.waitForFunction(() => document.querySelector('#catalog [aria-current="true"]')?.dataset.lesson !== 'qb-option');

      // English.
      await page.selectOption('#language', 'en');
      check(await page.locator('#play').textContent() !== '▶ 开始演示', 'English play label');
      check(!/[㐀-鿿]/.test(await page.locator('.controls').textContent()), 'controls are English');

      // Printed handout hides the controls.
      await page.emulateMedia({media: 'print'});
      check(!(await page.locator('.controls').isVisible()), 'print hides the controls');
      await page.emulateMedia({media: 'screen'});

      // Phone: the catalog is a drawer and the page never scrolls sideways.
      await page.setViewportSize({width: 390, height: 844});
      await page.locator('#catalogToggle').click();
      await page.locator('#library').waitFor({state: 'visible'});
      await page.locator('#catalog [data-lesson="hb-dive"]').click();
      await page.locator('#library').waitFor({state: 'hidden'});
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'phone has no horizontal scroll');
      // The play button is below the first screen, so a floating copy brings the board in and plays.
      await page.evaluate(() => scrollTo(0, 0));
      await page.locator('#floatingPlay').waitFor({state: 'visible'});
      await page.locator('#floatingPlay').click();
      await page.waitForFunction(() => Number(document.querySelector('#seek').value) > .1);
      check(await page.locator('.controls').evaluate(node => node.getBoundingClientRect().bottom <= innerHeight + 1), 'the floating button brings the controls into view');
      await page.locator('#floatingPlay').waitFor({state: 'hidden'});

      check(errors.length === 0, `no page errors: ${errors.join(' | ')}`);
      check(requests.length === 0, 'works offline from the single file');
      await context.close();
    }
    console.log(`PASS ${engine}: catalog, field, playback, keyframes, shortcuts, short-laptop fit, full screen, history, English, print, phone drawer and floating play, dark mode`);
  } finally { await browser.close(); }
}
