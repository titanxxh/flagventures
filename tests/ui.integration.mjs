import assert from 'node:assert/strict';
import {access, mkdir, readFile, writeFile} from 'node:fs/promises';
import {resolve, dirname, join} from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {dump, load} from 'js-yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(root, process.argv[2] || 'dist/腰旗小教练.html');
const output = resolve(root, 'tmp/ui-integration');
const pauseCheckMs = Number(process.env.PAUSE_CHECK_MS || 30000);
await access(target);
await mkdir(output, {recursive: true});

const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROME_EXECUTABLE ? {executablePath: process.env.CHROME_EXECUTABLE} : {channel: 'chrome'}),
});
const context = await browser.newContext({viewport: {width: 1440, height: 1000}, acceptDownloads: true});
const page = await context.newPage();
page.setDefaultTimeout(10000);
const errors = [];
const externalRequests = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
page.on('request', request => {
  if (/^https?:/i.test(request.url())) externalRequests.push(request.url());
});
const results = [];
const samplePackPath = resolve(root, 'content-format/examples.flagbook.json');
const samplePack = JSON.parse(await readFile(samplePackPath, 'utf8'));
const template = load(await readFile(resolve(root, 'content-format/templates/new-play.yaml'), 'utf8'));
const file = (name, value) => ({name, mimeType: 'application/yaml', buffer: Buffer.from(typeof value === 'string' ? value : dump(value))});
const ids = () => page.locator('#catalog [data-lesson]').evaluateAll(nodes => nodes.map(node => node.dataset.lesson));
const currentTime = async () => Number(await page.locator('#seek').inputValue());
const positions = () => page.locator('#field .player').evaluateAll(nodes => nodes.map(node => [node.dataset.player, node.getAttribute('transform')]));
const open = async () => {
  await page.goto(pathToFileURL(target).href, {waitUntil: 'load'});
  await page.locator('#catalog [data-lesson]').first().waitFor();
  assert.ok(!(await page.locator('#lessonTitle').textContent()).includes('检查未通过'));
};
const manage = async () => {
  if (!(await page.locator('#manageDialog').isVisible())) await page.locator('#manage').click();
};
const preview = async input => {
  await manage();
  await page.locator('#fileInput').setInputFiles(input);
  await page.locator('#applyImport').waitFor({state: 'visible'});
};
const importSamples = async () => {
  await preview(samplePackPath);
  await page.locator('#applyImport').click();
  assert.equal((await ids()).length, samplePack.lessons.length);
};
const select = async id => {
  const entry = page.locator(`#catalog [data-lesson="${id}"]`);
  const member = page.locator(`[data-lesson="${id}"]`);
  const section = page.locator('#catalog details.catalog-section').filter({has: member});
  const group = page.locator('#catalog details.catalog-group').filter({has: member});
  for (const ancestor of [section, group]) {
    if (await ancestor.count() && !(await ancestor.evaluate(node => node.open))) {
      await ancestor.locator(':scope > summary').click();
    }
  }
  await entry.click();
};
const caseRun = async (name, fn) => {
  const errorStart = errors.length;
  try {
    await fn();
    assert.deepEqual(errors.slice(errorStart), [], 'browser errors');
    results.push({name, passed: true});
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({name, passed: false, error: error.stack});
    console.error(`FAIL ${name}\n${error.stack}`);
    await page.screenshot({path: join(output, `failure-${results.length}.png`), fullPage: true}).catch(() => {});
  }
};

try {
  await caseRun('file: opens the whole built-in catalog and every entry reconstructs', async () => {
    await open();
    const meta = await page.locator('#builtInData').evaluate(node => {
      const pack = JSON.parse(node.textContent);
      return {entries: pack.lessons.map(item => ({id: item.id, kind: item.kind, count: item.players.length,
        duration: item.timeline.duration, source: item.source?.referenceAsset, sourcePage: item.source?.page,
        choices: item.players.filter(p => p.motion.type === 'choice').map(p => p.id),
        guides: (item.assignments || []).filter(a => a.guide).map(a => ({id: a.id, type: a.type}))})),
      order: pack.sections.flatMap(section => section.lessonIds), assets: pack.assets};
    });
    assert.deepEqual(await ids(), meta.order);
    if (meta.entries.length === 64) {
      const counts = Object.fromEntries(['route', 'formation', 'offense', 'run', 'defense']
        .map(kind => [kind, meta.entries.filter(entry => entry.kind === kind).length]));
      assert.deepEqual(counts, {route: 10, formation: 10, offense: 30, run: 9, defense: 5});
      assert.deepEqual(meta.assets, [], 'the default catalog contains no original images');
      assert.equal(new Set(meta.entries.map(item => item.sourcePage)).size, 56);
    }
    const checkedSources = new Set();
    for (const item of meta.entries) {
      await select(item.id);
      assert.equal(await currentTime(), 0, item.id);
      assert.equal(await page.locator('#field .player').count(), item.count, item.id);
      assert.equal(await page.locator('#play').isDisabled(), item.duration === 0 || item.choices.length > 0, item.id);
      for (const playerId of item.choices) await page.locator(`[data-choice-player="${playerId}"]`).first().click();
      await page.locator('#frames button').last().click();
      const transforms = await positions();
      assert.ok(transforms.every(([, transform]) => transform && !/NaN|Infinity|undefined/.test(transform)), item.id);
      for (const guide of item.guides) {
        const marker = await page.locator(`#field [data-assignment="${guide.id}"] path`).getAttribute('marker-end');
        assert.equal(marker, guide.type === 'matchup' ? null : 'url(#guide-arrow)', `${item.id}: ${guide.type}`);
      }
      if (meta.entries.length === 64) {
        assert.ok(Number.isInteger(item.sourcePage) && item.sourcePage > 0, `${item.id}: source page remains available`);
        assert.equal(item.source, undefined, `${item.id}: no original image reference`);
        assert.equal(await page.locator('#source').isVisible(), false, `${item.id}: original image button is hidden`);
      } else if (item.source) {
        assert.equal(await page.locator('#source').isVisible(), true, item.id);
        if (!checkedSources.has(item.source)) {
          await page.locator('#source').click();
          await page.waitForFunction(() => {
            const image = document.querySelector('#sourceImage');
            return image.complete && image.naturalWidth > 0;
          });
          await page.locator('#sourceDialog [data-close]').click();
          checkedSources.add(item.source);
        }
      }
      await page.locator('#reset').click();
      assert.equal(await currentTime(), 0, item.id);
    }
    await select(meta.order[0]);
    await page.screenshot({path: join(output, 'desktop-initial.png'), fullPage: true});
    results.push({name: 'catalog size', count: meta.entries.length, passed: true});
    if (meta.entries.length === 64) {
      results.push({name: 'built-in entries keep page references and hide original images', count: meta.entries.length, passed: true});
    } else if (checkedSources.size) {
      results.push({name: 'optional reference image loads', count: checkedSources.size, passed: true});
    }
  });

  await caseRun('all four catalog sections collapse, search and follow cross-section navigation without resetting the scene', async () => {
    await open();
    const sections = await page.locator('#builtInData').evaluate(node => JSON.parse(node.textContent).sections);
    assert.deepEqual(sections.map(section => [section.id, section.lessonIds.length]), [
      ['routes', 10], ['offensive-formations', 40], ['run-plays', 9], ['defense', 5],
    ]);
    const sectionNode = id => page.locator(`#catalog details.catalog-section[data-catalog-section="${id}"]`);
    assert.equal(await page.locator('#catalog > details.catalog-section').count(), 4);
    for (const section of sections) {
      const details = sectionNode(section.id);
      const header = details.locator(':scope > summary.section-label');
      assert.equal(await header.count(), 1);
      assert.ok((await header.textContent()).includes(section.title));
      const count = await header.locator('[data-section-count]').textContent();
      assert.equal(Number(count.match(/\d+/)?.[0]), section.lessonIds.length, section.id);
      assert.equal(await details.locator('[data-lesson]').count(), section.lessonIds.length, section.id);
      assert.equal(await details.evaluate(node => node.open), section.id === 'routes', `${section.id}: initial open state`);
    }

    await page.locator('#frames button').last().click();
    const snapshot = {title: await page.locator('#lessonTitle').textContent(), time: await currentTime(),
      positions: await positions(), playState: await page.locator('#playState').textContent()};
    assert.ok(snapshot.time > 0, 'collapse is checked away from the start of the animation');
    const routes = sectionNode('routes');
    const routeHeader = routes.locator(':scope > summary.section-label');
    await routeHeader.focus();
    for (const [key, expanded] of [['Enter', false], ['Space', true], ['Enter', false]]) {
      await page.keyboard.press(key);
      assert.equal(await routes.evaluate(node => node.open), expanded);
      assert.equal(await page.locator('#lessonTitle').textContent(), snapshot.title);
      assert.equal(await currentTime(), snapshot.time);
      assert.deepEqual(await positions(), snapshot.positions);
      assert.equal(await page.locator('#playState').textContent(), snapshot.playState);
    }

    for (const section of sections) {
      await page.locator('#search').fill(section.title);
      assert.deepEqual(await ids(), section.lessonIds, `${section.title}: searching the category includes every child`);
      assert.equal(await page.locator('#catalog > details.catalog-section').count(), 1);
      assert.equal(await sectionNode(section.id).evaluate(node => node.open), true);
      const groups = sectionNode(section.id).locator('details.catalog-group');
      assert.ok((await groups.evaluateAll(nodes => nodes.map(node => node.open))).every(Boolean));
    }
    await page.locator('#search').fill('');
    assert.equal(await routes.evaluate(node => node.open), false, 'manual category collapse survives searching');
    assert.equal(await currentTime(), snapshot.time, 'search does not reset the teaching scene');
    assert.deepEqual(await positions(), snapshot.positions);

    for (let index = 0; index < sections.length - 1; index++) {
      const previousSection = sections[index];
      const nextSection = sections[index + 1];
      await select(previousSection.lessonIds.at(-1));
      const destination = sectionNode(nextSection.id);
      if (await destination.evaluate(node => node.open)) await destination.locator(':scope > summary.section-label').click();
      await page.locator('#next').click();
      assert.equal(await destination.evaluate(node => node.open), true, `${nextSection.id}: next opens its category`);
      const selected = destination.locator('[aria-current="true"]');
      assert.equal(await selected.getAttribute('data-lesson'), nextSection.lessonIds[0]);
      assert.equal(await selected.isVisible(), true, 'navigation opens all ancestors, including a nested formation group');
      await sectionNode(previousSection.id).locator(':scope > summary.section-label').click();
      assert.equal(await sectionNode(previousSection.id).evaluate(node => node.open), false);
      await page.locator('#previous').click();
      assert.equal(await sectionNode(previousSection.id).evaluate(node => node.open), true, `${previousSection.id}: previous reopens its category`);
      const returned = sectionNode(previousSection.id).locator('[aria-current="true"]');
      assert.equal(await returned.getAttribute('data-lesson'), previousSection.lessonIds.at(-1));
      assert.equal(await returned.isVisible(), true);
    }
  });

  await caseRun('formation groups expand, preserve search context and follow next lesson', async () => {
    await open();
    assert.equal(await page.locator('.catalog-group').count(), 10);
    assert.equal(await page.locator('.catalog-group[open]').count(), 0);
    const first = page.locator('[data-catalog-group="single-back-formation"]');
    assert.equal(await first.locator('[data-lesson]').count(), 4);
    const title = await page.locator('#lessonTitle').textContent();
    const offensiveSection = page.locator('#catalog details.catalog-section[data-catalog-section="offensive-formations"]');
    await offensiveSection.locator(':scope > summary.section-label').click();
    await first.locator(':scope > summary').focus();
    await page.keyboard.press('Enter');
    assert.equal(await first.evaluate(node => node.open), true);
    assert.equal(await page.locator('#lessonTitle').textContent(), title);
    await first.locator('[data-lesson="single-back-play-2"]').click();
    assert.match(await page.locator('#breadcrumb').textContent(), /进攻阵型与战术 \/ 单跑卫阵型 \/ 进攻战术/);
    await page.locator('#search').fill('SINGLE BACK PLAY 2');
    assert.equal(await page.locator('.catalog-group').count(), 1);
    assert.deepEqual(await ids(), ['single-back-play-2']);
    assert.equal(await first.evaluate(node => node.open), true);
    await page.locator('#search').fill('');
    assert.equal(await first.evaluate(node => node.open), true);
    await select('single-back-play-3');
    await page.locator('#search').fill('SINGLE BACK PLAY 3');
    await page.locator('#next').click();
    assert.equal(await page.locator('#search').inputValue(), '', 'navigation reveals lessons outside search results');
    const spread = page.locator('[data-catalog-group="spread-formation"]');
    assert.equal(await spread.evaluate(node => node.open), true);
    assert.equal(await spread.locator('[aria-current="true"]').getAttribute('data-lesson'), 'spread-formation');
    await page.locator('#previous').click();
    assert.equal(await first.locator('[aria-current="true"]').getAttribute('data-lesson'), 'single-back-play-3');
    await first.locator(':scope > summary').click();
    await page.locator('#search').fill('不存在的内容');
    assert.equal(await page.locator('.empty-search').count(), 1);
    await page.locator('#search').fill('');
    assert.equal(await first.evaluate(node => node.open), false, 'manual collapse survives searching');
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({width, height: 1000});
      await select('single-back-play-1');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      await page.screenshot({path: join(output, `hierarchy-${width}.png`), fullPage: true});
    }
    await page.setViewportSize({width: 1440, height: 1000});
  });

  await caseRun('official teaching explains roles, preserves conditional releases and links to sources', async () => {
    await open();
    await select('single-back-play-1');
    assert.equal(await page.locator('#teamPlan').isVisible(), true);
    assert.ok((await page.locator('#teamCooperation').textContent()).trim().length > 10);
    assert.equal(await page.locator('#play').isDisabled(), true, 'conditional release requires an explicit scenario');
    assert.equal(await page.locator('#frames [data-frame="1"]').isDisabled(), true);
    await page.locator('#roles [data-player="X"]').hover();
    assert.equal(await page.locator('#routeEnglish').textContent(), 'Post');
    assert.equal(await page.locator('#playerCoaching').isVisible(), true);
    assert.ok((await page.locator('#routeCooperation').textContent()).trim().length > 5);
    const start = Object.fromEntries(await positions());
    await page.locator('[data-choice-player="C"][data-option="released"]').click();
    await page.locator('#frames [data-frame="1"]').click();
    const early = Object.fromEntries(await positions());
    assert.equal(early.C, start.C, 'C waits during the initial teaching interval');
    assert.notEqual(early.X, start.X, 'other receivers have already started');
    await page.locator('#frames button').last().click();
    assert.notEqual(Object.fromEntries(await positions()).C, start.C);
    await page.locator('[data-choice-player="C"][data-option="not-shown"]').click();
    assert.equal(await currentTime(), 0, 'changing the situation resets the whole scene');
    await page.locator('#frames button').last().click();
    assert.equal(Object.fromEntries(await positions()).C, start.C, 'the alternative does not invent a C route');
    assert.equal(await page.locator('#field [data-player-route="C"]').filter({visible: true}).count(), 0, 'no route line is shown for the unknown continuation');
    await page.locator('#roles [data-player="C"]').hover();
    assert.match(await page.locator('#routeSituation').textContent(), /站位/);
    assert.match(await page.locator('[data-choice-note="C"]').textContent(), /站位/);
    await page.locator('.source-notes > summary').click();
    assert.ok(await page.locator('#sourceReferences a[href^="https://www.youtube.com/"]').count() > 0);
    assert.ok(await page.locator('#sourceReferences a[href^="https://nflflag.com/"]').count() > 0);
    for (const width of [1440, 390]) {
      await page.setViewportSize({width, height: 1000});
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      await page.screenshot({path: join(output, `official-teaching-${width}.png`), fullPage: true});
    }
    await page.setViewportSize({width: 1440, height: 1000});
    await select('i-formation-play-2');
    const iStart = Object.fromEntries(await positions());
    await page.locator('#frames [data-frame="1"]').click();
    const iEarly = Object.fromEntries(await positions());
    assert.equal(iEarly.Z, iStart.Z);
    assert.notEqual(iEarly.X, iStart.X);
    await select('route-post');
    assert.equal(await page.locator('#teamPlan').isVisible(), false, 'legacy lessons need no new fields');
    assert.equal(await page.locator('#playerCoaching').isVisible(), false);
    assert.equal(await page.locator('#sourceReferences').isVisible(), false);
  });

  await caseRun('keyframes pause the whole scene and resume at the chosen time', async () => {
    await importSamples();
    await select('single-back-play-1');
    await page.locator('[data-choice-player="C"][data-option="released"]').click();
    await page.locator('#play').click();
    await page.waitForFunction(() => Number(document.querySelector('#seek').value) > 0.2);
    await page.locator('#frames [data-frame="2"]').click();
    const pausedTime = await currentTime();
    assert.equal(pausedTime, 5.5);
    const pausedPositions = await positions();
    await page.waitForTimeout(pauseCheckMs);
    assert.equal(await currentTime(), pausedTime);
    assert.deepEqual(await positions(), pausedPositions);
    await page.locator('#frames [data-frame="2"]').click();
    assert.deepEqual(await positions(), pausedPositions);
    await page.locator('#play').click();
    await page.waitForFunction(time => Number(document.querySelector('#seek').value) > time + .1, pausedTime);
    assert.ok((await currentTime()) < 6.5, 'continuation starts near the selected frame');
    await page.locator('#frames [data-frame="1"]').click();
    assert.equal(await currentTime(), 2);
    assert.match(await page.locator('#play').textContent(), /继续/);
  });

  await caseRun('hover, keyboard focus and pinned roles do not move a paused scene', async () => {
    await select('single-back-play-1');
    await page.locator('[data-choice-player="C"][data-option="released"]').click();
    await page.locator('#frames [data-frame="1"]').click();
    const before = await positions();
    const x = page.locator('#field [data-player="X"]');
    await x.hover();
    assert.match(await page.locator('#routeEnglish').textContent(), /Post/);
    assert.equal(await currentTime(), 2);
    await page.locator('#roles [data-player="C"]').focus();
    assert.equal(await page.locator('#routePerson').textContent(), 'C');
    assert.match(await page.locator('#routeEnglish').textContent(), /Corner/);
    await page.locator('#roles [data-player="X"]').click();
    await page.locator('#summary').click();
    assert.equal(await page.locator('#routePerson').textContent(), 'X');
    await page.locator('#roles [data-player="Y"]').hover();
    assert.equal(await page.locator('#routePerson').textContent(), 'Y');
    await page.locator('#summary').hover();
    assert.equal(await page.locator('#routePerson').textContent(), 'X');
    assert.deepEqual(await positions(), before);
    assert.equal(await currentTime(), 2);
    await page.screenshot({path: join(output, 'desktop-keyframe-hover.png'), fullPage: true});
    await page.locator('#play').click();
    await page.waitForFunction(() => Number(document.querySelector('#seek').value) > 2.1);
    const advancingTime = await currentTime();
    await page.locator('#roles [data-player="Y"]').hover();
    assert.match(await page.locator('#playState').textContent(), /演示中/);
    assert.ok((await currentTime()) >= advancingTime);
    await page.locator('#frames [data-frame="1"]').click();
  });

  await caseRun('choice gating and route switches remain explicit and reset playback', async () => {
    await select('route-variants-format-demo');
    assert.equal(await page.locator('#play').isDisabled(), true);
    assert.equal(await page.locator('#frames [data-frame="1"]').isDisabled(), true);
    assert.equal(await page.locator('#field .route').count(), 2);
    await page.locator('[data-option="left-pause"]').click();
    assert.equal(await page.locator('#play').isDisabled(), false);
    await page.locator('#roles [data-player="X"]').hover();
    assert.match(await page.locator('#routeSituation').textContent(), /本次演示/);
    await page.locator('#frames [data-frame="1"]').click();
    const pauseStart = await positions();
    await page.locator('#play').click();
    await page.waitForFunction(() => Number(document.querySelector('#seek').value) > 3.4);
    await page.locator('#play').click();
    assert.deepEqual(await positions(), pauseStart, 'explicit pause retains position while time advances');
    await page.locator('[data-option="right-cubic"]').click();
    assert.equal(await currentTime(), 0);
    assert.match(await page.locator('#playState').textContent(), /暂停/);
    await select('cover-2');
    await select('route-variants-format-demo');
    assert.equal(await page.locator('#play').isDisabled(), true, 'switching entry clears choices');
  });

  await caseRun('defense view filters are reconstructed without moving defenders', async () => {
    await select('cover-2');
    const start = await positions();
    const visibleZones = () => page.locator('#field [data-zone]').evaluateAll(nodes =>
      nodes.filter(node => getComputedStyle(node).display !== 'none').map(node => node.dataset.zone));
    assert.deepEqual(await visibleZones(), []);
    await page.locator('#frames [data-frame="1"]').click();
    const front = await visibleZones();
    assert.equal(front.length, 2);
    await page.locator('#frames [data-frame="3"]').click();
    assert.equal((await visibleZones()).length, 4);
    await page.locator('#frames [data-frame="1"]').click();
    assert.deepEqual(await visibleZones(), front);
    assert.deepEqual(await positions(), start);
    await page.screenshot({path: join(output, 'desktop-defense.png'), fullPage: true});
  });

  await caseRun('YAML import is atomic, cancellable and treats text as text', async () => {
    const beforeIds = await ids();
    const custom = structuredClone(template);
    custom.id = 'ui-import-check';
    custom.title.zh = '本地 <img src=x onerror="window.injected=true"> 战术';
    await manage();
    await page.locator('#fileInput').setInputFiles([file('valid.yaml', custom), file('bad.yaml', 'format: [')]);
    await page.locator('#importReport.error').waitFor();
    assert.deepEqual(await ids(), beforeIds);
    assert.equal(await page.locator('#applyImport').isVisible(), false);
    await preview([file('custom.yaml', custom)]);
    await page.locator('#cancelImport').click();
    assert.deepEqual(await ids(), beforeIds);
    await preview([file('custom.yaml', custom)]);
    await page.locator('#applyImport').click();
    assert.equal((await ids()).length, beforeIds.length + 1);
    assert.equal(await page.locator('#lessonTitle').textContent(), custom.title.zh);
    assert.equal(await page.locator('#lessonTitle img').count(), 0);
    assert.equal(await page.evaluate(() => window.injected), undefined);
    assert.equal(await page.locator('#source').isVisible(), false);
    custom.title.zh = '已更新的自编战术';
    await preview([file('updated.yaml', custom)]);
    assert.match(await page.locator('#importReport').textContent(), /更新 1/);
    await page.locator('#applyImport').click();
    assert.equal((await ids()).length, beforeIds.length + 1);
    assert.equal((await ids()).at(-1), custom.id);
    assert.equal(await page.locator('#lessonTitle').textContent(), custom.title.zh);
  });

  await caseRun('downloaded content package survives closing and reopening file:', async () => {
    const expectedIds = await ids();
    await manage();
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#exportPack').click();
    const download = await downloadPromise;
    const saved = join(output, 'roundtrip.flagbook.json');
    await download.saveAs(saved);
    const exported = JSON.parse(await readFile(saved, 'utf8'));
    assert.deepEqual(exported.sections.flatMap(section => section.lessonIds), expectedIds);
    assert.equal(Object.hasOwn(exported, 'progress'), false);
    assert.equal(Object.hasOwn(exported, 'choices'), false);
    await open();
    await preview(saved);
    await page.locator('#applyImport').click();
    assert.deepEqual(await ids(), expectedIds);
    await select('ui-import-check');
    assert.equal(await page.locator('#lessonTitle').textContent(), '已更新的自编战术');
    await manage();
    const secondPromise = page.waitForEvent('download');
    await page.locator('#exportPack').click();
    const second = await secondPromise;
    const savedAgain = join(output, 'roundtrip-again.flagbook.json');
    await second.saveAs(savedAgain);
    assert.deepEqual(JSON.parse(await readFile(savedAgain, 'utf8')), exported);
    await page.locator('#manageDialog [data-close]').click();
  });

  await caseRun('valid empty content package clears old teaching content and can recover', async () => {
    await preview({name: 'empty.flagbook.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({format: 'flag-playbook', version: 1, title: '空内容包', lessons: [], sections: []}))});
    await page.locator('#applyImport').click();
    assert.equal((await ids()).length, 0);
    assert.equal(await page.locator('#field .player').count(), 0);
    for (const id of ['play', 'reset', 'seek', 'previous', 'next']) assert.equal(await page.locator(`#${id}`).isDisabled(), true, id);
    await manage();
    assert.equal(await page.locator('#exportLesson').isDisabled(), true);
    await page.locator('#restore').click();
    assert.ok((await ids()).length > 0);
    assert.equal(await page.locator('#exportLesson').isDisabled(), false);
  });

  await caseRun('valid player ID all does not collide with the whole-team control', async () => {
    const custom = structuredClone(template);
    custom.id = 'all-player-check';
    custom.players.find(player => player.id === 'X').id = 'all';
    await preview([file('all-player.yaml', custom)]);
    await page.locator('#applyImport').click();
    await page.locator('#field [data-player="all"]').click();
    assert.equal(await page.locator('#routePerson').textContent(), 'all');
    assert.equal(await page.locator('#field [data-player="Q"]').getAttribute('opacity'), '0.53');
    await page.getByRole('button', {name: '看全队', exact: true}).click();
    assert.equal(await page.locator('#field [data-player="Q"]').getAttribute('opacity'), '1');
  });

  await caseRun('a slower earlier file read cannot overwrite a later import preview', async () => {
    await page.evaluate(() => {
      const original = File.prototype.text;
      window.restoreFileText = () => { File.prototype.text = original; delete window.restoreFileText; };
      File.prototype.text = async function () {
        if (this.name === 'slow.yaml') await new Promise(resolve => setTimeout(resolve, 600));
        return original.call(this);
      };
    });
    try {
      const slow = {...structuredClone(template), id: 'slow-import-check', title: {zh: '较早但较慢'}};
      const fast = {...structuredClone(template), id: 'fast-import-check', title: {zh: '最后选中的文件'}};
      await manage();
      await page.locator('#fileInput').setInputFiles([file('slow.yaml', slow)]);
      await preview([file('fast.yaml', fast)]);
      await page.waitForTimeout(800);
      const report = await page.locator('#importReport').textContent();
      assert.match(report, /最后选中的文件/);
      assert.doesNotMatch(report, /较早但较慢/);
      await page.locator('#applyImport').click();
      assert.ok((await ids()).includes('fast-import-check'));
      assert.ok(!(await ids()).includes('slow-import-check'));
    } finally { await page.evaluate(() => window.restoreFileText()); }
  });

  await caseRun('narrow windows keep controls within the viewport', async () => {
    await importSamples();
    await select('single-back-play-1');
    for (const width of [1024, 768, 390]) {
      await page.setViewportSize({width, height: 900});
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `${width}px`);
      await page.screenshot({path: join(output, `viewport-${width}.png`), fullPage: true});
    }
    await page.setViewportSize({width: 1440, height: 1000});
    assert.deepEqual(externalRequests, [], 'local teaching must not request remote resources');
  });
} finally {
  await writeFile(join(output, 'results.json'), JSON.stringify({target, pauseCheckMs, results, browserErrors: errors, externalRequests}, null, 2));
  await browser.close();
}
if (results.some(result => !result.passed)) process.exitCode = 1;
