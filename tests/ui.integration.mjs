import assert from 'node:assert/strict';
import {access, mkdir, readFile, writeFile} from 'node:fs/promises';
import {resolve, dirname, join} from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {dump, load} from 'js-yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(root, process.argv[2] || 'dist/Flagventures.html');
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
  await page.locator('#catalog [data-lesson]').first().waitFor({state: 'attached'});
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
  // Tablets and phones keep the catalog in a drawer.
  if (await page.locator('#catalogToggle').isVisible() && !(await page.locator('body.catalog-open').count())) {
    await page.locator('#catalogToggle').click();
  }
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
        duration: item.timeline.duration, ball: Boolean(item.ball), source: item.source?.referenceAsset, sourcePage: item.source?.page,
        choices: item.players.filter(p => p.motion.type === 'choice').map(p => p.id),
        guides: (item.assignments || []).filter(a => a.guide).map(a => ({id: a.id, type: a.type}))})),
      order: pack.sections.flatMap(section => section.lessonIds), assets: pack.assets};
    });
    assert.deepEqual(await ids(), meta.order);
    if (meta.entries.length === 65) {
      const counts = Object.fromEntries(['route', 'formation', 'offense', 'run', 'defense']
        .map(kind => [kind, meta.entries.filter(entry => entry.kind === kind).length]));
      assert.deepEqual(counts, {route: 11, formation: 10, offense: 30, run: 9, defense: 5});
      assert.deepEqual(meta.assets, [], 'the default catalog contains no original images');
      assert.equal(new Set(meta.entries.filter(item => item.id !== 'route-in').map(item => item.sourcePage)).size, 56);
    }
    const checkedSources = new Set();
    for (const item of meta.entries) {
      await select(item.id);
      assert.equal(await currentTime(), 0, item.id);
      assert.equal(await page.locator('#field .player').count(), item.count, item.id);
      assert.equal(await page.locator('#play').isDisabled(), item.duration === 0 || (!item.ball && item.choices.length > 0), item.id);
      for (const playerId of item.ball ? [] : item.choices) await page.locator(`[data-choice-player="${playerId}"]`).first().click();
      await page.locator('#frames button').last().click();
      const transforms = await positions();
      assert.ok(transforms.every(([, transform]) => transform && !/NaN|Infinity|undefined/.test(transform)), item.id);
      for (const guide of item.guides) {
        const marker = await page.locator(`#field [data-assignment="${guide.id}"] path`).getAttribute('marker-end');
        assert.equal(marker, guide.type === 'matchup' ? null : 'url(#guide-arrow)', `${item.id}: ${guide.type}`);
      }
      if (meta.entries.length === 65) {
        if (item.id === 'route-in') assert.equal(item.sourcePage, undefined, 'supplemental In has no invented PDF page');
        else assert.ok(Number.isInteger(item.sourcePage) && item.sourcePage > 0, `${item.id}: source page remains available`);
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
    if (meta.entries.length === 65) {
      results.push({name: 'source entries keep page references; supplemental In and all entries omit original images', count: meta.entries.length, passed: true});
    } else if (checkedSources.size) {
      results.push({name: 'optional reference image loads', count: checkedSources.size, passed: true});
    }
  });

  await caseRun('every catalog section collapses, search and follow cross-section navigation without resetting the scene', async () => {
    await open();
    const sections = await page.locator('#builtInData').evaluate(node => JSON.parse(node.textContent).sections);
    assert.deepEqual(sections.map(section => [section.id, section.lessonIds.length]), [
      ['routes', 11], ['offensive-formations', 40], ['run-plays', 9], ['defense', 5], ['passing-concepts', 6],
    ]);
    const sectionNode = id => page.locator(`#catalog details.catalog-section[data-catalog-section="${id}"]`);
    assert.equal(await page.locator('#catalog > details.catalog-section').count(), sections.length);
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
    assert.equal(await page.locator('.catalog-group').count(), 13);
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
    await page.locator('#ballEnabled').uncheck();
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
    assert.equal(await page.locator('#teamPlan').isVisible(), true, 'basic route instructions are always visible');
    assert.ok((await page.locator('#teamCooperation').textContent()).trim().length > 10);
    await select('single-back-formation');
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

  await caseRun('the address remembers the lesson and opens shared links', async () => {
    // Leave the document first: a same-file link with a new fragment would not reload it.
    await page.goto('about:blank');
    await page.goto(`${pathToFileURL(target).href}#lesson=cover-2`, {waitUntil: 'load'});
    await page.locator('#catalog [data-lesson]').first().waitFor({state: 'attached'});
    const lessons = await page.locator('#builtInData').evaluate(node => JSON.parse(node.textContent).lessons.map(item => [item.id, item.title.zh]));
    const title = id => lessons.find(([lessonId]) => lessonId === id)[1];
    assert.equal(await page.locator('#lessonTitle').textContent(), title('cover-2'));
    assert.equal(await page.locator('[aria-current="true"]').getAttribute('data-lesson'), 'cover-2');
    await select('hb-dive');
    assert.equal(new URL(page.url()).hash, '#lesson=hb-dive');
    await page.evaluate(() => { location.hash = '#lesson=route-post'; });
    await page.waitForFunction(expected => document.querySelector('#lessonTitle').textContent === expected, title('route-post'));
    await page.reload();
    assert.equal(await page.locator('#lessonTitle').textContent(), title('route-post'), 'a refresh returns to the same lesson');
    await page.evaluate(() => { location.hash = '#lesson=not-a-lesson'; });
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#lessonTitle').textContent(), title('route-post'), 'unknown links leave the current lesson alone');
    await open();
    assert.equal(await page.locator('[aria-current="true"]').getAttribute('data-lesson'), lessons[0][0], 'without a link the first lesson opens');
  });

  await caseRun('the catalog scrolls to follow the selected lesson', async () => {
    await page.setViewportSize({width: 1440, height: 800});
    await open();
    const order = await ids();
    const visibleInCatalog = () => page.locator('#catalog [aria-current="true"]').evaluate(entry => {
      const box = entry.getBoundingClientRect(), view = document.querySelector('#catalog').getBoundingClientRect();
      return box.top >= view.top - 1 && box.bottom <= view.bottom + 1;
    });
    for (let index = 0; index < order.length - 1; index += 7) {
      await page.evaluate(id => { location.hash = `#lesson=${id}`; }, order[index]);
      await page.waitForFunction(id => document.querySelector('#catalog [aria-current="true"]')?.dataset.lesson === id, order[index]);
      assert.equal(await visibleInCatalog(), true, `${order[index]} is scrolled into the catalog`);
      assert.equal(await page.evaluate(() => scrollY), 0, 'following the catalog never scrolls the page');
    }
    await select(order.at(-2));
    await page.locator('#next').click();
    assert.equal(await visibleInCatalog(), true, 'next keeps the catalog in step');
    await page.setViewportSize({width: 1440, height: 1000});
  });

  await caseRun('keyboard shortcuts drive playback without hijacking focused controls', async () => {
    await open();
    await select('spread-play-1');
    assert.ok(await page.locator('#frames [data-frame]').count() > 2);
    await page.locator('#summary').click();
    await page.keyboard.press('Space');
    await page.waitForFunction(() => Number(document.querySelector('#seek').value) > .05);
    assert.match(await page.locator('#playState').textContent(), /演示中/);
    await page.keyboard.press('Space');
    assert.match(await page.locator('#playState').textContent(), /暂停/);
    await page.keyboard.press('0');
    assert.equal(await currentTime(), 0);
    const pressed = () => page.locator('#frames [aria-pressed="true"]').getAttribute('data-frame');
    await page.keyboard.press('ArrowRight');
    assert.equal(await pressed(), '1');
    const first = await currentTime();
    assert.ok(first > 0);
    await page.keyboard.press('ArrowRight');
    assert.equal(await pressed(), '2');
    assert.ok(await currentTime() > first);
    await page.keyboard.press('ArrowLeft');
    assert.equal(await pressed(), '1');
    assert.equal(await currentTime(), first);
    assert.match(await page.locator('#playState').textContent(), /暂停/, 'stepping pauses playback');
    for (const [key, speed] of [['1', '0.5'], ['4', '3'], ['3', '2']]) {
      await page.keyboard.press(key);
      assert.equal(await page.locator(`[data-speed="${speed}"]`).getAttribute('aria-pressed'), 'true', `key ${key}`);
    }
    await page.locator('#reset').focus();
    await page.keyboard.press('Space');
    assert.equal(await currentTime(), 0, 'Space on a focused button activates that button');
    assert.match(await page.locator('#playState').textContent(), /暂停/, 'and does not also start playback');
    await page.locator('#search').focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.type('1');
    assert.equal(await currentTime(), 0, 'typing in search never seeks');
    assert.equal(await page.locator('[data-speed="2"]').getAttribute('aria-pressed'), 'true', 'typing in search never changes speed');
    await page.locator('#search').fill('');
    await page.locator('#summary').click();
    await page.keyboard.press(']');
    assert.match(await page.locator('#lessonTitle').textContent(), /第 2 号战术/, '] opens the next lesson');
    await page.keyboard.press('[');
    assert.match(await page.locator('#lessonTitle').textContent(), /第 1 号战术/, '[ opens the previous lesson');
  });

  await caseRun('on a 1440×900 screen the field, caption and controls fit without scrolling', async () => {
    await page.setViewportSize({width: 1440, height: 900});
    for (const id of ['spread-play-1', 'route-hitch', 'cover-2', 'hb-dive', 'single-back-formation']) {
      await open();
      await select(id);
      const layout = await page.evaluate(() => ({
        field: document.querySelector('#field').getBoundingClientRect().toJSON(),
        play: document.querySelector('#play').getBoundingClientRect().toJSON(),
        cue: document.querySelector('.cue').getBoundingClientRect().toJSON(),
        scrollY,
      }));
      assert.equal(layout.scrollY, 0, id);
      assert.ok(layout.play.bottom <= 900 && layout.cue.bottom <= 900, `${id}: controls are in the first screen (${Math.round(layout.play.bottom)})`);
      assert.ok(layout.field.height >= 300, `${id}: field stays at least 300px tall (${Math.round(layout.field.height)})`);
    }
    await page.setViewportSize({width: 1440, height: 1000});
  });

  await caseRun('phones use a catalog drawer, a full-width field and large touch targets', async () => {
    await open();
    await page.setViewportSize({width: 390, height: 844});
    const library = page.locator('#library');
    await library.waitFor({state: 'hidden'});
    assert.equal(await page.locator('#catalogToggle').getAttribute('aria-expanded'), 'false');
    await page.locator('#catalogToggle').click();
    assert.equal(await page.locator('#library').isVisible(), true);
    assert.equal(await page.locator('#catalogToggle').getAttribute('aria-expanded'), 'true');
    await page.keyboard.press('Escape');
    await library.waitFor({state: 'hidden'});
    assert.equal(await page.evaluate(() => document.activeElement.id), 'catalogToggle', 'focus returns to the menu button');
    await select('spread-play-1');
    await library.waitFor({state: 'hidden'});
    assert.match(await page.locator('#lessonTitle').textContent(), /分散阵型/);
    await page.locator('#catalogToggle').click();
    await page.locator('#catalogBackdrop').click({position: {x: 370, y: 400}});
    await library.waitFor({state: 'hidden'});
    const sizes = await page.evaluate(() => ({
      field: document.querySelector('#field').getBoundingClientRect().width,
      player: document.querySelector('#field .player circle:last-child').getBoundingClientRect().width,
      header: document.querySelector('.app-header').getBoundingClientRect().height,
      overflow: document.documentElement.scrollWidth - innerWidth,
    }));
    assert.equal(Math.round(sizes.field), 390, 'the field uses the full screen width');
    assert.ok(sizes.player >= 30, `players are easy to tap (${sizes.player.toFixed(1)}px)`);
    assert.ok(sizes.header <= 64, 'the header stays on one row');
    assert.ok(sizes.overflow <= 1, 'no horizontal scrolling');
    await page.screenshot({path: join(output, 'phone-board.png'), fullPage: true});
    await page.setViewportSize({width: 1024, height: 900});
    assert.equal(await page.locator('#catalogToggle').isVisible(), false, 'desktop shows the catalog inline');
    assert.equal(await page.locator('#library').isVisible(), true);
    await page.setViewportSize({width: 1440, height: 1000});
  });

  await caseRun('a paused lesson requests no animation frames', async () => {
    await open();
    await select('spread-play-1');
    await page.evaluate(() => {
      window.frameRequests = 0;
      const request = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = callback => { window.frameRequests++; return request(callback); };
    });
    await page.waitForTimeout(800);
    assert.equal(await page.evaluate(() => window.frameRequests), 0, 'idle pages stay idle');
    await page.locator('#play').click();
    await page.waitForFunction(() => window.frameRequests > 10);
    await page.locator('#play').click();
    const stopped = await page.evaluate(() => window.frameRequests);
    await page.waitForTimeout(500);
    assert.ok(await page.evaluate(() => window.frameRequests) <= stopped + 1, 'pausing stops the frame loop');
    await page.locator('#seek').evaluate(range => { range.value = 9.9; range.dispatchEvent(new Event('input', {bubbles: true})); });
    await page.locator('#play').click();
    await page.waitForFunction(() => document.querySelector('#play').textContent.includes('再看一遍'));
    const ended = await page.evaluate(() => window.frameRequests);
    await page.waitForTimeout(400);
    assert.ok(await page.evaluate(() => window.frameRequests) <= ended + 1, 'reaching the end stops the frame loop');
  });

  await caseRun('Back returns to the previous lesson and the tab title names the lesson', async () => {
    await open();
    const titles = await page.locator('#builtInData').evaluate(node => Object.fromEntries(JSON.parse(node.textContent).lessons.map(item => [item.id, item.title.zh])));
    await select('spread-play-1');
    assert.equal(await page.title(), `${titles['spread-play-1']} · Flagventures`);
    await page.locator('#headNext').click();
    await page.locator('#next').click();
    await page.locator('[data-lesson="cover-2"]').evaluate(entry => entry.click());
    assert.equal(await page.title(), `${titles['cover-2']} · Flagventures`);
    for (const id of ['spread-play-3', 'spread-play-2', 'spread-play-1']) {
      await page.goBack();
      await page.waitForFunction(expected => document.querySelector('#lessonTitle').textContent === expected, titles[id]);
      assert.equal(new URL(page.url()).hash, `#lesson=${id}`);
    }
    await page.goForward();
    await page.waitForFunction(expected => document.querySelector('#lessonTitle').textContent === expected, titles['spread-play-2']);
    await page.locator('#language').selectOption('en');
    assert.doesNotMatch(await page.title(), /[㐀-鿿]/u, 'the title follows the language');
    await page.locator('#language').selectOption('zh');
  });

  await caseRun('the heading pager matches the footer and stops at both ends', async () => {
    await open();
    const order = await ids();
    assert.equal(await page.locator('#headIndex').textContent(), `1 / ${order.length}`);
    assert.equal(await page.locator('#headPrevious').isDisabled(), true);
    await page.locator('#headNext').click();
    assert.equal(await page.locator('[aria-current="true"]').getAttribute('data-lesson'), order[1]);
    assert.equal(await page.locator('#headIndex').textContent(), await page.locator('#lessonIndex').textContent());
    await select(order.at(-1));
    assert.equal(await page.locator('#headNext').isDisabled(), true);
    await page.locator('#headPrevious').click();
    assert.equal(await page.locator('[aria-current="true"]').getAttribute('data-lesson'), order.at(-2));
  });

  await caseRun('turning the ball layer off leaves no pass target looking selected', async () => {
    await open();
    await select('spread-play-1');
    assert.equal(await page.locator('[data-ball-scenario][aria-pressed="true"]').count(), 1);
    await page.locator('#ballEnabled').uncheck();
    assert.equal(await page.locator('[data-ball-scenario][aria-pressed="true"]').count(), 0);
    assert.equal(await page.locator('[data-ball-scenario]:not([disabled])').count(), 0);
    await page.locator('#ballEnabled').check();
    assert.equal(await page.locator('[data-ball-scenario][aria-pressed="true"]').count(), 1);
  });

  await caseRun('tablets and English phones keep the controls compact', async () => {
    await page.setViewportSize({width: 1024, height: 768});
    await open();
    await select('spread-play-2');
    const tablet = await page.evaluate(() => ({
      play: document.querySelector('#play').getBoundingClientRect().bottom,
      toggle: document.querySelector('.ball-toggle').getBoundingClientRect().top,
      heading: document.querySelector('#ballChoiceHeading').getBoundingClientRect().top,
    }));
    assert.ok(tablet.play <= 768, `1024×768: play button is in the first screen (${Math.round(tablet.play)})`);
    assert.ok(Math.abs(tablet.toggle - tablet.heading) < 12, 'the ball toggle shares the heading row');
    await page.setViewportSize({width: 390, height: 844});
    await page.selectOption('#language', 'en');
    const phone = await page.evaluate(() => ({play: document.querySelector('#play').getBoundingClientRect().top, speed: document.querySelector('.speed').getBoundingClientRect().top}));
    assert.ok(Math.abs(phone.play - phone.speed) < 8, 'English play, reset and speed fit on one row');
    await page.selectOption('#language', 'zh');
    await page.setViewportSize({width: 1440, height: 1000});
  });

  await caseRun('the printed handout shows the field, every keyframe and the talking points', async () => {
    await open();
    await select('spread-play-1');
    await page.evaluate(() => { window.printed = 0; window.print = () => { window.printed++; }; });
    await page.locator('#printLesson').click();
    assert.equal(await page.evaluate(() => window.printed), 1);
    const frames = await page.locator('#frames [data-frame]').count();
    await page.emulateMedia({media: 'print'});
    try {
      for (const selector of ['.app-header', '.library', '.controls', '#frames', '.lesson-actions']) {
        assert.equal(await page.locator(selector).isVisible(), false, `${selector} is not printed`);
      }
      for (const selector of ['#lessonTitle', '#field', '#printFrames', '.team-plan', '.mini-lesson']) {
        assert.equal(await page.locator(selector).isVisible(), true, `${selector} is printed`);
      }
      assert.equal(await page.locator('#printFrames li').count(), frames);
      assert.ok((await page.locator('#printFrames li').last().textContent()).length > 6);
      await page.screenshot({path: join(output, 'print-handout.png'), fullPage: true});
    } finally { await page.emulateMedia({media: 'screen'}); }
  });

  await caseRun('full screen keeps field, caption and controls together on a sideways phone', async () => {
    await page.setViewportSize({width: 844, height: 390});
    await open();
    await select('spread-play-1');
    await page.locator('#fullscreen').click();
    const layout = await page.evaluate(() => ({
      board: document.querySelector('.board').getBoundingClientRect().toJSON(),
      field: document.querySelector('#field').getBoundingClientRect().height,
      play: document.querySelector('#play').getBoundingClientRect().bottom,
      cue: document.querySelector('.cue').getBoundingClientRect().top,
    }));
    assert.deepEqual([layout.board.x, layout.board.y, layout.board.width, layout.board.height], [0, 0, 844, 390]);
    assert.ok(layout.play <= 390 && layout.cue < 390, 'caption and controls stay on screen');
    assert.ok(layout.field >= 200, `field keeps a usable height (${Math.round(layout.field)})`);
    assert.equal(await page.locator('#fullscreen').getAttribute('aria-pressed'), 'true');
    await page.locator('#play').click();
    await page.waitForFunction(() => Number(document.querySelector('#seek').value) > .1);
    await page.locator('#play').click();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.board.board-fullscreen').count(), 0, 'Escape leaves full screen');
    assert.equal(await page.locator('#fullscreen').getAttribute('aria-pressed'), 'false');
    await page.locator('#summary').click();
    await page.keyboard.press('f');
    assert.equal(await page.locator('.board.board-fullscreen').count(), 1, 'F enters full screen');
    await page.locator('#fullscreen').click();
    assert.equal(await page.locator('.board.board-fullscreen').count(), 0);
    await page.setViewportSize({width: 1440, height: 1000});
  });

  await caseRun('headings are never empty, search shows focus and phone touch targets are at least 24px', async () => {
    await open();
    for (const id of ['route-hitch', 'spread-play-1', 'cover-2', 'hb-option']) {
      await select(id);
      for (const player of await page.locator('#roles [data-player]').evaluateAll(nodes => nodes.map(node => node.dataset.player))) {
        await page.locator(`#roles [data-player="${player}"]`).click();
        const empty = await page.evaluate(() => [...document.querySelectorAll('h1, h2, h3, h4')]
          .filter(heading => heading.getClientRects().length && !heading.textContent.trim()).map(heading => heading.id || heading.className));
        assert.deepEqual(empty, [], `${id}/${player}`);
      }
    }
    await page.locator('#search').focus();
    assert.notEqual(await page.locator('.search').evaluate(node => getComputedStyle(node).boxShadow), 'none', 'search shows a focus ring');
    await page.setViewportSize({width: 390, height: 844});
    await select('route-option');
    await page.locator('.source-menu > summary').click();
    await page.locator('#sourceDetails > summary').click();
    const small = await page.evaluate(() => [...document.querySelectorAll('button, a[href], input, select, summary, [role="button"]')]
      .filter(node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden' && !node.closest('dialog:not([open]), #library, p'))
      .map(node => ({name: node.id || node.textContent.trim().slice(0, 20), height: node.getBoundingClientRect().height}))
      .filter(item => item.height < 24));
    assert.deepEqual(small, [], 'every standalone control is at least 24px tall');
    await page.setViewportSize({width: 1440, height: 1000});
  });

  await caseRun('the built-in safety check still reports broken content after the first lesson shows', async () => {
    const html = await readFile(target, 'utf8');
    const marker = '<script type="application/json" id="builtInData">';
    const start = html.indexOf(marker) + marker.length;
    const end = html.indexOf('</script>', start);
    const pack = JSON.parse(html.slice(start, end));
    pack.sections.push(structuredClone(pack.sections.at(-1)));
    const broken = html.slice(0, start) + JSON.stringify(pack).replaceAll('<', '\\u003c') + html.slice(end);
    const brokenPath = join(output, 'broken-built-in.html');
    await writeFile(brokenPath, broken);
    const errorsBefore = errors.length;
    await page.goto(pathToFileURL(brokenPath).href, {waitUntil: 'load'});
    await page.waitForFunction(() => document.querySelector('#lessonTitle').textContent.includes('检查未通过'));
    assert.match(await page.locator('#summary').textContent(), /sections|章节|重复|duplicate/i);
    errors.splice(errorsBefore);
  });

  await caseRun('the line-of-scrimmage caption never covers a player in either language', async () => {
    await page.setViewportSize({width: 1440, height: 1000});
    await open();
    const ids = await page.locator('#builtInData').evaluate(node => JSON.parse(node.textContent).lessons.map(item => item.id));
    for (const language of ['zh', 'en']) {
      await page.selectOption('#language', language);
      for (const id of ids) {
        await page.evaluate(id => { location.hash = `#lesson=${id}`; }, id);
        await page.waitForFunction(id => document.querySelector('#catalog [aria-current="true"]')?.dataset.lesson === id, id);
        const overlaps = await page.locator('#field').evaluate(field => {
          const label = field.querySelector('[data-scrimmage-label]');
          if (!label) return [];
          const a = label.getBoundingClientRect();
          return [...field.querySelectorAll('.player')].filter(player => {
            const b = player.querySelector('circle:not(.focus-ring), rect, path').getBoundingClientRect();
            return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
          }).map(player => player.dataset.player);
        });
        assert.deepEqual(overlaps, [], `${language}/${id}`);
      }
    }
    await page.selectOption('#language', 'zh');
  });
} finally {
  await writeFile(join(output, 'results.json'), JSON.stringify({target, pauseCheckMs, results, browserErrors: errors, externalRequests}, null, 2));
  await browser.close();
}
if (results.some(result => !result.passed)) process.exitCode = 1;
