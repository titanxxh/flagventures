import test from 'node:test';
import assert from 'node:assert/strict';
import {dump} from 'js-yaml';
import {validateLesson, parseLesson, prepareImport, ContentError} from '../app/validation.js';

function lesson() {
  return {
    format: 'flag-lesson', version: 1, id: 'facing-route', kind: 'route',
    title: {zh: '面向传球人'}, summary: '跑完后回头看 QB。',
    field: {width: 30, height: 70, attackDirection: 'up', lineOfScrimmageY: 50},
    players: [
      {id: 'X', team: 'offense', at: [8, 50], label: {zh: '接球手', description: '回身接应。', basis: 'author'},
        motion: {type: 'path', startAt: 0, steps: [
          {type: 'line', to: [8, 43], seconds: 3},
          {type: 'pause', seconds: 2, facePlayer: 'QB'},
        ]}},
      {id: 'QB', team: 'offense', at: [15, 55], label: {zh: '四分卫', description: '传球方向参照。', basis: 'author'},
        motion: {type: 'still', note: '教学位置参照。'}},
    ],
    timeline: {duration: 5, basis: 'illustration', note: '仅为教学时间。'},
    keyframes: [{id: 'start', at: 0, label: '起点', cue: '找到队友。'}],
  };
}
function pack(data) {
  return {format: 'flag-playbook', version: 1, title: '练习', lessons: [data],
    sections: [{id: 'routes', title: '路线', lessonIds: [data.id]}]};
}

test('facePlayer is optional on every timed step and survives YAML and full-pack import/export', () => {
  const examples = [
    {type: 'line', to: [8, 44], seconds: 1},
    {type: 'pause', seconds: 1},
    {type: 'quadratic', control: [9, 45], to: [10, 44], seconds: 1},
    {type: 'cubic', control1: [9, 45], control2: [10, 44], to: [11, 43], seconds: 1},
  ];
  for (const step of examples) {
    const data = lesson();
    data.players[0].motion.steps = [{...step, facePlayer: 'QB'}];
    assert.equal(validateLesson(data).lesson, data);
    const parsed = parseLesson(dump(data), 'facing.yaml');
    assert.deepEqual(parsed, data);
    const originalPack = pack(data);
    const imported = prepareImport(pack(lesson()), [{name: 'facing.flagbook.json', text: JSON.stringify(originalPack)}]);
    assert.deepEqual(imported.pack, originalPack);
    delete data.players[0].motion.steps[0].facePlayer;
    assert.equal(validateLesson(data).lesson, data);
  }
});

test('all choice branches validate facing targets, including unselected paths', () => {
  const data = lesson();
  data.players[0].motion = {type: 'choice', startAt: 0, prompt: '选择路线', options: [
    {id: 'return', title: '回身', steps: [{type: 'line', to: [8, 43], seconds: 5, facePlayer: 'QB'}]},
    {id: 'wait', title: '等待', steps: [{type: 'pause', seconds: 5, facePlayer: 'QB'}]},
  ]};
  assert.equal(validateLesson(data).lesson, data);
  data.players[0].motion.options[1].steps[0].facePlayer = 'missing';
  assert.throws(() => validateLesson(data), error => error instanceof ContentError && /wait.*facePlayer/.test(error.field) && /不存在/.test(error.message));
});

test('facing references cannot target a missing player or the same player', () => {
  const data = lesson();
  data.players[0].motion.steps[1].facePlayer = 'missing';
  assert.throws(() => validateLesson(data), error => error instanceof ContentError && /facePlayer/.test(error.field) && /不存在/.test(error.message));
  data.players[0].motion.steps[1].facePlayer = 'X';
  assert.throws(() => validateLesson(data), /facePlayer.*面向目标不能是球员自己/);
});

test('a moving target and mutual facing are valid because target positions do not depend on facing', () => {
  const data = lesson();
  data.players[1].motion = {type: 'path', startAt: 0, steps: [
    {type: 'line', to: [18, 56], seconds: 5, facePlayer: 'X'},
  ]};
  assert.equal(validateLesson(data).lesson, data);
});

test('facing only accepts player identifiers on timed steps, never on static geometry or translation fields', () => {
  for (const value of ['', 5, null, 'not an id']) {
    const data = lesson(); data.players[0].motion.steps[1].facePlayer = value;
    assert.throws(() => validateLesson(data), /facePlayer/);
  }
  const data = lesson();
  delete data.players[0].motion.steps[1].facePlayer;
  data.assignments = [{id: 'rush', type: 'rush', player: 'X', guide: {from: [8, 50],
    segments: [{type: 'line', to: [15, 55], facePlayer: 'QB'}]}}];
  assert.throws(() => validateLesson(data), /guide.*facePlayer.*不认识/);
  delete data.assignments;
  data.players[0].motion.facePlayer = 'QB';
  assert.throws(() => validateLesson(data), /motion.facePlayer.*不认识/);
  delete data.players[0].motion.facePlayer;
  data.translations = {en: {'players.X.motion.steps.1.facePlayer': 'Quarterback'}};
  assert.throws(() => validateLesson(data), /展示文字/);
});
