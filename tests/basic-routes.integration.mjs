import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const browser=await chromium.launch({headless:true,...(process.env.CHROME_EXECUTABLE?{executablePath:process.env.CHROME_EXECUTABLE}:{channel:'chrome'})});
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(pathToFileURL(resolve('dist/Flagventures.html')).href);
 // A return route must show the receiver facing QB, independently of the run path.
 await page.locator('[data-lesson="route-hitch"]').evaluate(n=>n.click());
 const facing=page.locator('#field [data-player="X"] [data-facing]');
 assert.equal(await facing.count(),1,'Hitch needs a visible body-facing indicator');
 const activeArrow=page.locator('#field [data-active-route="X"]');
 assert.equal(await activeArrow.count(),1,'Hitch must show the current run segment, not the full-route endpoint arrow');
 assert.equal(await page.locator('#field [data-player-route="X"]').getAttribute('marker-end'),'none');
 const seek=async time=>page.locator('#seek').evaluate((n,t)=>{n.value=t;n.dispatchEvent(new Event('input',{bubbles:true}));},time);
 for(const time of [0,6.99,7,8.5,10,0,7]){
  await seek(time);
  assert.equal(await facing.getAttribute('visibility'),'visible');
  const direction=JSON.parse(await facing.getAttribute('data-direction'));
  const arrow=await activeArrow.evaluate(n=>{const length=n.getTotalLength(),a=n.getPointAtLength(0),b=n.getPointAtLength(length);return {from:[a.x,a.y],to:[b.x,b.y],length};});
  if(time<7) assert.deepEqual([arrow.from,arrow.to],[[8,50],[8,43]],'blue arrow starts with the forward stem');
  else {
   assert.deepEqual(arrow.from,[8,43]);
   assert.ok(arrow.to[0]>8 && arrow.to[1]>43,'Hitch hooks inward and back');
   assert.ok(Math.abs(arrow.length-2)<.001,'diagonal return travels about two yards');
   assert.ok(Math.abs((arrow.to[0]-8)*12-(arrow.to[1]-43)*7)<.001,'return arrow aims toward QB');
  }
  assert.equal(await activeArrow.getAttribute('marker-end'),'url(#arrow-X)');
  if(time<7){
   assert.deepEqual(direction,[0,-1]);
   assert.equal(await facing.getAttribute('data-face-player'),'');
  }else{
   const positions=await page.locator('#field .player').evaluateAll(nodes=>Object.fromEntries(nodes.map(n=>[n.dataset.player,n.transform.baseVal.getItem(0).matrix]).map(([id,m])=>[id,[m.e,m.f]])));
   const dx=positions.QB[0]-positions.X[0],dy=positions.QB[1]-positions.X[1];
   assert.ok(Math.abs(direction[0]*dy-direction[1]*dx)<1e-6,'body faces QB, not just the return direction');
   assert.ok(direction[0]*dx+direction[1]*dy>0);
   assert.equal(await facing.getAttribute('data-face-player'),'QB');
   assert.equal(await page.locator('[data-facing-guide="X"]').getAttribute('visibility'),'visible');
  }
 }
 await page.locator('#reset').click();
 const routePoints=()=>page.locator('#field [data-active-route="X"]').evaluate(n=>{const a=n.getPointAtLength(0),b=n.getPointAtLength(n.getTotalLength());return {from:[a.x,a.y],to:[b.x,b.y]};});
 await page.locator('[data-lesson="route-option"]').evaluate(n=>n.click());
 await seek(5);
 const optionHook=await routePoints();
 assert.ok(optionHook.to[1]>optionHook.from[1],'Option visibly retreats from its inside tip');
 await seek(6);
 const optionOut=await routePoints();
 assert.ok(optionOut.to[0]<optionOut.from[0]);
 assert.equal(optionOut.from[1],optionOut.to[1]);
 assert.equal(optionOut.from[1],optionHook.to[1],'Option exits from the hook, not the old tip');
 await page.locator('[data-lesson="route-stop-and-go"]').evaluate(n=>n.click());
 await seek(3.75);
 assert.equal(await page.locator('#field [data-player="X"] [data-facing]').getAttribute('data-face-player'),'QB');
 const fakeCatchPosition=await page.locator('#field [data-player="X"]').getAttribute('transform');
 await seek(4.5);
 assert.equal(await page.locator('#field [data-player="X"]').getAttribute('transform'),fakeCatchPosition,'fake catch holds after returning');
 await seek(4.75);
 const escape=await routePoints();
 assert.ok(escape.to[0]<escape.from[0]);
 assert.equal(escape.to[1],escape.from[1]);
 await seek(5.5);
 const deep=await routePoints();
 assert.equal(deep.from[0],deep.to[0]);
 assert.ok(deep.to[1]<deep.from[1]);
 assert.equal(await page.locator('#field [data-player="X"] [data-facing]').getAttribute('data-face-player'),'','deep run faces downfield again');
 const lessons=await page.locator('#builtInData').evaluate(n=>JSON.parse(n.textContent).lessons.filter(l=>l.kind==='route'));
 for(const language of ['zh','en']){
  await page.selectOption('#language',language);
  for(const lesson of lessons){
   await page.locator(`[data-lesson="${lesson.id}"]`).evaluate(n=>n.click());
   assert.equal(await page.locator('#field [data-player="QB"]').count(),1,`${lesson.id}: QB context`);
   // Routes open zoomed to the run: full width, QB, line of scrimmage and every turn stay in view.
   const zoom=page.locator('#fieldZoom');
   if(await zoom.getAttribute('aria-pressed')==='true') await zoom.click();
   const viewBox=async()=>(await page.locator('#field').getAttribute('viewBox')).split(' ').map(Number);
   const zoomed=await viewBox();
   const qbAt=lesson.players.find(p=>p.id==='QB').at;
   const runnerAt=lesson.players.find(p=>p.id===lesson.routeGuide.player);
   const points=[qbAt,runnerAt.at,[0,lesson.field.lineOfScrimmageY],...(runnerAt.motion.steps||runnerAt.motion.options.flatMap(o=>o.steps)).map(step=>step.to).filter(Boolean)];
   assert.ok(zoomed[0]<=0 && zoomed[0]+zoomed[2]>=lesson.field.width,`${lesson.id}: zoom keeps both sidelines`);
   assert.ok(zoomed[3]<lesson.field.height,`${lesson.id}: zoom crops unused depth`);
   for(const [,y] of points) assert.ok(y>=zoomed[1] && y<=zoomed[1]+zoomed[3],`${lesson.id}: zoom keeps ${y} in view`);
   const clipped=await page.locator('#field').evaluate(field=>{
    const [,top,,height]=field.getAttribute('viewBox').split(' ').map(Number);
    return [...field.querySelectorAll('text:not([transform])')].filter(node=>!node.closest('.player,#fieldTooltip')).filter(node=>{
     const box=node.getBBox();
     return box.height>0 && box.y<top+height && box.y+box.height>top && (box.y<top-.01 || box.y+box.height>top+height+.01);
    }).map(node=>node.textContent);
   });
   assert.deepEqual(clipped,[],`${lesson.id}: the zoom edge never cuts a caption or yard number in half`);
   await zoom.click();
   assert.equal(await zoom.getAttribute('aria-pressed'),'true');
   const box=await viewBox();
   assert.ok(box[0]<=0 && box[1]<=0 && box[0]+box[2]>=lesson.field.width && box[1]+box[3]>=lesson.field.height,`${lesson.id}: full field`);
   assert.equal(await page.locator('[data-field-endzone]').count(),2);
   assert.equal(await page.locator('#routeOrientation').isVisible(),true);
   assert.equal(await page.locator('#teamPlan').isVisible(),true);
   assert.ok((await page.locator('#teachingGoal').textContent()).length>15);
   assert.ok((await page.locator('#teamCooperation').textContent()).includes('QB'));
   assert.equal(await page.locator('#routePerson').textContent(),'X',`${lesson.id}: default route details`);
   assert.equal(await page.locator('[data-player-route="X"]').getAttribute('marker-end'),'none');
   assert.equal(await page.locator('[data-active-route="X"]').getAttribute('visibility'),'visible');
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
 console.log('PASS all basic routes: zoomed route view and full field, fixed QB reference, visible bilingual explanations, yard scale and exact depth markers');
} finally{await browser.close();}
