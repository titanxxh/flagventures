import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseLesson} from '../app/validation.js';
import {positionAt} from '../app/scene.js';
import {getBallState, resolveBallScenario} from '../app/ball.js';
import {localizeLesson, translationFields} from '../app/localization.js';

const ids = ['hb-dive', 'crossbuck', 'end-around', 'reverse', 'double-reverse',
  'fake-double-reverse', 'fake-triple-reverse', 'hb-option', 'qb-option'];
const lessons = ids.map(id => parseLesson(readFileSync(
  new URL(`../content/lessons/${id}.yaml`, import.meta.url), 'utf8'), `${id}.yaml`));
const player = (lesson, id) => lesson.players.find(item => item.id === id);
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const context = (lesson, scenario) => `${lesson.id}/${scenario.id}`;
const forwardDepth = (lesson, point) =>
  (lesson.field.attackDirection === 'up' ? -1 : 1) * (point[1] - lesson.field.lineOfScrimmageY);

const chains = {
  'hb-dive': [['snap:C:Q', 'handoff:Q:Y']],
  crossbuck: [['snap:C:Q', 'fake-handoff:Q:Z', 'handoff:Q:Y'],
    ['snap:C:Q', 'fake-handoff:Q:Y', 'handoff:Q:Z']],
  'end-around': [['snap:C:Q', 'handoff:Q:Z']],
  reverse: [['snap:C:Q', 'handoff:Q:Z']],
  'double-reverse': [['snap:C:Q', 'handoff:Q:X', 'handoff:X:Z']],
  'fake-double-reverse': [['snap:C:Q', 'handoff:Q:X', 'fake-handoff:X:Z']],
  'fake-triple-reverse': [['snap:C:Q', 'handoff:Q:Y', 'handoff:Y:Z', 'fake-handoff:Z:X']],
  'hb-option': [['snap:C:Q', 'handoff:Q:Y', 'pump-fake:Y:']],
  'qb-option': [['snap:C:Y', 'handoff:Y:Q'], ...['C', 'X', 'Y', 'Z']
    .map(id => ['snap:C:Y', 'handoff:Y:Q', `pass:Q:${id}`])],
};

test('all nine run lessons provide 14 explicit teaching scripts with complete possession chains', () => {
  assert.equal(lessons.reduce((n, lesson) => n + lesson.ball.scenarios.length, 0), 14);
  for (const lesson of lessons) {
    assert.equal(lesson.kind, 'run');
    assert.equal(lesson.ball.initialOwner, 'C', lesson.id);
    assert.equal(lesson.timeline.duration, 12, lesson.id);
    assert.match(lesson.timeline.note, /10 秒.*2 秒/, lesson.id);
    assert.match(lesson.ball.note, /教学编排/, lesson.id);
    assert.ok(lesson.ball.scenarios.some(item => item.id === lesson.ball.defaultScenario), lesson.id);
    assert.deepEqual(lesson.ball.scenarios.map(scenario => scenario.events
      .map(event => `${event.type}:${event.from}:${event.to || ''}`)), chains[lesson.id], lesson.id);
    for (const scenario of lesson.ball.scenarios) {
      const where = context(lesson, scenario);
      assert.equal(scenario.basis, 'illustration', where);
      assert.match(scenario.note, /教学/, where);
      assert.match(scenario.note, /会合点.*配速/, where);
      assert.deepEqual(scenario.motions.map(item => item.player).sort(), ['C', 'Q', 'X', 'Y', 'Z'], where);
      for (const override of scenario.motions) {
        assert.ok(override.motion.note?.trim(), `${where}/${override.player}: describe the selected movement, not the source route`);
      }
      assert.deepEqual([scenario.events[0].at, scenario.events[0].endAt], [0, .35], where);
      for (const event of scenario.events) if (event.endAt !== undefined) {
        assert.ok(event.endLabel && event.endCue, `${where}/${event.id}: identify action completion`);
        assert.notEqual(event.endLabel, event.label, `${where}/${event.id}: distinguish start and end`);
      }
    }
    // The preserved source drawing remains available independently of the script.
    for (const item of lesson.players) if (item.motion.type === 'path') {
      assert.equal(item.motion.startAt, 0, `${lesson.id}/${item.id}: source timing retained`);
      assert.ok(Math.abs(item.motion.steps.reduce((n, step) => n + step.seconds, 0) - 10) < 1e-5, lesson.id);
    }
  }
});

test('handoffs meet in the backfield, fake exchanges keep possession, and the ball follows the final carrier', () => {
  for (const lesson of lessons) for (const authored of lesson.ball.scenarios) {
    const before = JSON.stringify(lesson);
    const {lesson: resolved, choices, scenario} = resolveBallScenario(lesson, authored.id);
    const where = context(lesson, scenario);
    let owner = 'C';
    let occupiedUntil = 0;
    const snap = scenario.events[0];
    for (let at = snap.endAt; at < scenario.events[1].at; at += .1) {
      assert.ok(forwardDepth(lesson, positionAt(player(resolved, snap.to), at, choices)) < 0,
        `${where}: initial snap receiver stays behind the line while carrying`);
    }
    for (const event of scenario.events) {
      assert.equal(event.from, owner, `${where}/${event.id}: current holder initiates the action`);
      assert.ok(event.at >= occupiedUntil, `${where}: actions do not overlap`);
      occupiedUntil = event.endAt ?? event.at;
      assert.ok(occupiedUntil <= lesson.timeline.duration, where);
      if (event.type === 'handoff' || event.type === 'fake-handoff') {
        const times = event.endAt === undefined ? [event.at] : [event.at, (event.at + event.endAt) / 2, event.endAt];
        for (const at of times) {
          const from = positionAt(player(resolved, event.from), at, choices);
          const to = positionAt(player(resolved, event.to), at, choices);
          assert.ok(distance(from, to) < 1e-6, `${where}/${event.id}@${at}: meet hand to hand`);
          assert.ok(forwardDepth(lesson, from) < 0 && forwardDepth(lesson, to) < 0, `${where}: exchange behind the line`);
        }
      }
      if (event.type === 'snap' || event.type === 'pass') {
        const middle = getBallState(resolved, (event.at + event.endAt) / 2, choices, scenario);
        assert.equal(middle.state, 'flight', where);
        assert.equal(middle.owner, null, where);
        owner = event.to;
      } else if (event.type === 'handoff') {
        assert.equal(getBallState(resolved, event.at - .0001, choices, scenario).owner, owner, where);
        owner = event.to;
      } else {
        for (const at of [event.at, (event.at + event.endAt) / 2, event.endAt]) {
          const ball = getBallState(resolved, at, choices, scenario);
          assert.equal(ball.owner, owner, `${where}: a fake does not move possession`);
          assert.deepEqual(ball.position, positionAt(player(resolved, owner), at, choices), where);
        }
      }
      assert.equal(getBallState(resolved, occupiedUntil, choices, scenario).owner, owner, where);
    }
    for (const at of [11, 12]) {
      const ball = getBallState(resolved, at, choices, scenario);
      assert.equal(ball.owner, owner, where);
      assert.deepEqual(ball.position, positionAt(player(resolved, owner), at, choices), where);
    }
    assert.ok(forwardDepth(lesson, positionAt(player(resolved, owner), 12, choices)) > 0, `${where}: final carrier advances`);
    for (const at of [12, 4, 7, .2, 2, 0, 6]) {
      const first = getBallState(resolved, at, choices, scenario);
      getBallState(resolved, 12, choices, scenario);
      assert.deepEqual(getBallState(resolved, at, choices, scenario), first, `${where}: seeking reconstructs the same state`);
    }
    assert.equal(JSON.stringify(lesson), before, `${where}: source lesson is not mutated`);
  }
});

test('QB Option names Y as the snap receiver and offers Q running or a forward pass to every other teammate', () => {
  const lesson = lessons.find(item => item.id === 'qb-option');
  const targets = [];
  for (const authored of lesson.ball.scenarios) {
    const {lesson: resolved, choices, scenario} = resolveBallScenario(lesson, authored.id);
    const where = context(lesson, scenario);
    assert.match(scenario.note, /Y.*初始 QB/, where);
    assert.match(scenario.events[0].cue, /Y.*初始 QB/, where);
    assert.match(scenario.events[1].cue, /Y.*接开球/, where);
    for (let at = .35; at < 2; at += .1) {
      assert.equal(getBallState(resolved, at, choices, scenario).owner, 'Y', where);
      assert.ok(forwardDepth(lesson, positionAt(player(resolved, 'Y'), at, choices)) < 0, `${where}: snap receiver stays behind the line while carrying`);
    }
    const passes = scenario.events.filter(event => event.type === 'pass');
    if (!passes.length) {
      assert.equal(getBallState(resolved, 12, choices, scenario).owner, 'Q', where);
      continue;
    }
    assert.equal(passes.length, 1, where);
    const pass = passes[0];
    targets.push(pass.to);
    assert.ok(scenario.title.includes(pass.to), where);
    assert.ok(forwardDepth(lesson, positionAt(player(resolved, 'Q'), pass.at, choices)) < 0, `${where}: release behind the line`);
    const target = player(resolved, pass.to);
    const caught = positionAt(target, pass.endAt, choices);
    assert.ok(forwardDepth(lesson, caught) > 0, `${where}: forward catch beyond the line`);
    assert.ok(distance(caught, positionAt(target, pass.at, choices)) > .001, `${where}: throw ahead of a moving target`);
    assert.ok(distance(caught, positionAt(target, 12, choices)) > .001, `${where}: receiver continues after catching`);
    assert.deepEqual(getBallState(resolved, 6.5, choices, scenario).flights.find(event => event.type === 'pass').end, caught, where);
  }
  assert.deepEqual(targets.sort(), ['C', 'X', 'Y', 'Z']);
});

test('all run teaching captions have complete English translations without changing geometry or timing', () => {
  for (const lesson of lessons) {
    const english = localizeLesson(lesson, 'en');
    const translatedFields = translationFields(english);
    for (const [path] of translationFields(lesson)) {
      if (!/^(ball\.|teaching\.|players\.[^.]+\.coaching\.|keyframes\.)/.test(path)) continue;
      const translated = lesson.translations.en[path];
      assert.ok(typeof translated === 'string' && translated.trim(), `${lesson.id}: ${path}`);
      assert.doesNotMatch(translated, /\p{Script=Han}/u, `${lesson.id}: ${path}`);
      assert.equal(translatedFields.get(path), translated, `${lesson.id}: ${path} is rendered in English`);
    }
    for (const original of lesson.ball.scenarios) {
      const zh = resolveBallScenario(lesson, original.id);
      const en = resolveBallScenario(english, original.id);
      for (const at of [0, .35, 2, 4.2, 6, 7, 12]) {
        const a = getBallState(zh.lesson, at, zh.choices, zh.scenario);
        const b = getBallState(en.lesson, at, en.choices, en.scenario);
        assert.deepEqual([a.state, a.owner, a.position], [b.state, b.owner, b.position], `${lesson.id}/${original.id}@${at}`);
      }
    }
  }
});
