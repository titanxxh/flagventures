import assert from 'node:assert/strict';
import {readFile, mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright';
import {resolveBallScenario} from '../app/ball.js';
import {positionAt} from '../app/scene.js';

const pack = JSON.parse(await readFile('content/default.flagbook.json', 'utf8'));
const lessons = pack.lessons.filter(lesson => lesson.kind === 'run');
const actionTypes = new Set(['handoff', 'fake-handoff', 'pump-fake']);
const actionText = {
  zh: {'handoff': /交递/u, 'fake-handoff': /假交/u, 'pump-fake': /假传/u},
  en: {'handoff': /HANDOFF/i, 'fake-handoff': /FAKE/i, 'pump-fake': /PUMP\s+FAKE/i},
};
const output = resolve('tmp/ball-markers-integration');
await mkdir(output, {recursive: true});
const browser = await chromium.launch({headless: true});
try {
  const page = await browser.newPage({viewport: {width: 1440, height: 1050}});
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  await page.goto(pathToFileURL(resolve('dist/Flagventures.html')).href);
  await page.selectOption('#language', 'zh');
  const select = id => page.locator(`[data-lesson="${id}"]`).evaluate(button => button.click());
  const seek = time => page.locator('#seek').evaluate((range, value) => {
    range.value = value; range.dispatchEvent(new Event('input', {bubbles: true}));
  }, time);
  const marker = id => page.locator(`#field g[data-ball-action="${id}"]`);
  const time = async () => Number(await page.locator('#seek').inputValue());
  const snapshot = () => page.locator('#field').evaluate(field => ({
    time: document.querySelector('#seek').value,
    ball: field.querySelector('[data-ball]')?.getAttribute('transform'),
    owner: field.querySelector('[data-ball]')?.dataset.ballOwner,
    phase: [...field.querySelectorAll('[data-ball-action]')].map(node => [node.dataset.ballAction, node.dataset.phase]),
  }));
  const near = (actual, expected, message) => assert.ok(Math.hypot(...actual.map((value, axis) => value - expected[axis])) < 1e-5, message);
  const phaseAt = (event, at) => at < event.at ? 'preview'
    : at < (event.endAt ?? event.at + .6) ? 'active' : 'complete';
  const assertPhases = async (scenario, at) => {
    for (const event of scenario.events.filter(event => actionTypes.has(event.type))) {
      assert.equal(await marker(event.id).getAttribute('data-phase'), phaseAt(event, at), `${scenario.id}/${event.id}: phase at ${at}`);
    }
  };
  const assertPauseStable = async message => {
    const before = await snapshot();
    await page.waitForTimeout(220);
    assert.deepEqual(await snapshot(), before, message);
  };
  let scenarioCount = 0, actionCount = 0;
  assert.equal(lessons.length, 9);
  for (const lesson of lessons) {
    await select(lesson.id);
    for (const scenario of lesson.ball.scenarios) {
      scenarioCount++;
      await page.locator(`[data-ball-scenario="${scenario.id}"]`).click();
      assert.equal(await time(), 0);
      const actions = scenario.events.filter(event => actionTypes.has(event.type));
      actionCount += actions.length;
      assert.equal(await page.locator('#field g[data-ball-action]').count(), actions.length, `${lesson.id}/${scenario.id}: every action is visible from the start`);
      const flightIds = await page.locator('#field [data-ball-flight]').evaluateAll(nodes => nodes.map(node => node.dataset.ballFlight).sort());
      assert.deepEqual(flightIds, scenario.events.filter(event => ['snap', 'pass'].includes(event.type)).map(event => event.id).sort(), 'only airborne transfers have a flight path');
      const resolved = resolveBallScenario(lesson, scenario.id);
      for (const event of actions) {
        const item = marker(event.id);
        assert.equal(await item.isVisible(), true);
        assert.equal(await item.getAttribute('role'), 'button');
        assert.equal(await item.getAttribute('tabindex'), '0');
        assert.equal(await item.getAttribute('data-action-type'), event.type);
        assert.equal(Number(await item.getAttribute('data-event-at')), event.at);
        assert.match(await item.locator('text').allTextContents().then(texts => texts.join(' ')), actionText.zh[event.type]);
        const point = id => positionAt(resolved.lesson.players.find(player => player.id === id), event.at, resolved.choices);
        const from = point(event.from);
        const expected = event.type === 'pump-fake' ? from : from.map((value, axis) => (value + point(event.to)[axis]) / 2);
        near(JSON.parse(await item.getAttribute('data-event-position')), expected, `${lesson.id}/${event.id}: marker anchors the actual action, not the formation`);
        const end = event.endAt ?? event.at + .6;
        for (const at of [0, event.at - .01, event.at, (event.at + end) / 2, end, end + .01, 0]) {
          await seek(at);
          await assertPhases(scenario, await time());
        }
        // Click the visible label: a leader line may make the SVG group's bounding-box center empty.
        await item.locator('text').first().click();
        assert.equal(await time(), event.at, 'clicking an action jumps to the action and pauses');
        assert.equal(await page.locator('[data-ball]').getAttribute('data-ball-owner'), event.type === 'handoff' ? event.to : event.from, 'fakes never transfer ownership');
      }
    }
  }
  assert.equal(scenarioCount, 14);

  // Activating a marker while playing must stop playback, including fake actions.
  await select('fake-triple-reverse');
  const triple = lessons.find(lesson => lesson.id === 'fake-triple-reverse').ball.scenarios[0];
  const fake = triple.events.find(event => event.type === 'fake-handoff');
  await page.locator('#play').click();
  await page.waitForFunction(() => Number(document.querySelector('#seek').value) > .1);
  await marker(fake.id).locator('text').first().click();
  assert.equal(await time(), fake.at);
  assert.equal(await page.locator('[data-ball]').getAttribute('data-ball-owner'), fake.from);
  assert.match(await page.locator('#ballStatus').textContent(), /假/u);
  await assertPauseStable('a clicked fake marker pauses both players and ball');

  // Both keyboard activation keys work on true handoff and pump-fake markers.
  await select('hb-option');
  const option = lessons.find(lesson => lesson.id === 'hb-option').ball.scenarios[0];
  for (const event of option.events.filter(event => actionTypes.has(event.type))) {
    for (const key of ['Enter', 'Space']) {
      await seek(0);
      await marker(event.id).focus();
      await page.keyboard.press(key);
      assert.equal(await time(), event.at, `${event.type}: ${key} activates the focused action`);
      assert.equal(await page.locator('[data-ball]').getAttribute('data-ball-owner'), event.type === 'handoff' ? event.to : event.from);
      await assertPauseStable(`${key} leaves the action paused`);
    }
  }

  // Language changes rebuild labels but preserve the paused moment, possession and phases.
  await select('fake-triple-reverse');
  await seek(fake.at);
  const beforeLanguage = await snapshot();
  await page.selectOption('#language', 'en');
  assert.deepEqual(await snapshot(), beforeLanguage);
  assert.match(await page.locator('#ballStatus').textContent(), /fake/i);
  for (const lesson of lessons) {
    await select(lesson.id);
    for (const scenario of lesson.ball.scenarios) {
      await page.locator(`[data-ball-scenario="${scenario.id}"]`).click();
      for (const event of scenario.events.filter(event => actionTypes.has(event.type))) {
        assert.match((await marker(event.id).locator('text').allTextContents()).join(' '), actionText.en[event.type]);
        assert.doesNotMatch(await marker(event.id).textContent(), /[\u3400-\u9fff]/u);
        await seek(event.at);
        assert.doesNotMatch(await page.locator('#ballReadout').textContent(), /[\u3400-\u9fff]/u);
      }
    }
  }

  // Close and open the layer while an action is keyboard-focused; no stale markers may remain.
  await select('hb-option');
  await marker('pump-fake').focus();
  await page.locator('#ballEnabled').uncheck();
  assert.equal(await page.locator('#field [data-ball-action]').count(), 0);
  assert.equal(await page.locator('#field [data-ball-flight]').count(), 0);
  assert.equal(await page.locator('#ballReadout').isVisible(), false);
  await page.locator('#ballEnabled').check();
  assert.equal(await time(), 0);
  assert.equal(await page.locator('#field [data-ball-action]').count(), 2);
  await assertPauseStable('re-enabling ball actions resets and pauses');
  await select('crossbuck');
  await seek(4);
  await page.locator('[data-ball-scenario="give-to-z"]').click();
  assert.equal(await time(), 0);
  assert.equal(await marker('fake-q-z').count(), 0, 'old scenario markers are removed');
  assert.equal(await marker('fake-q-y').count(), 1);
  await assertPauseStable('switching scenarios clears the old event and pauses');

  // Dense action sequences must remain readable at desktop and narrow widths in both languages.
  for (const language of ['zh', 'en']) {
    await page.selectOption('#language', language);
    for (const id of ['fake-triple-reverse', 'double-reverse']) {
      await select(id);
      const source = lessons.find(lesson => lesson.id === id);
      const lastAction = source.ball.scenarios[0].events.filter(event => actionTypes.has(event.type)).at(-1);
      for (const width of [1440, 390]) {
        await page.setViewportSize({width, height: 1050});
        await seek(lastAction.at);
        await page.locator('#field').scrollIntoViewIfNeeded();
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${id}/${language}/${width}: page has no horizontal overflow`);
        const layout = await page.locator('#field').evaluate(field => {
          const rect = node => { const r = node.getBoundingClientRect(); return {left: r.left, top: r.top, right: r.right, bottom: r.bottom}; };
          return {field: rect(field), labels: [...field.querySelectorAll('[data-ball-action]')].map(group => {
            const boxes = [...group.querySelectorAll('text')].map(rect);
            return {id: group.dataset.ballAction, left: Math.min(...boxes.map(b => b.left)), top: Math.min(...boxes.map(b => b.top)), right: Math.max(...boxes.map(b => b.right)), bottom: Math.max(...boxes.map(b => b.bottom))};
          })};
        });
        for (const label of layout.labels) {
          assert.ok(label.left >= layout.field.left - 1 && label.right <= layout.field.right + 1 && label.top >= layout.field.top - 1 && label.bottom <= layout.field.bottom + 1, `${id}/${language}/${width}/${label.id}: action text stays within the visible field`);
        }
        for (let i = 0; i < layout.labels.length; i++) for (let j = i + 1; j < layout.labels.length; j++) {
          const a = layout.labels[i], b = layout.labels[j];
          assert.ok(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top, `${id}/${language}/${width}: action labels ${a.id} and ${b.id} do not overlap`);
        }
        await page.screenshot({path: `${output}/${id}-${language}-${width}.png`, fullPage: true});
      }
    }
  }

  await select('route-hitch');
  assert.equal(await page.locator('#field [data-ball-action]').count(), 0, 'switching to a basic route removes action markers');
  assert.equal(await page.locator('#field [data-ball-flight]').count(), 0);
  assert.equal(await page.locator('#ballReadout').isVisible(), false);
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, [], 'action markers work offline');
  console.log(`PASS ${lessons.length} running plays / ${scenarioCount} scenarios / ${actionCount} actions: true and fake markers, exact action points, phases, pause/seek, keyboard, bilingual labels, layer cleanup, desktop/narrow layout`);
} finally { await browser.close(); }
