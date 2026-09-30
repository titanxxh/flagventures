import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {getScene,positionAt} from '../app/scene.js';
import {getBallState,resolveBallScenario} from '../app/ball.js';
const pack=JSON.parse(fs.readFileSync('content/default.flagbook.json'));
const lessons=pack.lessons.filter(l=>l.id.startsWith('concept-'));
const lesson=id=>lessons.find(l=>l.id===`concept-${id}`);
const player=(id,p)=>lesson(id).players.find(x=>x.id===p);
const turns=(id,p)=>player(id,p).motion.steps.filter(s=>s.type!=='pause').map(s=>s.to);
const distance=(a,b)=>Math.hypot(...a.map((v,i)=>v-b[i]));

test('six complete concepts form three ordered groups in the fifth chapter',()=>{
 assert.equal(lessons.length,6);assert.equal(pack.sections.length,5);
 assert.deepEqual(pack.sections.at(-1).groups.map(g=>g.lessonIds.length),[3,2,1]);
 assert.deepEqual(pack.sections.at(-1).lessonIds,lessons.map(l=>l.id));
 for(const l of lessons){
  assert.deepEqual(l.players.map(p=>p.id),['Q','C','X','Y','Z']);
  assert.equal(l.field.unit,'yard');assert.equal(l.timeline.basis,'illustration');
  assert.ok(l.source.adaptation);assert.equal(l.ball.scenarios.length,4);
  for(const p of l.players)assert.ok(p.label.description&&p.coaching.cooperation&&p.coaching.timing,`${l.id}/${p.id}`);
 }
});

test('all 24 outcomes snap first, lead the selected receiver and preserve other routes and rewind state',()=>{
 let count=0;
 for(const l of lessons)for(const authored of l.ball.scenarios){
  count++;const before=JSON.stringify(l),{lesson:resolved,choices,scenario}=resolveBallScenario(l,authored.id);
  assert.deepEqual(resolved.players,l.players);
  const [snap,pass]=scenario.events;
  assert.deepEqual([snap.from,snap.to,snap.at,snap.endAt],['C','Q',0,.35]);
  assert.equal(scenario.id,`pass-${pass.to.toLowerCase()}`);assert.equal(scenario.basis,'illustration');
  assert.ok(pass.at>.35&&pass.endAt<10);assert.equal(getBallState(resolved,.4,choices,scenario).owner,'Q');
  const target=resolved.players.find(p=>p.id===pass.to);
  const flight=getBallState(resolved,(pass.at+pass.endAt)/2,choices,scenario);
  assert.equal(flight.state,'flight');assert.deepEqual(flight.flights.at(-1).end,positionAt(target,pass.endAt,choices));
  assert.ok(distance(positionAt(target,pass.at),positionAt(target,pass.endAt))>.1);
  for(const t of [10,pass.endAt]){const state=getBallState(resolved,t,choices,scenario);assert.equal(state.owner,pass.to);assert.deepEqual(state.position,positionAt(target,t,choices));}
  for(const t of [pass.at,pass.endAt])assert.ok(resolved.keyframes.some(f=>f.at===t),`${l.id}: event frame`);
  const atStart=getBallState(resolved,0,choices,scenario);getBallState(resolved,10,choices,scenario);assert.deepEqual(getBallState(resolved,0,choices,scenario),atStart);
  assert.equal(JSON.stringify(l),before);
 }
 assert.equal(count,24);
});

test('every concept stays in bounds with nonoverlapping player centers during the full animation',()=>{
 for(const l of lessons)for(let at=0;at<=10;at+=.025){
  const {players}=getScene(l,at);
  for(const p of players){const [x,y]=p.position;assert.ok(x>=0&&x<=l.field.width&&y>=0&&y<=l.field.height,`${l.id}/${p.id}/${at}`);}
  // Current yard-field player circles have a 1.95-yard diameter.
  for(let i=0;i<players.length;i++)for(let j=i+1;j<players.length;j++)assert.ok(distance(players[i].position,players[j].position)>=1.95-1e-6,`${l.id}/${players[i].id}/${players[j].id}/${at}: body overlap`);
 }
});

test('source-specific route relationships survive full-five completion',()=>{
 const [outStart,outEnd]=turns('flood','Y');assert.equal(outStart[1],outEnd[1]);assert.ok(outEnd[0]>outStart[0]);
 const [cornerStart,cornerEnd]=turns('stack-90','X');assert.ok(cornerEnd[0]<cornerStart[0]&&cornerEnd[1]<cornerStart[1]);
 assert.ok(turns('stack-90','Y')[1][0]<turns('stack-90','Y')[0][0]);assert.ok(turns('stack-90','Z')[1][0]>turns('stack-90','Z')[0][0]);
 for(const p of ['X','Y']){const [stem,back]=turns('spacing',p);assert.ok(back[1]>stem[1]);assert.ok(back[1]<turns('spacing','C')[1][1]);assert.equal(player('spacing',p).motion.steps[1].facePlayer,'Q');}
 const deep=turns('levels','X'),mid=turns('levels','Y'),shallow=turns('levels','Z');assert.ok(deep[0][1]<mid[0][1]&&mid[0][1]<shallow[0][1]);
 for(const path of [deep,mid,shallow]){assert.equal(path[0][1],path[1][1]);assert.ok(path[1][0]<path[0][0]);}
 const x=turns('mesh','X'),y=turns('mesh','Y');assert.ok(x[1][0]>x[0][0]&&y[1][0]<y[0][0]);assert.equal(x[0][1]-y[0][1],2);
});
