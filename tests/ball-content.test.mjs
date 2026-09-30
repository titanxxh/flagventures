import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {load} from 'js-yaml';
import {getScene, positionAt} from '../app/scene.js';
import {getBallState, resolveBallScenario} from '../app/ball.js';

// Read authored lessons directly so this coverage does not rely on a stale pack.
const lessons = fs.readdirSync(new URL('../content/lessons/', import.meta.url))
  .filter(file => file.endsWith('.yaml'))
  .map(file => load(fs.readFileSync(new URL(`../content/lessons/${file}`, import.meta.url), 'utf8')))
  .filter(lesson => lesson.kind === 'offense' && !lesson.id.startsWith('concept-'));
const targets = ['C', 'X', 'Y', 'Z'];
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const player = (lesson, id) => lesson.players.find(item => item.id === id);

test('all 30 offensive plays offer four explicitly illustrative receiver choices', () => {
  assert.equal(lessons.length, 30);
  assert.equal(lessons.reduce((count, lesson) => count + lesson.ball.scenarios.length, 0), 120);
  for (const lesson of lessons) {
    const {ball} = lesson;
    assert.equal(lesson.version, 1, lesson.id);
    assert.equal(ball.initialOwner, 'C', lesson.id);
    assert.equal(lesson.timeline.basis, 'illustration', lesson.id);
    assert.deepEqual(ball.scenarios.map(scenario => scenario.id).sort(), targets.map(id => `pass-${id.toLowerCase()}`).sort(), lesson.id);
    assert.ok(ball.scenarios.some(scenario => scenario.id === ball.defaultScenario), lesson.id);
    assert.match(ball.note, /教学示例/, lesson.id);
    assert.match(ball.note, /不代表官网规定唯一目标或 QB 阅读顺序/, lesson.id);
    assert.match(ball.note, /不是比赛用时/, lesson.id);
    for (const scenario of ball.scenarios) {
      assert.equal(scenario.basis, 'illustration', `${lesson.id}/${scenario.id}`);
      assert.deepEqual(scenario.events.map(event => event.type), ['snap', 'pass'], lesson.id);
      const [snap, pass] = scenario.events;
      assert.deepEqual([snap.from, snap.to, snap.at, snap.endAt], ['C', 'Q', 0, .35], lesson.id);
      assert.equal(pass.from, 'Q', lesson.id);
      assert.equal(scenario.id, `pass-${pass.to.toLowerCase()}`, lesson.id);
      assert.ok(targets.includes(pass.to), lesson.id);
      assert.ok(snap.endAt <= pass.at && pass.at < pass.endAt, lesson.id);
      assert.ok(pass.endAt - pass.at >= .6 && pass.endAt - pass.at <= .9, lesson.id);
      assert.ok(pass.endAt <= lesson.timeline.duration - .5, `${lesson.id}: leave time to carry on after catching`);
      for (const event of scenario.events) {
        assert.ok(event.label && event.cue && event.endLabel && event.endCue, `${lesson.id}: clear release and arrival captions`);
        assert.notEqual(event.label, event.endLabel, `${lesson.id}: distinguish releasing and receiving`);
      }
    }
  }
});

test('every authored pass leads a moving receiver beyond the line and preserves possession through continued running', () => {
  for (const lesson of lessons) for (const authored of lesson.ball.scenarios) {
    const before = JSON.stringify(lesson);
    const {lesson: resolved, choices, scenario} = resolveBallScenario(lesson, authored.id);
    const pass = scenario.events[1];
    const target = player(resolved, pass.to);
    const qb = player(resolved, 'Q');
    const context = `${lesson.id}/${scenario.id}`;
    const sign = lesson.field.attackDirection === 'up' ? -1 : 1;
    const caught = positionAt(target, pass.endAt, choices);
    const releasePosition = positionAt(qb, pass.at, choices);
    assert.ok(sign * (releasePosition[1] - lesson.field.lineOfScrimmageY) < 0, `${context}: QB releases behind the line`);
    assert.ok(sign * (caught[1] - lesson.field.lineOfScrimmageY) > 0, `${context}: catch is beyond the line`);
    assert.ok(caught[0] >= 0 && caught[0] <= lesson.field.width && caught[1] >= 0 && caught[1] <= lesson.field.height, `${context}: catch stays inside the diagram`);
    assert.ok(distance(positionAt(target, pass.endAt - .05, choices), positionAt(target, pass.endAt + .05, choices)) > .001, `${context}: receiver is moving through the catch`);
    assert.ok(distance(caught, positionAt(target, pass.at, choices)) > .001, `${context}: pass aims ahead of the receiver`);
    assert.ok(distance(caught, positionAt(target, lesson.timeline.duration, choices)) > .001, `${context}: catch does not terminate the shown route`);
    assert.equal(getScene(resolved, pass.endAt, choices).ready, true, context);

    const afterSnap = getBallState(resolved, .35, choices, scenario);
    assert.equal(afterSnap.state, 'held', context);
    assert.equal(afterSnap.owner, 'Q', context);
    const beforePass = getBallState(resolved, pass.at - .001, choices, scenario);
    assert.equal(beforePass.owner, 'Q', `${context}: QB has the ball before throwing`);
    const flying = getBallState(resolved, (pass.at + pass.endAt) / 2, choices, scenario);
    assert.equal(flying.state, 'flight', context);
    assert.equal(flying.owner, null, context);
    const flight = flying.flights.find(event => event.id === pass.id);
    assert.deepEqual(flight.start, releasePosition, context);
    assert.deepEqual(flight.end, caught, `${context}: fixed future catch point`);
    for (const at of [pass.endAt, pass.endAt + .25, lesson.timeline.duration]) {
      const ball = getBallState(resolved, at, choices, scenario);
      assert.equal(ball.state, 'held', context);
      assert.equal(ball.owner, target.id, context);
      assert.deepEqual(ball.position, positionAt(target, at, choices), `${context}: ball follows the carrier`);
    }
    assert.equal(JSON.stringify(lesson), before, `${context}: selecting a ball example does not edit the base lesson`);
  }
});

test('conditional centers stay explicitly selectable and QB stillness is confined to the teaching scenario', () => {
  const conditional = [];
  for (const lesson of lessons) {
    const choicePlayers = lesson.players.filter(item => item.motion.type === 'choice');
    if (choicePlayers.length) conditional.push(lesson.id);
    assert.equal(player(lesson, 'Q').motion.type, 'unspecified', `${lesson.id}: retain the source uncertainty without ball playback`);
    for (const scenario of lesson.ball.scenarios) {
      assert.deepEqual(Object.keys(scenario.choices || {}).sort(), choicePlayers.map(item => item.id).sort(), lesson.id);
      for (const item of choicePlayers) {
        assert.ok(item.motion.options.some(option => option.id === scenario.choices[item.id]), lesson.id);
        assert.equal(scenario.choices.C, scenario.id === 'pass-c' ? 'released' : 'not-shown', lesson.id);
      }
      assert.deepEqual(scenario.motions.map(item => item.player), ['Q'], `${lesson.id}: keep all receiver routes and relative starts`);
      assert.equal(scenario.motions[0].motion.type, 'still', lesson.id);
      assert.match(scenario.motions[0].motion.note, /原资料未指定/, lesson.id);
    }
  }
  assert.deepEqual(conditional.sort(), ['single-back-play-1', 'spread-play-2', 'trips-stack-play-2']);
});

test('Hitch catches occur on the return and Option catches follow the final outward pivot', () => {
  let hitches = 0, options = 0;
  for (const lesson of lessons) for (const scenario of lesson.ball.scenarios) {
    const pass = scenario.events[1];
    const target = player(lesson, pass.to);
    if (!['Hitch', 'Option'].includes(target.label.en)) continue;
    const before = positionAt(target, pass.endAt - .05, scenario.choices);
    const after = positionAt(target, pass.endAt + .05, scenario.choices);
    if (target.label.en === 'Hitch') {
      hitches += 1;
      assert.ok(after[1] > before[1], `${lesson.id}/${target.id}: catch during the return, not the upfield stem`);
    } else {
      options += 1;
      assert.ok(Math.abs(after[0] - before[0]) > 3 * Math.abs(after[1] - before[1]), `${lesson.id}/${target.id}: catch on the last outward leg`);
    }
  }
  assert.equal(hitches, 7);
  assert.equal(options, 6);
  const trips = lessons.find(lesson => lesson.id === 'trips-play-1');
  assert.ok(trips.ball.scenarios.find(scenario => scenario.id === 'pass-x').events[1].endAt > 8.2, 'Trips 1 X completes its small late pivot before catching');
});

test('all selectable offensive ball captions have complete English translations', () => {
  for (const lesson of lessons) {
    const paths = ['ball.note'];
    for (const scenario of lesson.ball.scenarios) {
      const base = `ball.scenarios.${scenario.id}`;
      paths.push(`${base}.title`, `${base}.note`);
      for (const motion of scenario.motions || []) paths.push(`${base}.motions.${motion.player}.motion.note`);
      for (const event of scenario.events) for (const field of ['label', 'cue', 'endLabel', 'endCue']) paths.push(`${base}.events.${event.id}.${field}`);
    }
    for (const path of paths) {
      const translated = lesson.translations.en[path];
      assert.ok(typeof translated === 'string' && translated.trim(), `${lesson.id}: ${path}`);
      assert.doesNotMatch(translated, /\p{Script=Han}/u, `${lesson.id}: ${path}`);
    }
  }
});
