import assert from 'node:assert/strict';
import {readFile, mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright';
import {load} from 'js-yaml';
import {resolveBallScenario} from '../app/ball.js';
import {positionAt} from '../app/scene.js';
import {localizeLesson} from '../app/localization.js';

const pack = JSON.parse(await readFile('content/default.flagbook.json', 'utf8'));
const lessons = pack.lessons.filter(lesson => lesson.ball);
const browser = await chromium.launch({headless: true, ...(process.env.CHROME_EXECUTABLE ? {executablePath: process.env.CHROME_EXECUTABLE} : {channel: 'chrome'})});
const output = resolve('tmp/ball-integration');
await mkdir(output, {recursive: true});
try {
  const context = await browser.newContext({viewport: {width: 1440, height: 1050}, acceptDownloads: true});
  const page = await context.newPage();
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  await page.goto(pathToFileURL(resolve('dist/Flagventures.html')).href);
  const select = id => page.locator(`[data-lesson="${id}"]`).evaluate(button => button.click());
  const seek = time => page.locator('#seek').evaluate((range, value) => {
    range.value = value; range.dispatchEvent(new Event('input', {bubbles: true}));
  }, time);
  const ball = () => page.locator('[data-ball]').evaluate(node => ({
    state: node.dataset.ballState, owner: node.dataset.ballOwner,
    position: JSON.parse(node.dataset.ballPosition),
  }));
  const near = (actual, expected, label) => assert.ok(Math.hypot(...actual.map((v, i) => v - expected[i])) < 1e-5, label);
  let scenarios = 0;
  assert.equal(lessons.length, 45);
  for (const lesson of lessons) {
    await select(lesson.id);
    assert.equal(await page.locator('[data-ball-scenario]').count(), lesson.ball.scenarios.length);
    for (const scenario of lesson.ball.scenarios) {
      scenarios++;
      await page.locator(`[data-ball-scenario="${scenario.id}"]`).click();
      assert.equal(await page.locator('#seek').inputValue(), '0');
      assert.equal(await page.locator('[data-ball]').count(), 1);
      assert.equal(await page.locator('#play').isDisabled(), false);
      const resolved = resolveBallScenario(lesson, scenario.id);
      let owner = lesson.ball.initialOwner;
      for (const event of scenario.events) {
        if (event.type === 'snap' || event.type === 'pass') {
          const middle = (event.at + event.endAt) / 2;
          // Range step is .01; choose a representable point and use its actual time.
          await seek(middle);
          const time = Number(await page.locator('#seek').inputValue());
          const snapshot = await ball();
          assert.equal(snapshot.state, 'flight'); assert.equal(snapshot.owner, '');
          const from = positionAt(resolved.lesson.players.find(p => p.id === event.from), event.at, resolved.choices);
          const to = positionAt(resolved.lesson.players.find(p => p.id === event.to), event.endAt, resolved.choices);
          const progress = (time - event.at) / (event.endAt - event.at);
          near(snapshot.position, from.map((v, i) => v + (to[i] - v) * progress), `${lesson.id}/${scenario.id}: flight meets moving receiver`);
          owner = event.to;
          await seek(event.endAt);
        } else {
          await seek(event.at);
          if (event.type === 'handoff') owner = event.to;
        }
        assert.equal((await ball()).owner, owner, `${lesson.id}/${scenario.id}/${event.id}`);
        if (event.endAt !== undefined && event.endCue) {
          await seek(event.endAt);
          assert.equal(await page.locator('#ballEvent').textContent(), event.endCue, 'completed actions show their outcome');
        }
      }
      for (const override of scenario.motions || []) {
        if (!override.motion.note) continue;
        await page.locator(`#roles [data-player="${override.player}"]`).click();
        assert.equal(await page.locator('#routeDescription').textContent(), override.motion.note, 'current scenario movement replaces the source-only explanation');
      }
      await seek(lesson.timeline.duration);
      assert.equal((await ball()).owner, owner);
      const end = await ball();
      await seek(0); await seek(lesson.timeline.duration);
      assert.deepEqual(await ball(), end, 'seeking reconstructs possession without replaying events');
    }
  }
  const sample = pack.lessons.find(lesson => lesson.id === 'twins-play-2');
  await select(sample.id);
  await page.locator('[data-ball-scenario="pass-c"]').click();
  const pass = sample.ball.scenarios.find(item => item.id === 'pass-c').events.find(item => item.type === 'pass');
  await seek((pass.at + pass.endAt) / 2);
  const heldTime = await page.locator('#seek').inputValue(), heldBall = await ball();
  await page.waitForTimeout(400);
  assert.deepEqual(await ball(), heldBall, 'paused ball stays still');
  await page.locator('#roles [data-player="X"]').click();
  assert.deepEqual(await ball(), heldBall, 'inspecting a teammate does not change the target');
  await page.selectOption('#language', 'en');
  assert.equal(await page.locator('#seek').inputValue(), heldTime);
  assert.deepEqual(await ball(), heldBall);
  await page.locator('#ballControls').scrollIntoViewIfNeeded();
  await page.screenshot({path: `${output}/pass-english.png`, fullPage: true});

  for (const lesson of lessons) {
    await select(lesson.id);
    const translated = localizeLesson(lesson, 'en');
    for (const scenario of lesson.ball.scenarios) {
      await page.locator(`[data-ball-scenario="${scenario.id}"]`).click();
      await seek(lesson.timeline.duration);
      for (const selector of ['#ballControls', '#ballReadout', '#frames']) {
        assert.doesNotMatch(await page.locator(selector).textContent(), /[\u3400-\u9fff]/u, `${lesson.id}/${scenario.id}: English ball UI`);
      }
      for (const override of translated.ball.scenarios.find(item => item.id === scenario.id).motions || []) {
        if (!override.motion.note) continue;
        await page.locator(`#roles [data-player="${override.player}"]`).click();
        assert.equal(await page.locator('#routeDescription').textContent(), override.motion.note);
        assert.doesNotMatch(await page.locator('#routeDescription').textContent(), /[\u3400-\u9fff]/u);
      }
    }
  }
  await page.selectOption('#language', 'zh');
  await select('single-back-play-1');
  await page.locator('[data-ball-scenario="pass-c"]').click();
  assert.equal(await page.locator('#choices').isVisible(), false);
  await page.locator('#ballEnabled').uncheck();
  assert.equal(await page.locator('[data-ball]').count(), 0);
  assert.equal(await page.locator('#choices').isVisible(), true);
  assert.equal(await page.locator('#play').isDisabled(), true);
  await page.locator('#ballEnabled').check();
  assert.equal(await page.locator('#play').isDisabled(), false);
  await page.locator('#play').click();
  await page.waitForFunction(() => Number(document.querySelector('#seek').value) > .1);
  await page.locator('[data-ball-scenario="pass-z"]').click();
  assert.equal(await page.locator('#seek').inputValue(), '0');
  await page.waitForTimeout(200);
  assert.equal(await page.locator('#seek').inputValue(), '0', 'switching targets resets and pauses');

  // Export authored scenarios, not the selected runtime motion overrides/keyframes.
  await page.locator('#manage').click();
  const downloading = page.waitForEvent('download'); await page.locator('#exportLesson').click();
  const download = await downloading;
  const exported = load(await readFile(await download.path(), 'utf8'));
  assert.deepEqual(exported, pack.lessons.find(item => item.id === 'single-back-play-1'));
  await page.locator('#fileInput').setInputFiles({name: download.suggestedFilename(), mimeType: 'application/yaml', buffer: await readFile(await download.path())});
  await page.locator('#applyImport').click();
  assert.equal(await page.locator('[data-ball-scenario]').count(), 4, 'round-trip import keeps every target');

  for (const [id, scenario, time] of [['twins-play-2', 'pass-c', pass.at], ['hb-dive', null, 2], ['fake-double-reverse', null, 4.2]]) {
    await select(id);
    if (scenario) await page.locator(`[data-ball-scenario="${scenario}"]`).click();
    await seek(time);
    for (const width of [1440, 390]) {
      await page.setViewportSize({width, height: 1050});
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      await page.locator('#ballControls').scrollIntoViewIfNeeded();
      await page.screenshot({path: `${output}/${id}-${width}.png`, fullPage: true});
    }
  }
  await select('route-hitch');
  assert.equal(await page.locator('#ballReadout').isVisible(), false);
  assert.equal(await page.locator('[data-ball]').count(), 0, 'switching lessons leaves no ghost ball');
  assert.deepEqual(errors, []); assert.deepEqual(requests, [], 'ball lessons work offline');
  console.log(`PASS ${lessons.length} plays / ${scenarios} ball scenarios, all transfers and English captions, seeking, choice compatibility, export/import, narrow layout, offline`);
} finally { await browser.close(); }
