import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright';
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
 const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
 const page=await context.newPage();const errors=[],requests=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(/^https?:/.test(r.url()))requests.push(r.url());});
 const url=pathToFileURL(resolve('dist/Flagventures.html')).href;
 await page.goto(url);
 await page.selectOption('#language','en');
 assert.equal(await page.locator('html').getAttribute('lang'),'en');
 assert.match(await page.title(),/^Flagventures/);
 const pack=JSON.parse(await readFile('content/default.flagbook.json','utf8'));
 // Walk all lessons and all player cards, including hidden source notes and choices.
 for(const lesson of pack.lessons){
  await page.locator(`[data-lesson="${lesson.id}"]`).evaluate(n=>n.click());
  for(const p of lesson.players){
   await page.locator(`#roles [data-player="${p.id}"]`).evaluate(n=>n.click());
   const card=await page.locator('#routeDescription').textContent();assert.doesNotMatch(card,/[\u3400-\u9fff]/u,lesson.id);
  }
  const chinese=await page.locator('body').evaluate(body=>{const w=document.createTreeWalker(body,NodeFilter.SHOW_TEXT),out=[];while(w.nextNode()){const n=w.currentNode;if(!n.parentElement.closest('script,style,.language-switch')&&/[\u3400-\u9fff]/u.test(n.textContent))out.push(n.textContent.trim());}return out;});
  assert.deepEqual(chinese,[],lesson.id);
 }
 await page.locator('[data-lesson="single-back-play-1"]').evaluate(n=>n.click());
 await page.locator('[data-choice-player="C"][data-option="released"]').click();
 await page.locator('#roles [data-player="C"]').click();
 await page.locator('#frames [data-frame="2"]').click();
 const position=()=>page.locator('#field .player').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('transform')));
 const before=await position(),time=await page.locator('#seek').inputValue();
 await page.selectOption('#language','zh');
 assert.equal(await page.locator('#seek').inputValue(),time);assert.deepEqual(await position(),before);
 assert.equal(await page.locator('[data-choice-player="C"][data-option="released"]').getAttribute('aria-pressed'),'true');
 assert.equal(await page.locator('#roles [data-player="C"]').getAttribute('aria-pressed'),'true');
 await page.locator('#play').click();await page.waitForTimeout(150);
 const running=Number(await page.locator('#seek').inputValue());
 await page.selectOption('#language','en');await page.waitForTimeout(150);
 assert.ok(Number(await page.locator('#seek').inputValue())>running);assert.match(await page.locator('#playState').textContent(),/Playing/);
 await page.locator('#play').click();
 await page.locator('#manage').click();
 const downloadEvent=page.waitForEvent('download');await page.locator('#exportPack').click();const download=await downloadEvent;
 const exported=JSON.parse(await readFile(await download.path(),'utf8'));assert.deepEqual(exported,pack);
 await page.locator('#fileInput').setInputFiles({name:'bad.yaml',mimeType:'application/yaml',buffer:Buffer.from('format: wrong')});
 await page.waitForFunction(()=>document.querySelector('#importReport').classList.contains('error'));
 assert.match(await page.locator('#importReport').textContent(),/unchanged/);assert.doesNotMatch(await page.locator('#importReport').textContent(),/[\u3400-\u9fff]/u);
 await page.keyboard.press('Escape');await page.reload();assert.equal(await page.locator('#language').inputValue(),'en');
 await page.setViewportSize({width:800,height:900});assert.ok(await page.locator('#language').isVisible());
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);
 // Storage restrictions must not prevent using the app.
 const blocked=await context.newPage();await blocked.addInitScript(()=>{Object.defineProperty(Storage.prototype,'getItem',{value(){throw new Error('blocked');}});Object.defineProperty(Storage.prototype,'setItem',{value(){throw new Error('blocked');}});});
 await blocked.goto(url);await blocked.selectOption('#language','en');assert.equal(await blocked.locator('html').getAttribute('lang'),'en');
 console.log('PASS English coverage for all 64 lessons; language/state persistence; bilingual export; import errors; narrow layout; blocked storage; offline runtime');
} finally {await browser.close();}
