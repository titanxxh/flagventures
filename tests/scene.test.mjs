import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {load} from 'js-yaml';
import {getScene, getRoutes, getActiveRoute, pathToSvg} from '../app/scene.js';

const player = (id, at, motion) => ({
  id, team: 'offense', at,
  label: {zh: id, description: '测试示意', basis: 'author'},
  motion,
});
const line = (to, seconds) => ({type: 'line', to, seconds});
const lesson = (players, overrides = {}) => ({
  players,
  timeline: {duration: 10, basis: 'illustration', note: '测试示意'},
  keyframes: [{id: 'start', at: 0, label: '开始', cue: '看站位'}],
  ...overrides,
});
const position = (scene, id) => scene.players.find(p => p.id === id).position;
const nearPoint = (actual, expected, tolerance = 1e-7) => {
  assert.ok(Math.hypot(actual[0] - expected[0], actual[1] - expected[1]) <= tolerance,
    `${JSON.stringify(actual)} should be near ${JSON.stringify(expected)}`);
};
const freeze = value => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

test('real Hitch shows its outgoing segment before 7 seconds and its return segment from the turn', () => {
  const hitch = freeze(load(readFileSync(new URL('../content/lessons/route-hitch.yaml', import.meta.url), 'utf8')));
  const receiver = hitch.players.find(p => p.id === 'X');
  const [outgoing, returning] = receiver.motion.steps;
  const fullRoutes = getRoutes(hitch);
  for (const at of [0, 6.999, 7, 10, 0, 7]) {
    const active = getActiveRoute(receiver, at);
    assert.deepEqual(active.from, at < 7 ? receiver.at : outgoing.to);
    assert.equal(active.steps.length, 1);
    assert.equal(active.steps[0], at < 7 ? outgoing : returning);
    assert.equal(Math.sign(active.steps[0].to[1] - active.from[1]), at < 7 ? -1 : 1);
  }
  assert.deepEqual(getRoutes(hitch), fullRoutes, 'full route geometry stays available unchanged');
  assert.equal(getActiveRoute(hitch.players.find(p => p.id === 'QB'), 5), undefined);
});

test('active segment keeps the previous run through pauses and switches at exact step boundaries', () => {
  const runner = freeze(player('X', [2, 3], {type: 'path', startAt: 2, steps: [
    line([2, 8], 3), {type: 'pause', seconds: 2}, line([9, 8], 2), {type: 'pause', seconds: 1},
  ]}));
  for (const at of [0, 1.999, 2, 4.999, 5, 6.999]) {
    assert.deepEqual(getActiveRoute(runner, at), {from: [2, 3], steps: [runner.motion.steps[0]]});
  }
  for (const at of [7, 9, 10, 100]) {
    assert.deepEqual(getActiveRoute(runner, at), {from: [2, 8], steps: [runner.motion.steps[2]]});
  }
  assert.equal(getActiveRoute(runner, 4).steps[0], runner.motion.steps[0], 'reverse seeking is independent of previous calls');
  const waiting = freeze(player('Y', [2, 3], {type: 'path', startAt: 2, steps: [
    {type: 'pause', seconds: 3}, line([2, 8], 2),
  ]}));
  for (const at of [0, 2, 4.999]) assert.equal(getActiveRoute(waiting, at), undefined);
  assert.deepEqual(getActiveRoute(waiting, 5), {from: [2, 3], steps: [waiting.motion.steps[1]]});
  const allWait = player('Z', [2, 3], {type: 'path', startAt: 0, steps: [{type: 'pause', seconds: 5}]});
  assert.equal(getActiveRoute(allWait, 100), undefined);
});

test('active segment requires a selected choice and preserves curve objects and control points', () => {
  const quadratic = {type: 'quadratic', control: [3, 7], to: [8, 9], seconds: 2};
  const cubic = {type: 'cubic', control1: [9, 10], control2: [12, 11], to: [15, 13], seconds: 3};
  const runner = freeze(player('X', [1, 2], {type: 'choice', startAt: 1, options: [
    {id: 'curves', title: 'Curves', steps: [quadratic, cubic]},
    {id: 'straight', title: 'Straight', steps: [line([1, 10], 5)]},
  ]}));
  assert.equal(getActiveRoute(runner, 4), undefined);
  assert.equal(getActiveRoute(runner, 4, {X: 'unknown'}), undefined);
  const first = getActiveRoute(runner, 0, {X: 'curves'});
  assert.deepEqual(first.from, [1, 2]);
  assert.equal(first.steps[0], quadratic);
  assert.equal(pathToSvg(first.from, first.steps), 'M 1 2 Q 3 7 8 9');
  const second = getActiveRoute(runner, 3, {X: 'curves'});
  assert.deepEqual(second.from, [8, 9]);
  assert.equal(second.steps[0], cubic);
  assert.equal(pathToSvg(second.from, second.steps), 'M 8 9 C 9 10 12 11 15 13');
  assert.equal(getActiveRoute(runner, 9, {X: 'curves'}).steps[0], cubic);
  assert.equal(getActiveRoute(runner, 4, {X: 'straight'}).steps[0], runner.motion.options[1].steps[0]);
  first.from[0] = 100;
  second.from[0] = 100;
  assert.deepEqual(runner.at, [1, 2]);
  assert.deepEqual(quadratic.to, [8, 9]);
  assert.equal(getActiveRoute(player('Q', [1, 2], {type: 'unspecified', note: 'Unknown'}), 2), undefined);
});

test('Hitch faces the live QB from the turn boundary, independently of the return path', () => {
  const data = lesson([
    player('X', [8,50], {type:'path', startAt:0, steps:[line([8,43],7), {...line([8,45],3),facePlayer:'QB'}]}),
    player('QB', [15,55], {type:'path', startAt:0, steps:[line([20,55],10)]}),
  ]);
  for(const at of [0,6.999,7,8.5,10,0,7]){
    const scene=getScene(data,at);
    const x=scene.players[0],qb=scene.players[1];
    assert.ok(x.facing,'the return route exposes its body direction');
    if(at<7) assert.deepEqual(x.facing,{direction:[0,-1]});
    else {
      const vector=qb.position.map((n,i)=>n-x.position[i]);
      const length=Math.hypot(...vector);
      nearPoint(x.facing.direction,vector.map(n=>n/length));
      assert.equal(x.facing.target,'QB');
      assert.equal(x.position[0],8,'body rotation must not change route geometry');
    }
  }
  const before=getScene(data,8.5);
  getScene(data,0);
  assert.deepEqual(getScene(data,8.5),before);
});

test('facing follows selected paths and remains finite for coincident players, waits and curve endpoints', () => {
  const data=lesson([
    player('X',[0,0],{type:'choice',startAt:1,prompt:'Pick',options:[
      {id:'return',title:'Return',steps:[
        {type:'quadratic',control:[0,4],to:[4,4],seconds:2},
        {type:'pause',seconds:1},
        {...line([4,2],2),facePlayer:'QB'},
        {type:'pause',seconds:1,facePlayer:'QB'},
      ]},
      {id:'straight',title:'Straight',steps:[line([0,10],5)]},
    ]}),
    player('QB',[4,2],{type:'still',note:'Reference'}),
  ]);
  assert.equal(getScene(data,4).players[0].facing,undefined,'unselected choice has no invented facing');
  assert.equal(getScene(data,4,{X:'straight'}).players[0].facing,undefined,'legacy option remains unchanged');
  for(const at of [0,2,3,3.5,4,5,6,7,10]){
    const facing=getScene(data,at,{X:'return'}).players[0].facing;
    assert.ok(facing.direction.every(Number.isFinite));
    assert.ok(Math.abs(Math.hypot(...facing.direction)-1)<1e-7);
  }
  nearPoint(getScene(data,3.5,{X:'return'}).players[0].facing.direction,[1,0],0.002);
  assert.deepEqual(getScene(data,10,{X:'return'}).players[0].facing.direction,[0,-1]);
});

test('independent start times, local pauses and end retention survive backward seeking', () => {
  const data = freeze(lesson([
    player('X', [0, 0], {type: 'path', startAt: 1, steps: [
      line([10, 0], 2), {type: 'pause', seconds: 2}, line([10, 10], 2),
    ]}),
    player('Y', [20, 0], {type: 'path', startAt: 3, steps: [line([20, 10], 4)]}),
  ]));
  nearPoint(position(getScene(data, 0.5), 'X'), [0, 0]);
  nearPoint(position(getScene(data, 2), 'X'), [5, 0]);
  nearPoint(position(getScene(data, 4), 'X'), [10, 0]);
  nearPoint(position(getScene(data, 4), 'Y'), [20, 2.5]);
  nearPoint(position(getScene(data, 6), 'X'), [10, 5]);
  nearPoint(position(getScene(data, 8), 'X'), [10, 10]);
  const middle = getScene(data, 4);
  getScene(data, 9);
  getScene(data, 0);
  assert.deepEqual(getScene(data, 4), middle);
  assert.equal(getScene(data, -20).time, 0);
  assert.equal(getScene(data, 200).time, 10);
});

test('curve motion follows traveled distance rather than the Bezier parameter', () => {
  const data = lesson([
    player('Q', [0, 0], {type: 'path', startAt: 0, steps: [
      {type: 'quadratic', control: [0, 0], to: [100, 0], seconds: 4},
    ]}),
    player('C', [0, 10], {type: 'path', startAt: 0, steps: [
      {type: 'cubic', control1: [0, 10], control2: [0, 10], to: [100, 10], seconds: 4},
    ]}),
  ]);
  // These collinear curves have nonuniform parameter speed (t² and t³),
  // but their half-duration position must be halfway along the straight line.
  nearPoint(position(getScene(data, 2), 'Q'), [50, 0], 0.005);
  nearPoint(position(getScene(data, 2), 'C'), [50, 10], 0.005);
  nearPoint(position(getScene(data, 1), 'C'), [25, 10], 0.005);
  nearPoint(position(getScene(data, 4), 'C'), [100, 10]);
});

test('a genuinely bent curve stays on its geometry at equal-distance timing', () => {
  const data = lesson([player('X', [0, 0], {type: 'path', startAt: 0, steps: [
    {type: 'quadratic', control: [0, 100], to: [100, 100], seconds: 4},
  ]})]);
  // Symmetry places the half-length point at t=.5 on this particular curve.
  nearPoint(position(getScene(data, 2), 'X'), [25, 75], 0.01);
  const quarter = position(getScene(data, 1), 'X');
  assert.ok(quarter[0] > 0 && quarter[0] < 6.25,
    'the faster first part reaches a quarter of the arc length before t=.25');
  nearPoint(position(getScene(data, 0), 'X'), [0, 0]);
  nearPoint(position(getScene(data, 10), 'X'), [100, 100]);
});

test('all choice players must choose valid options before any player advances', () => {
  const options = [
    {id: 'left', title: '左边', steps: [line([0, 10], 4)]},
    {id: 'right', title: '右边', steps: [line([20, 10], 4)]},
  ];
  const data = lesson([
    player('X', [10, 0], {type: 'choice', startAt: 0, prompt: '选择演示', options}),
    player('Y', [10, 20], {type: 'choice', startAt: 0, prompt: '选择演示', options}),
    player('Z', [0, 0], {type: 'path', startAt: 0, steps: [line([10, 0], 4)]}),
  ]);
  const blocked = getScene(data, 2, {X: 'right'});
  assert.equal(blocked.ready, false);
  assert.equal(blocked.time, 0);
  assert.deepEqual(blocked.missingChoices, ['Y']);
  nearPoint(position(blocked, 'Z'), [0, 0]);
  assert.deepEqual(getScene(data, 2, {X: 'missing', Y: 'left'}).missingChoices, ['X']);
  const ready = getScene(data, 2, {X: 'right', Y: 'left'});
  assert.equal(ready.ready, true);
  nearPoint(position(ready, 'X'), [15, 5]);
  nearPoint(position(ready, 'Y'), [5, 15]);
  nearPoint(position(ready, 'Z'), [5, 0]);
  const routes = getRoutes(data, {X: 'right', Y: 'left'});
  assert.equal(routes.length, 5);
  assert.deepEqual(routes.filter(route => route.selected).map(route => [route.playerId, route.optionId]),
    [['X', 'right'], ['Y', 'left'], ['Z', undefined]]);
  assert.equal(getRoutes(data).filter(route => route.optionId && route.selected).length, 0);
});

test('keyframe views replace rather than accumulate and are rebuilt on backward seeks', () => {
  const data = lesson([player('R', [5, 5], {type: 'unspecified', note: '动作未注明'})], {
    zones: [{id: 'front'}, {id: 'back'}],
    assignments: [{id: 'coverage'}, {id: 'rush'}],
    keyframes: [
      {id: 'start', at: 0, view: {zoneIds: [], assignmentIds: []}},
      {id: 'front', at: 3, view: {zoneIds: ['front'], assignmentIds: ['coverage']}},
      {id: 'back', at: 6, view: {zoneIds: ['back'], assignmentIds: []}},
      {id: 'all', at: 9},
    ],
  });
  assert.deepEqual(getScene(data, 0).zones, []);
  assert.equal(getScene(data, 2.999).keyframe.id, 'start');
  assert.deepEqual(getScene(data, 3).zones.map(zone => zone.id), ['front']);
  assert.deepEqual(getScene(data, 6).zones.map(zone => zone.id), ['back']);
  assert.deepEqual(getScene(data, 6).assignments, []);
  assert.deepEqual(getScene(data, 9).assignments.map(a => a.id), ['coverage', 'rush']);
  assert.deepEqual(getScene(data, 9).zones.map(zone => zone.id), ['front', 'back']);
  assert.deepEqual(getScene(data, 4).assignments.map(a => a.id), ['coverage']);
  nearPoint(position(getScene(data, 9), 'R'), [5, 5]);
});

test('static formations and unspecified actions preserve their distinct meanings', () => {
  const data = lesson([
    player('Q', [10, 10], {type: 'unspecified', note: '原图只给起点'}),
    player('C', [20, 10], {type: 'still', note: '本次明确留在原地'}),
  ], {kind: 'formation', timeline: {duration: 0}});
  const scene = getScene(data, 50);
  assert.equal(scene.time, 0);
  assert.equal(scene.ready, true);
  assert.deepEqual(scene.players.map(p => p.position), [[10, 10], [20, 10]]);
  assert.deepEqual(scene.players.map(p => p.motion.type), ['unspecified', 'still']);
  assert.deepEqual(getRoutes(data), []);
});

test('path drawing retains all geometry and omits pauses for both routes and guides', () => {
  const steps = [
    line([3, 4], 1),
    {type: 'pause', seconds: 2},
    {type: 'quadratic', control: [4, 5], to: [6, 7], seconds: 2},
    {type: 'cubic', control1: [8, 9], control2: [10, 11], to: [12, 13], seconds: 2},
  ];
  assert.equal(pathToSvg([1, 2], steps), 'M 1 2 L 3 4 Q 4 5 6 7 C 8 9 10 11 12 13');
  assert.equal(pathToSvg([1, 2], [{type: 'line', to: [3, 4]}]), 'M 1 2 L 3 4');
});

test('degenerate curves remain finite and changed geometry cannot reuse stale lengths', () => {
  const step = {type: 'cubic', control1: [0, 0], control2: [0, 0], to: [0, 0], seconds: 4};
  const data = lesson([player('X', [0, 0], {type: 'path', startAt: 0, steps: [step]})]);
  nearPoint(position(getScene(data, 2), 'X'), [0, 0]);
  step.to = [100, 0];
  nearPoint(position(getScene(data, 2), 'X'), [50, 0], 0.005);
});

test('reviewed content examples reconstruct without special handling by lesson ID', () => {
  const pack = JSON.parse(readFileSync(new URL('../content-format/examples.flagbook.json', import.meta.url), 'utf8'));
  for (const item of pack.lessons) {
    const choices = Object.fromEntries(item.players
      .filter(p => p.motion.type === 'choice')
      .map(p => [p.id, p.motion.options[0].id]));
    const snapshot = JSON.stringify(item);
    const end = getScene(item, item.timeline.duration, choices);
    const start = getScene(item, 0, choices);
    assert.equal(end.ready, true);
    assert.deepEqual(start.players.map(p => p.position), item.players.map(p => p.at));
    assert.deepEqual(getScene(item, item.timeline.duration, choices), end);
    assert.equal(JSON.stringify(item), snapshot);
    for (const route of getRoutes(item, choices)) {
      assert.ok(pathToSvg(route.from, route.steps).startsWith('M '));
    }
  }
});
