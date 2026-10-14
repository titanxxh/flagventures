import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {IDBFactory} from 'fake-indexeddb';
import {addBallAction,applyRouteTemplate,ballActors,copySimpleLesson,drawRoute,findNearbyStops,moveObject,nearestRoutePoint,routeRelease,scheduleBall,setPassRelease,simplePlay} from '../app/coach-drawing.js';
import {clone,compilePlay,explanation,validatePlay} from '../app/coach-model.js';
import {assertPlay,backup,CoachStore,makeRecord,parseBackup} from '../app/coach-storage.js';
import {getBallState} from '../app/ball.js';

test('nearby stops stay scoped to the same player, ball action and phase without changing teaching data',()=>{
  const p=simplePlay();drawRoute(p,p.players.find(p=>p.id==='X'),[[5,40]]);drawRoute(p,p.players.find(p=>p.id==='Y'),[[25,40]]);
  const s=addBallAction(p,p.defaultScenario,'pass','QB','X'),snap=s.events.find(e=>e.type==='snap');
  const frame=(id,binding)=>({id,title:{zh:id,en:id},binding,explanation:explanation('保留讲解','Keep the explanation')});
  p.bookmarks=[frame('x',{type:'route',player:'X',progress:.2}),frame('y',{type:'route',player:'Y',progress:.2}),frame('snap',{type:'ball',event:snap.id,phase:'progress',progress:.5}),frame('catch',{type:'ball',event:snap.id,phase:'end'})];
  const fakePlan=addBallAction(p,s.id,'pump-fake','QB','X'),fake=fakePlan.events.at(-1);
  p.bookmarks.push({...frame('later-fake',{type:'ball',event:fake.id,phase:'progress',progress:.6}),scenario:fakePlan.id});
  const before=clone(p);
  assert.deepEqual(findNearbyStops(p,{type:'route',player:'X',progress:.21}).map(f=>f.id),['x']);
  assert.deepEqual(findNearbyStops(p,{type:'ball',event:snap.id,phase:'progress',progress:.52}).map(f=>f.id),['snap']);
  assert.deepEqual(findNearbyStops(p,{type:'ball',event:snap.id,phase:'progress',progress:.8}),[]);
  assert.deepEqual(findNearbyStops(p,{type:'ball',event:fake.id,phase:'progress',progress:0},fakePlan.id),[],'stationary ball actions keep distinct teaching moments');
  assert.deepEqual(p,before);
});
import {positionAt} from '../app/scene.js';

function exchangePlay(){const p=simplePlay();p.title.en='Handoff then pass';const z=p.players.find(p=>p.id==='Z'),x=p.players.find(p=>p.id==='X'),y=p.players.find(p=>p.id==='Y');drawRoute(p,z,[[15,55],[12,52],[12,45]]);applyRouteTemplate(p,x,'FLY');applyRouteTemplate(p,y,'FLY');const s=addBallAction(p,p.defaultScenario,'handoff','QB','Z');return{p,s,z};}
test('a route-position pass follows the actual carrier after handoff and catches a moving receiver',()=>{
  const {p,s,z}=exchangePlay(),hit=nearestRoutePoint(z,[12,52]);addBallAction(p,s.id,'pass','Z','X',routeRelease(p,'Z',hit.fraction));
  let c=compilePlay(p),pass=c.scenario.events.at(-1),handoff=c.scenario.events.at(-2);
  assert.ok(pass.at>handoff.at);assert.deepEqual(positionAt(c.lesson.players.find(p=>p.id==='Z'),pass.at),[12,52]);
  assert.equal(getBallState(c.lesson,pass.at-.01,{},c.scenario).owner,'Z');assert.equal(getBallState(c.lesson,pass.at+.1,{},c.scenario).state,'flight');assert.equal(getBallState(c.lesson,pass.endAt,{},c.scenario).owner,'X');
  assert.ok(positionAt(c.lesson.players.find(p=>p.id==='X'),pass.endAt)[1]>32,'catch occurs on the route before its end');assert.deepEqual(validatePlay(p).errors,[]);
  const first=s.events.at(-1);setPassRelease(p,s.id,first.id,nearestRoutePoint(z,[13,53]).fraction);c=compilePlay(p);pass=c.scenario.events.at(-1);assert.ok(Math.hypot(...positionAt(c.lesson.players.find(p=>p.id==='Z'),pass.at).map((v,i)=>v-[13,53][i]))<1e-8);
  const b=makeRecord(p);assert.deepEqual(parseBackup(JSON.stringify(backup([b]))),[b]);
});
test('release timing includes automatic exchange waits; alternatives preserve the complete earlier chain',()=>{
  const {p,s,z}=exchangePlay(),q=p.players.find(p=>p.id==='QB');q.at=[10,59];drawRoute(p,q,[[10,62],[15,55],[15,51]]);
  const release=routeRelease(p,'Z',nearestRoutePoint(z,[13,53]).fraction);
  const x=addBallAction(p,s.id,'pass','Z','X',release),y=addBallAction(p,x.id,'pass','Z','Y',release);
  assert.equal(p.scenarios.length,2);assert.deepEqual(y.events.map(e=>[e.type,e.from,e.to]),[['snap','C','QB'],['handoff','QB','Z'],['pass','Z','Y']]);
  for(const scenario of [x,y]){const c=compilePlay(p,scenario.id),pass=c.scenario.events.at(-1);assert.ok(scenario.overrides.Z.steps.some(s=>s.type==='pause'));assert.ok(Math.hypot(...positionAt(c.lesson.players.find(p=>p.id==='Z'),pass.at).map((v,i)=>v-[13,53][i]))<.01);}
  assert.deepEqual(validatePlay(p).errors,[]);
  assert.ok(ballActors(p,x).has('Z'),'an earlier holder remains editable for a different ending');
  const fake=simplePlay();drawRoute(fake,fake.players.find(p=>p.id==='Z'),[[15,55]]);const f=addBallAction(fake,fake.defaultScenario,'fake-handoff','QB','Z');assert.equal(ballActors(fake,f).has('Z'),false);
});
test('moving a route keeps its release binding; redrawing requires an explicit new point',()=>{
  const {p,s,z}=exchangePlay();addBallAction(p,s.id,'pass','Z','X',routeRelease(p,'Z',nearestRoutePoint(z,[12,52]).fraction));
  const event=s.events.at(-1),release=clone(event.release);moveObject(p,'player','QB',[16,55]);moveObject(p,'player','Z',[21,54]);
  assert.deepEqual(event.release,release);const c=compilePlay(p),pass=c.scenario.events.at(-1);assert.ok(Math.hypot(...positionAt(c.lesson.players.find(p=>p.id==='Z'),pass.at).map((v,i)=>v-[13,52][i]))<1e-8);
  drawRoute(p,z,[[16,55],[12,51],[12,40]]);assert.equal(event.pending,'release');assert.ok(validatePlay(p).errors.some(e=>/Route redrawn/.test(e.message)));
  setPassRelease(p,s.id,event.id,nearestRoutePoint(z,[14,53]).fraction);assert.deepEqual(validatePlay(p).errors,[]);
});
test('positioned passes reject a point before possession, crossing the LOS, and a second forward throw',()=>{
  const {p,s,z}=exchangePlay();addBallAction(p,s.id,'pass','Z','X',routeRelease(p,'Z',.1));assert.ok(validatePlay(p).errors.some(e=>/ball is not ready/.test(e.message)));
  setPassRelease(p,s.id,s.events.at(-1).id,nearestRoutePoint(z,[12,47]).fraction);assert.ok(validatePlay(p).errors.some(e=>/Release before crossing/.test(e.message)));
  const direct=simplePlay();direct.title.en='Two throws';for(const id of ['X','Y'])applyRouteTemplate(direct,direct.players.find(p=>p.id===id),'FLY');
  const first=addBallAction(direct,direct.defaultScenario,'pass','QB','X');addBallAction(direct,first.id,'pass','X','Y',routeRelease(direct,'X',1));assert.ok(validatePlay(direct).errors.some(e=>/Release before crossing|already has a forward pass/.test(e.message)));
  const back=exchangePlay();drawRoute(back.p,back.z,[[15,55],[12,49],[12,53]]);addBallAction(back.p,back.s.id,'pass','Z','X',routeRelease(back.p,'Z',1));assert.ok(validatePlay(back.p).errors.some(e=>/Release before crossing/.test(e.message)),'returning behind the LOS does not restore passing eligibility');
});

test('one continuous straight stroke is a playable route; moving it keeps the whole shape on the field',()=>{
  const p=simplePlay('route'),x=p.players.find(p=>p.id==='X');p.title.zh='直跑';
  assert.equal(drawRoute(p,x,[[5,48],[5.1,45],[5,40]],true),true);
  assert.equal(x.motion.steps.length,1);
  assert.deepEqual(x.motion.steps[0].to,[5,40]);
  applyRouteTemplate(p,x,'POST');
  const vector=x.motion.steps.at(-1).to.map((v,i)=>v-x.at[i]);
  moveObject(p,'player','X',[30,69]);
  assert.deepEqual(x.motion.steps.at(-1).to.map((v,i)=>v-x.at[i]),vector);
  assert.deepEqual(validatePlay(p).errors,[]);
});
test('a stop stays at the tapped place through retiming and moving a curved route',()=>{
  const p=simplePlay('route'),x=p.players.find(p=>p.id==='X');p.title.zh='钩回';applyRouteTemplate(p,x,'HITCH');
  x.motion.steps[1].type='quadratic';x.motion.steps[1].control=[6,43];scheduleBall(p);
  const tapped=[6,44],hit=nearestRoutePoint(x,tapped);
  p.bookmarks.push({id:'explain',title:{zh:'迎向QB',en:''},binding:{type:'route',player:'X',progress:hit.fraction},explanation:explanation()});
  let c=compilePlay(p),at=c.keyframes.find(f=>f.id==='explain').at;
  const old=positionAt(c.lesson.players.find(p=>p.id==='X'),at);
  moveObject(p,'player','X',[7,52]);c=compilePlay(p);at=c.keyframes.find(f=>f.id==='explain').at;
  const moved=positionAt(c.lesson.players.find(p=>p.id==='X'),at);
  assert.ok(Math.hypot(moved[0]-old[0]-2,moved[1]-old[1]-2)<.02);
  assert.deepEqual(validatePlay(p).errors,[]);
});
test('automatic snap and two receiver endings share routes and reconstruct exactly one ball',()=>{
  const p=simplePlay();p.title.en='Two choices';const x=p.players.find(p=>p.id==='X'),y=p.players.find(p=>p.id==='Y');
  applyRouteTemplate(p,x,'POST');applyRouteTemplate(p,y,'OUT');
  const first=addBallAction(p,p.defaultScenario,'pass','QB','X');
  const second=addBallAction(p,first.id,'pass','QB','Y');
  assert.equal(p.scenarios.length,2);
  assert.deepEqual(validatePlay(p).errors,[]);
  for(const s of [first,second]){const c=compilePlay(p,s.id),pass=c.scenario.events.at(-1);assert.equal(c.scenario.events[0].type,'snap');assert.equal(getBallState(c.lesson,pass.endAt,{},c.scenario).owner,pass.to);assert.deepEqual(getBallState(c.lesson,0,{},c.scenario).position,p.players.find(p=>p.id==='C').at);}
  const before=clone(p.players);scheduleBall(p);assert.deepEqual(p.players,before);
});
test('template geometry uses the existing route lessons and Hitch returns toward the actual QB',()=>{
  const pack=JSON.parse(readFileSync('content/default.flagbook.json'));
  for(const lesson of pack.lessons.filter(l=>l.kind==='route')){
    const p=simplePlay('route'),source=lesson.players.find(p=>p.id==='X'),x=p.players.find(p=>p.id==='X');x.at=clone(source.at);
    const term=source.label.en;applyRouteTemplate(p,x,term,lesson);
    assert.equal(x.motion.steps.length,source.motion.steps.length,term);
    for(let i=0;i<x.motion.steps.length;i++)if(source.motion.steps[i].to)assert.ok(Math.hypot(...x.motion.steps[i].to.map((v,k)=>v-source.motion.steps[i].to[k]))<1e-6,term);
  }
});
test('ball flight stops follow automatic release and catch times after a route edit',()=>{
  const p=simplePlay(),x=p.players.find(p=>p.id==='X');p.title.zh='传球停点';applyRouteTemplate(p,x,'FLY');
  const s=addBallAction(p,p.defaultScenario,'pass','QB','X'),event=s.events.at(-1);
  p.bookmarks.push({id:'flight-stop',title:{zh:'球在飞',en:''},scenario:s.id,binding:{type:'ball',event:event.id,phase:'progress',progress:.5},explanation:explanation()});
  x.motion.steps[0].to[1]-=5;scheduleBall(p);const c=compilePlay(p),f=c.keyframes.find(f=>f.id==='flight-stop');
  assert.equal(f.valid,true);assert.equal(getBallState(c.lesson,f.at,{},c.scenario).state,'flight');assert.deepEqual(validatePlay(p).errors,[]);
});
test('a handoff waits at a real shared point without changing editable geometry; fake exchanges retain the ball',()=>{
  const p=simplePlay();p.title.zh='交递';const q=p.players.find(p=>p.id==='QB'),z=p.players.find(p=>p.id==='Z');
  q.at=[15,55];z.at=[20,54];drawRoute(p,q,[[15,54],[15,49]]);drawRoute(p,z,[[15,54],[10,48]]);
  const geometry=clone(p.players.map(p=>({at:p.at,steps:p.motion.steps})));
  const s=addBallAction(p,p.defaultScenario,'fake-handoff','QB','Z');
  const c=compilePlay(p),fake=c.scenario.events.at(-1);
  assert.ok(fake.at>1);
  const a=positionAt(c.lesson.players.find(p=>p.id==='QB'),fake.at),b=positionAt(c.lesson.players.find(p=>p.id==='Z'),fake.at);
  assert.ok(Math.hypot(a[0]-b[0],a[1]-b[1])<=.5);
  assert.equal(getBallState(c.lesson,fake.at+.1,{},c.scenario).owner,'QB');
  assert.deepEqual(p.players.map(p=>({at:p.at,steps:p.motion.steps})),geometry);
  assert.deepEqual(validatePlay(p).errors,[]);
  assert.equal(s.overrides.QB.steps.some(a=>a.type==='pause'),true);
});
test('disjoint handoff routes remain an incomplete recoverable draft and cannot become a teaching version',()=>{
  const p=simplePlay();p.title.zh='未会合';const z=p.players.find(p=>p.id==='Z');z.at=[25,54];applyRouteTemplate(p,z,'FLY');
  const s=addBallAction(p,p.defaultScenario,'handoff','QB','Z');
  assert.equal(s.events.at(-1).pending,'meeting');
  assert.ok(validatePlay(p).errors.length);
  const r=makeRecord(p);assert.deepEqual(parseBackup(JSON.stringify(backup([r]))),[r]);
});
test('all built-ins produce useful simplified copies with sources and valid stop positions',()=>{
  const pack=JSON.parse(readFileSync('content/default.flagbook.json'));
  for(const lesson of pack.lessons){const p=copySimpleLesson(lesson);assertPlay(p);assert.deepEqual(validatePlay(p).errors,[],lesson.id);assert.deepEqual(p.origin.original,lesson);assert.ok(p.origin.references.some(r=>r.role==='primary'));}
  const p=copySimpleLesson(pack.lessons.find(l=>l.id==='crossbuck'));
  assert.equal(p.origin.omittedOutcomes,1,'The incompatible alternate order is explicitly reported rather than animated incorrectly');
});
test('v1 local editor data is cleared once on upgrade; v3 drafts survive reopening and old backup files are rejected',async()=>{
  const indexedDB=new IDBFactory();
  await new Promise((resolve,reject)=>{const r=indexedDB.open('flagventures-coach',1);r.onupgradeneeded=()=>r.result.createObjectStore('plays',{keyPath:'id'});r.onsuccess=()=>{const tx=r.result.transaction('plays','readwrite');tx.objectStore('plays').put({id:'old',draft:{version:2}});tx.oncomplete=()=>{r.result.close();resolve();};};r.onerror=()=>reject(r.error);});
  const store=new CoachStore({indexedDB});await store.open();assert.equal(store.resetLegacy,true);assert.deepEqual(await store.list(),[]);
  const value=makeRecord(simplePlay('formation'));await store.change([{id:value.id,expected:0,record:value}]);store.db.close();
  const reopened=new CoachStore({indexedDB});await reopened.open();assert.equal((await reopened.list()).length,1);assert.equal(reopened.resetLegacy,undefined);reopened.db.close();
  assert.throws(()=>parseBackup(JSON.stringify({format:'flagventures.backup',version:2,records:[]})),/v3/);
});
