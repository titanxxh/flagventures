import test from 'node:test';
import assert from 'node:assert/strict';
import {dump} from 'js-yaml';
import {getBallState, resolveBallScenario} from '../app/ball.js';
import {getScene, positionAt} from '../app/scene.js';
import {localizeLesson} from '../app/localization.js';
import {parseLesson, prepareImport, validateLesson} from '../app/validation.js';

const clone = value => structuredClone(value);
const still = () => ({type: 'still', note: '教学站位'});
const line = (to, seconds) => ({type: 'line', to, seconds});
const pause = seconds => ({type: 'pause', seconds});
const path = (...steps) => ({type: 'path', startAt: 0, steps});
const player = (id, at, motion = still()) => ({id, team: 'offense', at,
  label: {zh: id, description: '教学球员', basis: 'author'}, motion});
const event = (id, type, from, to, at, endAt) => ({id, type, from,
  ...(to ? {to} : {}), at, ...(endAt === undefined ? {} : {endAt}),
  label: `${id} 开始`, cue: `${id} 看球`,
  ...(endAt === undefined ? {} : {endLabel: `${id} 完成`, endCue: `${id} 看结果`})});
function lesson() {
  return {
    format: 'flag-lesson', version: 1, id: 'ball-example', kind: 'offense',
    title: {zh: '球路线示范'}, summary: '看球如何到队友手里。',
    field: {width: 100, height: 55, attackDirection: 'up', lineOfScrimmageY: 35},
    players: [player('C', [50, 35]),
      player('Q', [50, 39], path(pause(1), line([50, 40], 2), pause(7))),
      player('X', [20, 35], path(line([40, 15], 10))),
      player('Y', [50, 40], path(pause(3), line([40, 25], 7)))],
    timeline: {duration: 10, basis: 'illustration', note: '教学时钟'},
    keyframes: [{id: 'start', at: 0, label: '起点', cue: '看站位'},
      {id: 'old-middle', at: 2, label: '旧讲解', cue: '看路线', view: {zoneIds: [], assignmentIds: []}},
      {id: 'end', at: 10, label: '结束', cue: '回想'}],
    ball: {initialOwner: 'C', defaultScenario: 'throw', note: '一种教学情形，不是必传顺序。', scenarios: [
      {id: 'throw', title: '传给 X', note: '本次选择 X；时刻仅为教学设置。', basis: 'illustration', events: [
        event('snap', 'snap', 'C', 'Q', 0.25, 0.75),
        event('pump', 'pump-fake', 'Q', undefined, 2, 2.5),
        event('pass', 'pass', 'Q', 'X', 4, 5),
      ]},
      {id: 'run', title: '交给 Y 跑', note: '先假交再真交的教学情形。', basis: 'illustration', events: [
        event('snap', 'snap', 'C', 'Q', 0.25, 0.75),
        event('fake', 'fake-handoff', 'Q', 'Y', 2.5, 2.75),
        event('give', 'handoff', 'Q', 'Y', 3),
        event('pump', 'pump-fake', 'Y', undefined, 4, 4.5),
      ]},
    ]},
  };
}
const pack = (...lessons) => ({format: 'flag-playbook', version: 1, title: '球路线手册', lessons,
  sections: [{id: 'plays', title: '战术', lessonIds: lessons.map(item => item.id)}]});
const near = (actual, expected, epsilon = 1e-8) => assert.ok(
  Math.hypot(...actual.map((value, index) => value - expected[index])) <= epsilon,
  `${JSON.stringify(actual)} should equal ${JSON.stringify(expected)}`);
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
function resolve(data = lesson(), id) {
  const result = resolveBallScenario(data, id);
  return {...result, at: time => getBallState(result.lesson, time, result.choices, result.scenario)};
}
function rejects(edit, pattern) {
  const data = lesson(); edit(data);
  assert.throws(() => validateLesson(data, '球路线.yaml'), pattern);
}

test('optional ball data keeps old v1 scenes and unavailable scenarios unchanged', () => {
  const data = lesson(); delete data.ball;
  validateLesson(data);
  const resolved = resolveBallScenario(data);
  assert.equal(resolved.lesson, data);
  assert.deepEqual(resolved.choices, {});
  assert.equal(resolved.scenario, undefined);
  assert.equal(getBallState(data, 3), undefined);
  assert.equal(resolveBallScenario(lesson(), 'missing').scenario.id, 'throw');
});

test('scenario resolution preserves canonical data, overrides motion and merges event keyframes', () => {
  const data = lesson();
  data.ball.scenarios[0].motions = [{player: 'C', motion: {type: 'still', note: '留在开球位置'}}];
  data.keyframes[0].id = 'ball-event-0-start';
  const original = clone(data);
  const resolved = resolveBallScenario(freeze(data));
  assert.equal(resolved.lesson.players.find(p => p.id === 'C').motion.note, '留在开球位置');
  assert.equal(data.players.find(p => p.id === 'C').motion.note, '教学站位');
  assert.equal(resolved.lesson.keyframes.find(frame => frame.at === 2).label, 'pump 开始');
  assert.equal(resolved.lesson.keyframes.find(frame => frame.at === 2.5).label, 'pump 完成');
  assert.equal(resolved.lesson.keyframes.find(frame => frame.at === 5).cue, 'pass 看结果');
  assert.deepEqual(resolved.lesson.keyframes.find(frame => frame.at === 2.5).view,
    {zoneIds: [], assignmentIds: []});
  assert.equal(new Set(resolved.lesson.keyframes.map(frame => frame.id)).size, resolved.lesson.keyframes.length);
  assert.deepEqual(resolved.lesson.keyframes.map(frame => frame.at), [0, 0.25, 0.75, 2, 2.5, 4, 5, 10]);
  assert.deepEqual(data, original);
  const legacyCaptions = lesson();
  delete legacyCaptions.ball.scenarios[0].events[2].endLabel;
  delete legacyCaptions.ball.scenarios[0].events[2].endCue;
  assert.equal(resolveBallScenario(legacyCaptions).lesson.keyframes.find(frame => frame.at === 5).label, 'pass 开始');
});

test('snap and pass use release and catch positions with exact ownership boundaries and deterministic seeks', () => {
  const resolved = resolve(freeze(lesson()));
  const {at} = resolved;
  assert.equal(at(0).owner, 'C');
  assert.equal(at(0.249).owner, 'C');
  assert.equal(at(0.25).state, 'flight');
  assert.equal(at(0.25).owner, null);
  near(at(0.25).position, [50, 35]);
  assert.equal(at(0.75).state, 'held');
  assert.equal(at(0.75).owner, 'Q');
  near(at(0.75).position, [50, 39]);
  assert.equal(at(4).owner, null);
  near(at(4).position, [50, 40]);
  const middle = at(4.5);
  assert.equal(middle.progress, 0.5);
  near(middle.position, [40, 32.5]);
  near(middle.flights.find(flight => flight.id === 'pass').end, [30, 25]);
  assert.notDeepEqual(middle.flights[1].end, positionAt(resolved.lesson.players[2], 4.5), 'the ball does not home onto the receiver');
  assert.equal(at(5).owner, 'X');
  near(at(5).position, getScene(resolved.lesson, 5).players.find(p => p.id === 'X').position);
  near(at(9).position, [38, 17]);
  for (const time of [10, 4.5, 0, 5, 0.25, 4.5]) {
    assert.deepEqual(at(time).flights, middle.flights);
    assert.deepEqual(at(4.5), middle);
  }
  assert.deepEqual(at(-1), at(0));
  assert.deepEqual(at(Number.NaN), at(0));
  assert.deepEqual(at(100), at(10));
});

test('one ball follows handoffs and keeps possession throughout fake handoffs and pump fakes', () => {
  const {at, lesson: effective} = resolve(freeze(lesson()), 'run');
  for (const time of [2.49, 2.5, 2.6, 2.75, 2.999]) assert.equal(at(time).owner, 'Q');
  for (const time of [3, 3.5, 4, 4.25, 4.5, 10]) {
    assert.equal(at(time).state, 'held');
    assert.equal(at(time).owner, 'Y');
    near(at(time).position, positionAt(effective.players.find(p => p.id === 'Y'), time));
  }
  assert.equal(at(2.6).event.type, 'fake-handoff');
  assert.equal(at(4.25).event.type, 'pump-fake');
  assert.equal(at(3).event.type, 'handoff');
  assert.equal(at(2.999).owner, 'Q', 'reverse seeking restores the giver');
  assert.equal(at(5).flights.length, 1, 'only the snap flies; fake actions never create another ball');
});

test('time-independent carry intervals exclude all flights and change owners only on real transfers', () => {
  assert.deepEqual(resolve().at(0).carries, [
    {owner: 'C', at: 0, endAt: 0.25}, {owner: 'Q', at: 0.75, endAt: 4}, {owner: 'X', at: 5, endAt: 10},
  ]);
  assert.deepEqual(resolve(lesson(), 'run').at(10).carries, [
    {owner: 'C', at: 0, endAt: 0.25}, {owner: 'Q', at: 0.75, endAt: 3}, {owner: 'Y', at: 3, endAt: 10},
  ]);
  const data = lesson();
  data.ball.scenarios[0].events = [];
  assert.deepEqual(resolve(data).at(5).carries, [{owner: 'C', at: 0, endAt: 10}]);
  assert.equal(resolve(data).at(5).event, undefined);
});

test('selected motion branches and scenario overrides determine the actual catch point', () => {
  const data = lesson();
  data.players[2].motion = {type: 'choice', startAt: 0, prompt: '选择路线', options: [
    {id: 'left', title: '左边', steps: [line([10, 15], 10)]},
    {id: 'right', title: '右边', steps: [line([50, 15], 10)]},
  ]};
  data.ball.scenarios[0].choices = {X: 'right'};
  data.ball.scenarios[1].motions = [{player: 'X', motion: still()}];
  validateLesson(data);
  const resolved = resolve(data);
  near(resolved.at(5).position, [35, 25]);
  assert.equal(resolve(data, 'run').lesson.players[2].motion.type, 'still');
  assert.equal(data.players[2].motion.type, 'choice');
  resolved.choices.X = 'left';
  assert.equal(data.ball.scenarios[0].choices.X, 'right', 'runtime selection must not edit scenario data');
});

test('consecutive events may share an end/start boundary and the new event owns that keyframe', () => {
  const data = lesson();
  data.ball.scenarios[0].events[1].at = 0.75;
  data.ball.scenarios[0].events[1].endAt = 1;
  validateLesson(data);
  const resolved = resolve(data);
  assert.equal(resolved.lesson.keyframes.find(frame => frame.at === 0.75).label, 'pump 开始');
  assert.equal(resolved.at(0.75).event.type, 'pump-fake');
  assert.equal(resolved.at(0.75).owner, 'Q');
});

test('ball scenarios and captions survive YAML and package round trips with shared translated geometry', () => {
  const data = lesson();
  data.ball.scenarios[0].motions = [{player: 'C', motion: still()}];
  data.translations = {en: {
    'ball.note': 'An illustrated ball sequence.',
    'ball.scenarios.throw.title': 'Pass to X',
    'ball.scenarios.throw.note': 'An example, not a required target.',
    'ball.scenarios.throw.events.pass.label': 'Release',
    'ball.scenarios.throw.events.pass.cue': 'Watch the ball leave Q.',
    'ball.scenarios.throw.events.pass.endLabel': 'Catch',
    'ball.scenarios.throw.events.pass.endCue': 'X now has the ball.',
    'ball.scenarios.throw.motions.C.motion.note': 'Stay at the snap location.',
  }};
  validateLesson(data);
  assert.deepEqual(parseLesson(dump(data)), data);
  const imported = prepareImport(pack(), [{name: 'ball.yaml', text: dump(data)}]).pack;
  assert.deepEqual(imported.lessons[0], data);
  const restored = prepareImport(pack(), [{name: 'ball.flagbook.json', text: JSON.stringify(imported)}]).pack;
  assert.deepEqual(restored, imported);
  const english = localizeLesson(data, 'en');
  assert.equal(english.ball.scenarios[0].motions[0].motion.note, 'Stay at the snap location.');
  const localized = resolve(english);
  assert.equal(localized.lesson.keyframes.find(frame => frame.at === 4).label, 'Release');
  assert.equal(localized.lesson.keyframes.find(frame => frame.at === 5).label, 'Catch');
  for (const time of [0, 0.5, 2.25, 4.5, 5, 10]) {
    const zhState = resolve(data).at(time), enState = localized.at(time);
    assert.equal(zhState.owner, enState.owner);
    assert.deepEqual(zhState.position, enState.position);
    assert.deepEqual(zhState.flights, enState.flights);
  }
  data.translations.en['ball.scenarios.throw.events.pass.to'] = 'Receiver';
  assert.throws(() => validateLesson(data), /翻译只能引用/);
});

test('ball schema remains strict and rejects unsupported kinds, fields, versions and event shapes', () => {
  rejects(data => {data.version = 2;}, /版本 1/);
  rejects(data => {data.ball.guess = true;}, /ball.guess.*不认识/);
  rejects(data => {data.ball.scenarios[0].events[0].velocity = 10;}, /velocity.*不认识/);
  rejects(data => {data.ball.scenarios[0].events[0].type = 'teleport';}, /只能选/);
  rejects(data => {delete data.ball.scenarios[0].events[0].endAt;}, /endAt.*缺少/);
  rejects(data => {delete data.ball.scenarios[0].events[0].to;}, /to.*缺少/);
  rejects(data => {data.ball.scenarios[1].events[2].endAt = 4;}, /不符合格式/);
  rejects(data => {data.ball.scenarios[0].events[1].to = 'X';}, /不符合格式/);
  rejects(data => {data.ball.scenarios[1].events[2].endLabel = '结束';}, /结束说明需要/);
  rejects(data => {data.ball.note = ' ';}, /格式/);
  rejects(data => {data.kind = 'route';}, /仅适用于/);
  rejects(data => {data.ball.scenarios = [];}, /至少需要/);
});

test('every scenario validates IDs, current possession, all references and source attribution', () => {
  rejects(data => {data.ball.initialOwner = 'missing';}, /initialOwner.*不存在/);
  rejects(data => {data.ball.defaultScenario = 'missing';}, /默认球路情形不存在/);
  rejects(data => {data.ball.scenarios[1].id = 'throw';}, /编号.*重复/);
  rejects(data => {data.ball.scenarios[1].events[1].id = 'snap';}, /编号.*重复/);
  rejects(data => {data.ball.scenarios[1].events[2].from = 'C';}, /当前持球人/);
  rejects(data => {data.ball.scenarios[0].events[2].to = 'unknown';}, /不存在/);
  rejects(data => {data.ball.scenarios[0].events[2].to = 'Q';}, /不能是持球人自己/);
  rejects(data => {data.ball.scenarios[0].basis = 'source';}, /可识别的来源/);
  const sourced = lesson(); sourced.source = {title: '教练示例'};
  sourced.ball.scenarios[0].basis = 'coach';
  validateLesson(sourced);
});

test('ball event order is bounded, non-overlapping and has positive explicit durations', () => {
  rejects(data => {data.ball.scenarios[0].events[2].at = 2.25;}, /时间不能重叠/);
  rejects(data => {data.ball.scenarios[0].events[1].at = 0.25;}, /严格递增/);
  rejects(data => {data.ball.scenarios[0].events[0].endAt = 0.25;}, /结束时间必须晚于/);
  rejects(data => {data.ball.scenarios[0].events[0].at = -1;}, /不得小于/);
  rejects(data => {data.ball.scenarios[0].events[2].endAt = 11;}, /不能超过/);
  rejects(data => {data.ball.scenarios[0].events[2].endAt = Infinity;}, /有限/);
});

test('real and fake handoffs must happen within the authored field-scaled reach', () => {
  rejects(data => {data.players[3].at[0] = 60;}, /两名球员必须靠近/);
  for (const type of ['handoff', 'fake-handoff']) {
    const data = lesson();
    data.field = {width: 30, height: 70, attackDirection: 'up'};
    data.players = [player('Q', [10, 20]), player('Y', [10.3, 20])];
    data.ball.initialOwner = 'Q';
    data.ball.scenarios = [{id: 'throw', title: '交球', note: '距离测试', basis: 'illustration',
      events: [event('give', type, 'Q', 'Y', 1)]}];
    validateLesson(data);
    data.players[1].at[0] = 10.31;
    assert.throws(() => validateLesson(data), /两名球员必须靠近/);
  }
});

test('scenario choices and overrides validate every branch, coordinate, duration and facing target', () => {
  rejects(data => {data.ball.scenarios[0].motions = [{player: 'missing', motion: still()}];}, /不存在/);
  rejects(data => {data.ball.scenarios[0].motions = [{player: 'Q', motion: still()}, {player: 'Q', motion: still()}];}, /重复覆盖/);
  rejects(data => {data.ball.scenarios[0].motions = [{player: 'Q', motion: path(line([101, 40], 2))}];}, /画布内/);
  rejects(data => {data.ball.scenarios[0].motions = [{player: 'Q', motion: path(line([50, 40], 11))}];}, /超过 timeline/);
  rejects(data => {data.ball.scenarios[0].motions = [{player: 'Q', motion: path({...line([50, 40], 2), facePlayer: 'missing'})}];}, /不存在/);
  rejects(data => {data.ball.scenarios[0].choices = {Q: 'run'};}, /仍有分支动作/);
  rejects(data => {data.ball.scenarios[0].choices = {missing: 'run'};}, /不存在/);
  const data = lesson();
  data.ball.scenarios[0].motions = [{player: 'X', motion: {type: 'choice', startAt: 0, prompt: '选择', options: [
    {id: 'first', title: '第一', steps: [line([10, 10], 10)]},
    {id: 'second', title: '第二', steps: [line([20, 10], 10)]},
  ]}}];
  assert.throws(() => validateLesson(data), /必须选择所有球员/);
  data.ball.scenarios[0].choices = {X: 'missing'};
  assert.throws(() => validateLesson(data), /动作选项不存在/);
  data.ball.scenarios[0].choices.X = 'first';
  validateLesson(data);
  data.ball.scenarios[0].motions[0].motion.options[1].steps[0].to = [200, 10];
  assert.throws(() => validateLesson(data), /画布内/, 'even an unselected override branch is checked');
});

test('authored path and choice notes describe and translate the effective scenario without weakening validation', () => {
  const data = lesson();
  data.players[2].motion.note = '沿原图向前接应。';
  data.ball.scenarios[1].motions = [{player: 'Y', motion: {
    ...clone(data.players[3].motion), note: '先等 Q 交球，再持球向前跑。',
  }}];
  data.ball.scenarios[0].motions = [{player: 'X', motion: {
    type: 'choice', startAt: 0, note: '本次选择向内接球。', prompt: '选择路线', options: [
      {id: 'inside', title: '向内', steps: [line([40, 15], 10)]},
      {id: 'outside', title: '向外', steps: [line([10, 15], 10)]},
    ],
  }}];
  data.ball.scenarios[0].choices = {X: 'inside'};
  data.translations = {en: {
    'players.X.motion.note': 'Run forward on the original route.',
    'ball.scenarios.run.motions.Y.motion.note': 'Wait for Q to hand off, then carry the ball forward.',
    'ball.scenarios.throw.motions.X.motion.note': 'This example selects the inside receiving route.',
  }};
  assert.deepEqual(parseLesson(dump(data)), data);
  const english = localizeLesson(data, 'en');
  assert.equal(english.players[2].motion.note, 'Run forward on the original route.');
  const run = resolveBallScenario(english, 'run');
  assert.equal(run.lesson.players[3].motion.note, 'Wait for Q to hand off, then carry the ball forward.');
  assert.equal(resolveBallScenario(english, 'throw').lesson.players[2].motion.note,
    'This example selects the inside receiving route.');
  assert.deepEqual(run.lesson.players[3].motion.steps, data.players[3].motion.steps);
  const invalid = clone(data);
  invalid.ball.scenarios[1].motions[0].motion.note = ' ';
  assert.throws(() => validateLesson(invalid), /note.*格式/);
  invalid.ball.scenarios[1].motions[0].motion.note = '有效说明';
  invalid.ball.scenarios[1].motions[0].motion.extra = true;
  assert.throws(() => validateLesson(invalid), /extra.*不认识/);
});
