import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { load } from 'js-yaml';
import { parseLesson, validateCatalog, validatePack } from '../app/validation.js';
import { getScene } from '../app/scene.js';

const pack = JSON.parse(fs.readFileSync(new URL('../content/default.flagbook.json', import.meta.url)));
const catalog = load(fs.readFileSync(new URL('../content/catalog.yaml', import.meta.url), 'utf8'));
const lesson = id => pack.lessons.find(l => l.id === id);

test('source inventory keeps all 64 entries and page references without original images', () => {
  const counts = Object.fromEntries(['route', 'formation', 'offense', 'run', 'defense'].map(kind => [kind, pack.lessons.filter(l => l.kind === kind).length]));
  assert.deepEqual(counts, { route: 10, formation: 10, offense: 30, run: 9, defense: 5 });
  assert.equal(pack.lessons.length, 64);
  assert.deepEqual(pack.assets, []);
  for (const data of pack.lessons) {
    assert.ok(Number.isInteger(data.source?.page) && data.source.page > 0, `${data.id}: source page`);
    assert.equal(Object.hasOwn(data.source, 'referenceAsset'), false, `${data.id}: original image reference`);
  }
  const pages = pack.lessons.map(l => l.source.page);
  assert.deepEqual(pages, [...pages].sort((a, b) => a - b));
  assert.equal(new Set(pages).size, 56);
  assert.equal(validatePack(pack).warnings.length, 0);
  assert.equal(lesson('single-back-play-2').source.page, 8);
  assert.equal(lesson('single-set-play-2').source.page, 44);
});

test('editable YAML and catalog exactly reconstruct the built-in lessons', () => {
  const files = {};
  for (const section of catalog.sections) for (const entry of section.entries) {
    const text = fs.readFileSync(new URL(`../content/${entry.file}`, import.meta.url), 'utf8');
    files[entry.file] = parseLesson(text, entry.file);
    assert.deepEqual(files[entry.file], lesson(entry.id));
  }
  validateCatalog(catalog, files);
  assert.deepEqual(catalog.sections.map(s => s.entries.map(e => e.id)), pack.sections.map(s => s.lessonIds));
  assert.deepEqual(catalog.sections.map(s => s.groups), pack.sections.map(s => s.groups));
  const groups = pack.sections.find(section => section.id === 'offensive-formations').groups;
  assert.equal(groups.length, 10);
  assert.ok(groups.every(group => group.lessonIds.length === 4));
});

test('all scenes stay finite at keyframes and reverse seeks without changing source data', () => {
  for (const data of pack.lessons) {
    const before = JSON.stringify(data);
    const choices = Object.fromEntries(data.players.filter(p => p.motion.type === 'choice').map(p => [p.id, p.motion.options[0].id]));
    for (const time of [data.timeline.duration, ...data.keyframes.map(f => f.at).reverse(), 0]) {
      const scene = getScene(data, time, choices);
      for (const player of scene.players) assert.ok(player.position.every(Number.isFinite), `${data.id}/${player.id}`);
    }
    assert.equal(JSON.stringify(data), before);
    if (data.kind === 'offense') assert.equal(data.players.filter(p => ['path', 'choice'].includes(p.motion.type)).length, 4);
    if (data.kind === 'formation') assert.equal(data.timeline.duration, 0);
  }
});

test('all 30 offensive plays carry specific teaching, individual coaching and online source references', () => {
  const offense = pack.lessons.filter(data => data.kind === 'offense');
  assert.equal(new Set(offense.map(data => data.summary)).size, 30, 'each play has its own summary');
  for (const data of offense) {
    for (const field of ['goal', 'cooperation', 'cue', 'question']) assert.ok(data.teaching?.[field]?.trim(), `${data.id}: teaching.${field}`);
    for (const player of data.players) {
      assert.ok(player.coaching?.cooperation?.trim(), `${data.id}/${player.id}: cooperation`);
      assert.ok(player.coaching?.timing?.trim(), `${data.id}/${player.id}: timing`);
    }
    assert.ok(data.source.references.some(reference => new URL(reference.url).hostname === 'nflflag.com'), `${data.id}: official article`);
    assert.ok(data.source.references.some(reference => new URL(reference.url).hostname === 'www.youtube.com'), `${data.id}: official video`);
    assert.equal(data.timeline.basis, 'illustration', `${data.id}: exact seconds remain teaching timing`);
  }
  for (const id of ['X', 'Z']) {
    const player = lesson('single-back-play-1').players.find(item => item.id === id);
    assert.equal(player.label.en, 'Post');
    assert.equal(player.label.basis, 'source');
  }
});

test('source-supported relative starts wait for the correct teammates without changing scene geometry', () => {
  const starts = id => Object.fromEntries(lesson(id).players.filter(player => player.motion.type === 'path').map(player => [player.id, player.motion.startAt]));
  const bunch1 = starts('bunch-play-1');
  assert.ok(Math.min(bunch1.X, bunch1.Z) > Math.max(bunch1.C, bunch1.Y));
  const bunch2 = starts('bunch-play-2');
  assert.ok(Math.min(bunch2.C, bunch2.Y) > Math.max(bunch2.X, bunch2.Z));
  const trips3 = starts('trips-play-3');
  assert.ok(trips3.C > Math.max(trips3.X, trips3.Y, trips3.Z));
  const i2 = starts('i-formation-play-2');
  assert.ok(i2.Z > Math.max(i2.X, i2.Y, i2.C));

  for (const [id, delayedPlayer] of [['trips-play-3', 'C'], ['i-formation-play-2', 'Z']]) {
    const data = lesson(id);
    const player = data.players.find(item => item.id === delayedPlayer);
    const atWait = getScene(data, player.motion.startAt / 2);
    assert.deepEqual(atWait.players.find(item => item.id === delayedPlayer).position, player.at);
    assert.ok(atWait.players.some(item => ['X', 'Y'].includes(item.id) && JSON.stringify(item.position) !== JSON.stringify(item.at)));
    assert.notDeepEqual(getScene(data, data.timeline.duration).players.find(item => item.id === delayedPlayer).position, player.at);
  }
});

test('conditional center releases require an explicit scenario and retain unknown untriggered actions', () => {
  for (const id of ['single-back-play-1', 'spread-play-2', 'trips-stack-play-2']) {
    const data = lesson(id);
    const center = data.players.find(player => player.id === 'C');
    assert.equal(center.motion.type, 'choice', id);
    assert.equal(center.motion.options.length, 2);
    const notTriggered = center.motion.options.find(option => option.steps.every(step => step.type === 'pause'));
    const released = center.motion.options.find(option => option.steps.some(step => step.type !== 'pause'));
    assert.ok(notTriggered?.note?.trim(), `${id}: explain undisclosed action`);
    assert.ok(released?.note?.trim(), `${id}: explain conditional release`);
    const before = JSON.stringify(data);
    const blocked = getScene(data, data.timeline.duration);
    assert.equal(blocked.ready, false);
    assert.equal(blocked.time, 0);
    assert.deepEqual(blocked.players.map(player => player.position), data.players.map(player => player.at));
    const noRelease = getScene(data, data.timeline.duration, { C: notTriggered.id });
    assert.equal(noRelease.ready, true);
    assert.deepEqual(noRelease.players.find(player => player.id === 'C').position, center.at);
    assert.notDeepEqual(getScene(data, data.timeline.duration, { C: released.id }).players.find(player => player.id === 'C').position, center.at);
    assert.deepEqual(getScene(data, 0, { C: released.id }).players.map(player => player.position), data.players.map(player => player.at));
    assert.equal(JSON.stringify(data), before);
  }
});

test('sensitive source facts remain explicit: distinct same-color players, stops, options and short movements', () => {
  const stack = lesson('trips-stack-play-3');
  const c = stack.players.find(p => p.id === 'C');
  const x = stack.players.find(p => p.id === 'X');
  assert.notDeepEqual(c.motion.steps, x.motion.steps);
  assert.ok(lesson('route-stop-and-go').players[0].motion.steps.some(s => s.type === 'pause'));
  assert.match(lesson('hb-option').notes.join(' '), /PUMP FAKE \+ RUN/);
  assert.match(lesson('qb-option').notes.join(' '), /不是先跑后传/);
  assert.equal(lesson('fake-triple-reverse').players.find(p => p.id === 'Q').motion.type, 'path');
  assert.equal(lesson('single-back-play-1').players.find(p => p.id === 'Q').motion.type, 'unspecified');
});

test('defense retains exact coverage counts and the source distinction between assignments and motion', () => {
  const expected = [['man', 0, 4, 1], ['cover-1', 4, 0, 1], ['cover-2', 4, 0, 1], ['cover-3', 5, 0, 0], ['cover-4', 4, 0, 1]];
  for (const [id, zones, matchup, rush] of expected) {
    const data = lesson(id);
    assert.equal(data.zones?.length || 0, zones, id);
    assert.equal(data.assignments.filter(a => a.type === 'matchup').length, matchup, id);
    assert.equal(data.assignments.filter(a => a.type === 'rush').length, rush, id);
    assert.equal(data.players.filter(p => p.team === 'defense').length, 5, id);
    assert.equal(data.field.attackDirection, 'down');
    assert.ok(data.players.every(p => p.motion.type === 'unspecified'));
    assert.deepEqual(getScene(data, 0).players.map(p => p.position), getScene(data, data.timeline.duration).players.map(p => p.position));
  }
  const cover4 = lesson('cover-4');
  assert.equal(new Set(cover4.assignments.filter(a => a.type === 'coverage').map(a => a.zone)).size, 4);
  assert.ok(cover4.field.width > 100, 'preserves the reference ellipse extending slightly outside the printed frame');
});
