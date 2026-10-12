// Maintainer CI uses its own Chromium runtime. Local manual checks use the in-app browser.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright';
import {parseBackup} from '../app/coach-storage.js';
const directory=resolve('dist');
const server=createServer(async(req,res)=>{try{const p=decodeURIComponent(new URL(req.url,'http://localhost').pathname),file=resolve(directory,p==='/'?'index.html':`.${p}`);if(!file.startsWith(directory+sep))throw new Error('Invalid path');res.setHeader('Content-Type','text/html; charset=utf-8');res.end(await readFile(file));}catch{res.statusCode=404;res.end('Not found');}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${server.address().port}/`,browser=await chromium.launch({headless:true});
await mkdir('tmp/coach-integration',{recursive:true});
try{
 const context=await browser.newContext({viewport:{width:1280,height:900},acceptDownloads:true}),page=await context.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 const action=(name)=>{const found=page.locator(`.coach [data-do="${name}"]`);return name==='dismiss'?found.last():found;};
 const point=async(x,y)=>page.locator('.coach-canvas').evaluate((el,[x,y])=>{const p=new DOMPoint(x,y).matrixTransform(el.getScreenCTM());return{x:p.x,y:p.y};},[x,y]);
 const clickPoint=async(x,y)=>{const p=await point(x,y);await page.mouse.click(p.x,p.y);};
 const holdPlayer=async(id)=>{const g=page.locator(`.coach [data-hit="player"][data-id="${id}"]`);const p=await g.evaluate(el=>{const c=el.querySelector('circle'),p=new DOMPoint(+c.getAttribute('cx'),+c.getAttribute('cy')).matrixTransform(el.ownerSVGElement.getScreenCTM());return{x:p.x,y:p.y};});await page.mouse.move(p.x,p.y);await page.mouse.down();await page.waitForTimeout(620);await page.mouse.up();await page.locator('.coach-context').waitFor();};
 await page.goto(url);await page.locator('#manage').click();await action('new').click();await action('create').filter({hasText:'进攻战术'}).click();await page.locator('.coach-canvas').waitFor();
 assert.equal(await page.locator('.coach-steps,.coach-inspector,.coach-tools').count(),0);
 assert.equal(await page.locator('.coach [data-hit="player"]').count(),5);
 await action('details').click();await page.locator('.coach [data-edit="title"]').fill('Direct board');await page.locator('.coach [data-edit="explanation"]').fill('Typed without blur');
 await page.locator('.coach-status').filter({hasText:'草稿已保留'}).waitFor();await action('dismiss').click();
 await holdPlayer('X');await action('templates').click();await page.locator('.coach [data-term="POST"]').click();
 // Tapping the physical path, rather than its SVG bounding-box centre, creates a stop.
 await clickPoint(5,45);assert.equal(await page.locator('.coach [data-hit="frame"]').count(),1);
 await page.locator('.coach [data-edit="explanation"]').fill('Look at QB here');await action('dismiss').click();
 await holdPlayer('QB');await page.locator('.coach [data-do="ball"][data-type="pass"]').click();await clickPoint(5,50);
 await holdPlayer('QB');await page.locator('.coach [data-do="ball"][data-type="pass"]').click();await clickPoint(25,50);
 await action('outcomes').click();assert.equal(await action('outcome').count(),2);await action('outcome').filter({hasText:'传给 X'}).click();
 await action('save').click();await page.locator('.coach-status').filter({hasText:'已保存'}).waitFor();
 await action('more').click();const downloaded=page.waitForEvent('download');await action('export-one').click();const data=parseBackup(await readFile(await(await downloaded).path(),'utf8'));
 assert.equal(data.length,1);assert.equal(data[0].saved.title.zh,'Direct board');assert.equal(Object.hasOwn(data[0],'history'),false);assert.equal(data[0].saved.scenarios.length,2);
 await action('dismiss').click();
 // Select, then drag. The saved teaching version is isolated from this auto-retained draft.
 await clickPoint(5,50);const from=await point(5,50),to=await point(7,50);await page.mouse.move(from.x,from.y);await page.mouse.down();await page.mouse.move(to.x,to.y,{steps:12});await page.mouse.up();
 await page.locator('.coach-status').filter({hasText:'草稿已保留'}).waitFor();await action('library').click();
 await page.locator('.coach-card').filter({hasText:'Direct board'}).locator('[data-do="card-more"]').click();await action('teach-card').click();
 assert.equal(await page.locator('.coach [data-hit="player"][data-id="X"] circle').first().getAttribute('cx'),'5');
 await action('edit-saved').click();assert.equal(await page.locator('.coach [data-hit="player"][data-id="X"] circle').first().getAttribute('cx'),'7');
 await page.reload();await page.locator('#manage').click();await page.locator('.coach-card').filter({hasText:'Direct board'}).click();
 await action('details').click();assert.equal(await page.locator('.coach [data-edit="explanation"]').inputValue(),'Typed without blur');await action('dismiss').click();
 assert.equal(await page.locator('.coach [data-hit="player"][data-id="X"] circle').first().getAttribute('cx'),'7');
 // A single stroke requires no separate Finish control.
 await holdPlayer('Y');await action('draw').click();const start=await point(25,50),end=await point(25,40);await page.mouse.move(start.x,start.y);await page.mouse.down();await page.mouse.move(end.x,end.y,{steps:16});await page.mouse.up();
 assert.equal(await page.locator('.coach [data-hit="route"][data-id="Y"]').count(),1);
 for(const[width,height]of[[390,844],[768,1024],[1024,768]]){await page.setViewportSize({width,height});assert.ok(await page.locator('.coach').evaluate(n=>n.scrollWidth<=n.clientWidth+1));assert.equal(await page.locator('.coach-sheet').count(),0);assert.ok(await page.locator('.coach [data-hit="player"] circle').first().evaluate(n=>n.getBoundingClientRect().width>=43.9));await page.screenshot({path:`tmp/coach-integration/${width}.png`,fullPage:true});}
 // A new handoff must be visible even after the coach previously hid ball actions.
 await action('library').click();await action('new').click();await action('create').filter({hasText:'进攻战术'}).click();await page.locator('.coach-canvas').waitFor();
 await holdPlayer('Z');await action('draw').click();const zs=await point(20,54);await page.mouse.move(zs.x,zs.y);await page.mouse.down();
 for(const [x,y]of[[11,55],[8,53],[4,54]]){const p=await point(x,y);await page.mouse.move(p.x,p.y,{steps:12});}await page.mouse.up();
 await holdPlayer('QB');await page.locator('.coach [data-do="ball"][data-type="pass"]').click();await clickPoint(20,54);
 await action('more').click();await action('routes-only').click();assert.equal(await page.locator('.coach [data-hit="event"]').count(),0);
 await action('more').click();assert.equal(await action('routes-only').textContent(),'显示球路');await action('dismiss').click();
 await holdPlayer('QB');await page.locator('.coach [data-do="ball"][data-type="handoff"]').click();await clickPoint(15,55);assert.equal(await page.locator('.coach-hint').textContent(),'点目标球员');await clickPoint(20,54);
 assert.equal(await page.locator('.coach [data-hit="event"][aria-label="交递"]').count(),1,'selecting Z adds and displays the QB → Z handoff');
 assert.match(await page.locator('.coach-hint').textContent(),/^Z ·/);assert.equal(await page.locator('.coach-toast').textContent(),'QB → Z · 交递');
 await page.screenshot({path:'tmp/coach-integration/handoff-after-routes-only.png',fullPage:true});
 await action('library').click();await action('close').click();await page.goto(pathToFileURL(resolve('dist/Flagventures.html')).href);await page.locator('#manage').click();
 await page.locator('#coachBackupInput').setInputFiles({name:'restore.backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({format:'flagventures.backup',version:3,records:data}))});
 await page.locator('.coach-modal [data-do="confirm"]').click();assert.equal(await page.locator('.coach-card').count(),1);
 await page.locator('.coach-card').click();assert.match(await page.locator('.coach-status').textContent(),/临时编辑/);await action('library').click();
 await page.locator('#coachBackupInput').setInputFiles({name:'old.backup.json',mimeType:'application/json',buffer:Buffer.from('{"format":"flagventures.backup","version":2,"records":[]}')});await page.locator('.coach-toast').filter({hasText:'v3'}).waitFor();assert.equal(await page.locator('.coach-card').count(),1);
 assert.deepEqual(errors,[]);console.log('PASS direct selection, long-press menus, continuous drawing, route stops, multiple outcomes, saved/draft isolation, persistence, v3 backups and responsive dimensions. True touch checks remain separate.');
}finally{await browser.close();await new Promise(r=>server.close(r));}
