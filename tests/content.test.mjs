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
    if (data.kind === 'offense') assert.equal(data.players.filter(p => p.motion.type === 'path').length, 4);
    if (data.kind === 'formation') assert.equal(data.timeline.duration, 0);
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
