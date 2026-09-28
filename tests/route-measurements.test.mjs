import test from 'node:test';
import assert from 'node:assert/strict';
import {dump} from 'js-yaml';
import {getRouteMeasurements} from '../app/route-measurements.js';
import {localizeLesson, translationFields} from '../app/localization.js';
import {validateLesson, parseLesson, ContentError} from '../app/validation.js';
import {getScene} from '../app/scene.js';

function route() {
  return {
    format: 'flag-lesson', version: 1, id: 'measured-route', kind: 'route',
    title: {zh: '距离示例'}, summary: '从开球线量深度。',
    source: {title: '教学资料', references: [{title: '路线说明', url: 'https://example.org/routes'}]},
    field: {width: 30, height: 70, attackDirection: 'up', lineOfScrimmageY: 50, unit: 'yard', endZoneDepth: 10},
    players: [{id: 'X', team: 'offense', at: [10, 50],
      label: {zh: '路线', description: '直跑五码再横切。', basis: 'author'},
      motion: {type: 'path', startAt: 0.5, steps: [
        {type: 'line', to: [10, 45], seconds: 2},
        {type: 'pause', seconds: 0.5},
        {type: 'quadratic', control: [6, 40], to: [4, 45], seconds: 2},
        {type: 'cubic', control1: [2, 44], control2: [3, 41], to: [4, 40], seconds: 2},
      ]}}],
    timeline: {duration: 8, basis: 'illustration', note: '秒数只用于动画。'},
    keyframes: [{id: 'start', at: 0, label: '起点', cue: '看开球线。'}],
    routeGuide: {player: 'X', note: '码数表示深度，不是累计路程。', marks: [
      {id: 'cut', step: 0, label: '横切', basis: 'source-example', note: '参考资料中的示例。', sourceReference: 0},
      {id: 'wait', step: 1, label: '停顿', basis: 'illustration', note: '讲解用停顿。'},
      {id: 'side', step: 2, label: '横向终点', basis: 'illustration', note: '横跑不会增加深度。'},
      {id: 'finish', step: 3, label: '终点', basis: 'illustration', note: '曲线终点。'},
    ]},
  };
}

test('measurements derive exact path endpoints and animation times, including waits and curves', () => {
  const lesson = route();
  validateLesson(lesson);
  const before = structuredClone(lesson);
  const marks = getRouteMeasurements(lesson);
  assert.deepEqual(marks.map(({position, at, depthYards}) => ({position, at, depthYards})), [
    {position: [10, 45], at: 2.5, depthYards: 5},
    {position: [10, 45], at: 3, depthYards: 5},
    {position: [4, 45], at: 5, depthYards: 5},
    {position: [4, 40], at: 7, depthYards: 10},
  ]);
  for (const mark of marks) assert.deepEqual(mark.position, getScene(lesson, mark.at).players[0].position);
  assert.equal(marks[0].sourceReference, 0);
  assert.equal(marks[0].basis, 'source-example');
  marks[0].position[0] = 99;
  assert.deepEqual(lesson, before);
  // A geometry edit drives the annotation too; there is no separately stored distance.
  lesson.players[0].motion.steps[0].to[1] = 44;
  assert.equal(getRouteMeasurements(lesson)[0].depthYards, 6);
});

test('depth follows attack direction and keeps negative values behind the line of scrimmage', () => {
  const lesson = route();
  lesson.field.attackDirection = 'down';
  lesson.field.lineOfScrimmageY = 20;
  lesson.players[0].at[1] = 20;
  lesson.players[0].motion.steps[0].to[1] = 25;
  assert.equal(getRouteMeasurements(lesson)[0].depthYards, 5);
  lesson.players[0].motion.steps[0].to[1] = 18;
  assert.equal(getRouteMeasurements(lesson)[0].depthYards, -2);
});

test('legacy v1 lessons without measured fields remain valid and produce no measurements', () => {
  const lesson = route();
  delete lesson.routeGuide;
  delete lesson.field.unit;
  delete lesson.field.endZoneDepth;
  assert.equal(validateLesson(lesson).lesson, lesson);
  assert.deepEqual(getRouteMeasurements(lesson), []);
  assert.deepEqual(parseLesson(dump(lesson)), lesson);
});

test('measured guides reject wrong units, non-routes, unsupported paths and missing references', () => {
  for (const [edit, field] of [
    [lesson => {delete lesson.field.unit; delete lesson.field.endZoneDepth;}, /routeGuide/],
    [lesson => {delete lesson.field.lineOfScrimmageY;}, /routeGuide/],
    [lesson => {lesson.kind = 'offense';}, /routeGuide/],
    [lesson => {lesson.routeGuide.player = 'missing';}, /routeGuide.player/],
    [lesson => {lesson.players[0].motion = {type: 'still', note: '原地'};}, /routeGuide.player/],
    [lesson => {lesson.players[0].motion = {type: 'choice', startAt: 0, prompt: '选择', options: [
      {id: 'a', title: '甲', steps: [{type: 'pause', seconds: 1}]},
      {id: 'b', title: '乙', steps: [{type: 'pause', seconds: 1}]},
    ]};}, /routeGuide.player/],
    [lesson => {lesson.routeGuide.marks[0].step = 4;}, /routeGuide.marks.cut.step/],
    [lesson => {lesson.routeGuide.marks[0].step = -1;}, /step/],
    [lesson => {lesson.routeGuide.marks[0].step = 0.5;}, /step/],
    [lesson => {lesson.routeGuide.marks[1].id = 'cut';}, /routeGuide.marks/],
    [lesson => {delete lesson.routeGuide.marks[0].sourceReference;}, /sourceReference/],
    [lesson => {lesson.routeGuide.marks[0].sourceReference = 1;}, /sourceReference/],
    [lesson => {delete lesson.source;}, /sourceReference/],
    [lesson => {lesson.routeGuide.marks[1].sourceReference = 1;}, /sourceReference/],
    [lesson => {lesson.routeGuide.marks[0].depthYards = 5;}, /depthYards/],
    [lesson => {lesson.routeGuide.marks[0].note = ' ';}, /note/],
    [lesson => {lesson.routeGuide.marks = [];}, /marks/],
  ]) {
    const lesson = route(); edit(lesson);
    assert.throws(() => validateLesson(lesson), error => error instanceof ContentError && field.test(error.message));
  }
});

test('end zones require yard units, positive depth and remaining field space', () => {
  for (const edit of [
    lesson => {delete lesson.field.unit;},
    lesson => {lesson.field.unit = 'meter';},
    lesson => {lesson.field.endZoneDepth = 0;},
    lesson => {lesson.field.endZoneDepth = 35;},
    lesson => {lesson.field.endZoneDepth = 40;},
  ]) {
    const lesson = route(); delete lesson.routeGuide; edit(lesson);
    assert.throws(() => validateLesson(lesson), /field\.(unit|endZoneDepth)/);
  }
});

test('guide translations use stable mark IDs, preserve measurement data and fall back to original text', () => {
  const lesson = route();
  lesson.translations = {en: {
    'routeGuide.note': 'Depth is measured from the line of scrimmage.',
    'routeGuide.marks.cut.label': 'Cut',
    'routeGuide.marks.cut.note': 'Example from the reference.',
  }};
  validateLesson(lesson);
  assert.ok(translationFields(lesson).has('routeGuide.marks.cut.label'));
  const en = localizeLesson(lesson, 'en');
  assert.equal(en.routeGuide.marks[0].label, 'Cut');
  assert.equal(en.routeGuide.marks[1].label, lesson.routeGuide.marks[1].label);
  assert.deepEqual(getRouteMeasurements(en).map(({position, at, depthYards}) => ({position, at, depthYards})),
    getRouteMeasurements(lesson).map(({position, at, depthYards}) => ({position, at, depthYards})));
  assert.deepEqual(parseLesson(dump(lesson)), lesson);
  lesson.routeGuide.marks.reverse();
  assert.equal(localizeLesson(lesson, 'en').routeGuide.marks.at(-1).label, 'Cut');
  lesson.translations.en['routeGuide.marks.cut.step'] = '1';
  assert.throws(() => validateLesson(lesson), /展示文字/);
});
