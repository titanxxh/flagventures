import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(pathToFileURL(resolve('dist/Flagventures.html')).href);
 const lessons=await page.locator('#builtInData').evaluate(n=>JSON.parse(n.textContent).lessons.filter(l=>l.kind==='route'));
 for(const language of ['zh','en']){
  await page.selectOption('#language',language);
  for(const lesson of lessons){
   await page.locator(`[data-lesson="${lesson.id}"]`).evaluate(n=>n.click());
   assert.equal(await page.locator('#field [data-player="QB"]').count(),1,`${lesson.id}: QB context`);
   const box=(await page.locator('#field').getAttribute('viewBox')).split(' ').map(Number);
   assert.ok(box[0]<=0 && box[1]<=0 && box[0]+box[2]>=lesson.field.width && box[1]+box[3]>=lesson.field.height,`${lesson.id}: full field`);
   assert.equal(await page.locator('[data-field-endzone]').count(),2);
   assert.equal(await page.locator('#routeOrientation').isVisible(),true);
   assert.equal(await page.locator('#teamPlan').isVisible(),true);
   assert.ok((await page.locator('#teachingGoal').textContent()).length>15);
   assert.ok((await page.locator('#teamCooperation').textContent()).includes('QB'));
   assert.equal(await page.locator('#routePerson').textContent(),'X',`${lesson.id}: default route details`);
   const qb=await page.locator('#field [data-player="QB"]').getAttribute('transform');
   await page.locator('#frames button').last().click();
   assert.equal(await page.locator('#field [data-player="QB"]').getAttribute('transform'),qb);
   await page.locator('#reset').click();
  }
 }
 assert.ok(lessons.some(l=>l.id==='route-in'));
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:1000});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 }
 assert.deepEqual(errors,[]);
 console.log('PASS all basic routes: full field, fixed QB reference, visible bilingual explanations and supplemental In');
} finally{await browser.close();}
