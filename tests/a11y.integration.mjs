import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright';

// axe-core checks contrast, names, roles and heading structure in the states parents use most.
const axe = await readFile(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const url = pathToFileURL(resolve('dist/Flagventures.html')).href;
const browser = await chromium.launch({headless: true, ...(process.env.CHROME_EXECUTABLE ? {executablePath: process.env.CHROME_EXECUTABLE} : {channel: 'chrome'})});
const states = [
  ['offense, desktop, Chinese', {width: 1440, height: 900}, 'spread-play-1', 'zh'],
  ['basic route, desktop, English', {width: 1440, height: 900}, 'route-hitch', 'en'],
  ['defense, desktop, Chinese', {width: 1440, height: 900}, 'cover-2', 'zh'],
  ['running play, phone, Chinese', {width: 390, height: 844}, 'hb-option', 'zh'],
  ['concept, phone, English, catalog open', {width: 390, height: 844}, 'concept-mesh', 'en', page => page.locator('#catalogToggle').click()],
  ['help dialog', {width: 1440, height: 900}, 'spread-play-1', 'zh', page => page.locator('#help').click()],
  ['playbook dialog, English', {width: 1440, height: 900}, 'spread-play-1', 'en', page => page.locator('#manage').click()],
  ['full screen, sideways phone', {width: 844, height: 390}, 'single-back-play-1', 'zh', page => page.locator('#fullscreen').click()],
];
try {
  const failures = [];
  for (const [name, viewport, id, language, action] of states) {
    const page = await browser.newPage({viewport});
    await page.goto(`${url}#lesson=${id}`);
    if (language === 'en') await page.selectOption('#language', 'en');
    if (action) await action(page);
    await page.waitForTimeout(300);
    await page.addScriptTag({content: axe});
    const violations = await page.evaluate(async () => (await window.axe.run(document, {resultTypes: ['violations']})).violations
      .map(violation => `${violation.id}: ${violation.nodes.slice(0, 3).map(node => node.target.join(' ')).join(', ')}`));
    if (violations.length) failures.push(`${name}\n  ${violations.join('\n  ')}`);
    await page.close();
  }
  assert.deepEqual(failures, [], `accessibility violations:\n${failures.join('\n')}`);
  console.log(`PASS accessibility (axe-core) in ${states.length} states: desktop, phone, English, catalog drawer, dialogs and full screen`);
} finally { await browser.close(); }
