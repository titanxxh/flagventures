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
   assert.equal(lesson.field.unit,'yard');
   assert.deepEqual([lesson.field.width,lesson.field.height,lesson.field.endZoneDepth],[30,70,10]);
   assert.equal(await page.locator('#routeDistances').isVisible(),true);
   assert.equal(await page.locator('[data-distance-mark]').count(),lesson.routeGuide.marks.length);
   assert.equal(Number(await page.locator('[data-yard-tick="5"]').getAttribute('y')),lesson.field.lineOfScrimmageY-5);
   assert.equal(Number(await page.locator('[data-field-endzone]').first().getAttribute('height')),10);
   const scale=await page.locator('#field').evaluate(n=>({x:n.getScreenCTM().a,y:n.getScreenCTM().d}));
   assert.equal(scale.x,scale.y,'yards use the same horizontal and vertical scale');
   const runner=lesson.players.find(p=>p.id===lesson.routeGuide.player);
   const labels=await page.locator('[data-distance-mark] > text').evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};}));
   for(let i=0;i<labels.length;i++)for(let j=i+1;j<labels.length;j++){
    const a=labels[i],b=labels[j];
    assert.ok(a.x+a.width<=b.x || b.x+b.width<=a.x || a.y+a.height<=b.y || b.y+b.height<=a.y,`${lesson.id}: readable distance labels`);
   }
   for(const mark of lesson.routeGuide.marks){
    let point=runner.at,at=runner.motion.startAt;
    for(const step of runner.motion.steps.slice(0,mark.step+1)){if(step.type!=='pause')point=step.to;at+=step.seconds;}
    const element=page.locator(`[data-distance-mark="${mark.id}"]`);
    assert.equal(Number(await element.getAttribute('data-depth-yards')),lesson.field.lineOfScrimmageY-point[1]);
    assert.equal(Number(await element.getAttribute('data-marker-x')),point[0]);
    assert.equal(Number(await element.getAttribute('data-marker-y')),point[1]);
    await page.locator(`[data-distance-jump="${mark.id}"]`).click();
    assert.equal(Number(await page.locator('#seek').inputValue()),at);
    assert.equal(await page.locator('#field [data-player="X"]').getAttribute('transform'),`translate(${point.join(' ')})`);
    await page.locator('#reset').click();
    await element.focus();
    await page.keyboard.press('Enter');
    assert.equal(Number(await page.locator('#seek').inputValue()),at,'keyboard activates the same distance marker');
    assert.equal(await element.evaluate(n=>getComputedStyle(n).outlineStyle),'none','SVG focus uses the small custom ring');
   }

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
 console.log('PASS all basic routes: full field, fixed QB reference, visible bilingual explanations, yard scale and exact depth markers');
} finally{await browser.close();}
