import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { load } from 'js-yaml';
import { parseLesson, validateCatalog, validatePack } from '../app/validation.js';
import { getScene } from '../app/scene.js';

const pack = JSON.parse(fs.readFileSync(new URL('../content/default.flagbook.json', import.meta.url)));
const catalog = load(fs.readFileSync(new URL('../content/catalog.yaml', import.meta.url), 'utf8'));
const lesson = id => pack.lessons.find(l => l.id === id);

test('inventory keeps the 64 source entries and adds In without inventing a PDF page', () => {
  const counts = Object.fromEntries(['route', 'formation', 'offense', 'run', 'defense'].map(kind => [kind, pack.lessons.filter(l => l.kind === kind).length]));
  assert.deepEqual(counts, { route: 11, formation: 10, offense: 30, run: 9, defense: 5 });
  assert.equal(pack.lessons.length, 65);
  assert.deepEqual(pack.assets, []);
  const original = pack.lessons.filter(data => data.id !== 'route-in');
  assert.equal(original.length, 64);
  for (const data of original) {
    assert.ok(Number.isInteger(data.source?.page) && data.source.page > 0, `${data.id}: source page`);
    assert.equal(Object.hasOwn(data.source, 'referenceAsset'), false, `${data.id}: original image reference`);
  }
  const supplemental = lesson('route-in');
  assert.ok(supplemental);
  assert.equal(Object.hasOwn(supplemental.source, 'page'), false);
  assert.equal(Object.hasOwn(supplemental.source, 'referenceAsset'), false);
  assert.equal(pack.sections.find(section => section.id === 'routes').lessonIds.at(-1), 'route-in');
  const pages = original.map(l => l.source.page);
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

test('all basic routes explain the movement with a stationary QB reference behind the line', () => {
  const routes = pack.lessons.filter(data => data.kind === 'route');
  assert.equal(routes.length, 11);
  for (const data of routes) {
    assert.equal(data.field.attackDirection, 'up');
    const receiver = data.players.find(player => player.id === 'X');
    const qb = data.players.find(player => player.id === 'QB');
    assert.ok(receiver && qb, `${data.id}: receiver and QB reference`);
    assert.equal(data.players.length, 2, `${data.id}: a route demonstration, not an invented five-player formation`);
    assert.equal(receiver.at[1], data.field.lineOfScrimmageY, `${data.id}: receiver starts on the line`);
    assert.ok(qb.at[1] > data.field.lineOfScrimmageY, `${data.id}: QB is behind the line`);
    assert.ok(receiver.at[0] < qb.at[0], `${data.id}: inward is toward field center, from the receiver's left-side start`);
    assert.equal(qb.motion.type, 'still');
    for (const field of ['goal', 'cooperation', 'cue', 'question']) assert.ok(data.teaching?.[field]?.trim(), `${data.id}: teaching.${field}`);
    assert.ok(data.source.references.some(reference => new URL(reference.url).hostname === 'nflflag.com'), `${data.id}: route definition has an official reference`);
    assert.equal(data.timeline.basis, 'illustration');
    for (const frame of data.keyframes) {
      const scene = getScene(data, frame.at);
      assert.deepEqual(scene.players.find(player => player.id === 'QB').position, qb.at, `${data.id}: QB remains a reference`);
      for (const player of scene.players) {
        const [x, y] = player.position;
        assert.ok(x >= 0 && x <= data.field.width && y >= 0 && y <= data.field.height, `${data.id}/${player.id}: stays within the full field`);
      }
    }
  }
});

test('Slant and supplemental In teach distinct diagonal and square inward cuts', () => {
  const vectors = id => {
    const receiver = lesson(id).players.find(player => player.id === 'X');
    let from = receiver.at;
    return receiver.motion.steps.filter(step => step.type !== 'pause').map(step => {
      assert.equal(step.type, 'line', `${id}: basic direction is shown with straight route segments`);
      const vector = step.to.map((coordinate, axis) => coordinate - from[axis]);
      from = step.to;
      return vector;
    });
  };
  const slant = vectors('route-slant');
  const squareIn = vectors('route-in');
  for (const [name, route] of [['Slant', slant], ['In', squareIn]]) {
    assert.equal(route[0][0], 0, `${name}: upfield stem`);
    assert.ok(route[0][1] < 0, `${name}: starts toward the attacking end zone`);
    assert.ok(route.at(-1)[0] > 0, `${name}: cuts inward from the left`);
  }
  assert.ok(slant.at(-1)[1] < 0, 'Slant continues upfield while cutting inward');
  assert.ok(Math.abs(Math.abs(slant.at(-1)[0] / slant.at(-1)[1]) - 1) < 0.05, 'Slant illustration uses an approximately 45-degree diagonal');
  assert.equal(squareIn.at(-1)[1], 0, 'In cuts at 90 degrees and runs parallel to the line of scrimmage');
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
  assert.ok(lesson('route-stop-and-go').players.find(player => player.id === 'X').motion.steps.some(s => s.type === 'pause'));
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

test('route distances use official examples or explicitly chosen demonstration depths', () => {
  const expected = {
    'route-hitch': [7, 'source-example'], 'route-slant': [2, 'illustration'],
    'route-out': [5, 'source-example'], 'route-in': [10, 'source-example'],
    'route-post': [7, 'source-example'], 'route-corner': [7, 'source-example'],
    'route-chair': [4, 'source-example'], 'route-stop-and-go': [7, 'source-example'],
    'route-post-corner': [7, 'source-example'], 'route-option': [2, 'illustration'],
    'route-fly': [20, 'illustration'],
  };
  for (const [id, [depth, basis]] of Object.entries(expected)) {
    const data = lesson(id), guide = data.routeGuide;
    assert.equal(data.field.unit, 'yard', id);
    assert.equal(data.field.endZoneDepth, 10, id);
    const player = data.players.find(p => p.id === guide.player);
    const mark = guide.marks[0];
    assert.equal(data.field.lineOfScrimmageY - player.motion.steps[mark.step].to[1], depth, id);
    assert.equal(mark.basis, basis, id);
    if (basis === 'source-example') assert.ok(data.source.references[mark.sourceReference], id);
    assert.ok(guide.note, id);
  }
});

test('official return moves keep their hook geometry instead of retracing or only pausing', () => {
  const hitch = lesson('route-hitch');
  const x = hitch.players.find(p => p.id === 'X'), qb = hitch.players.find(p => p.id === 'QB');
  const [stem, back] = x.motion.steps;
  const toward = qb.at.map((n,i) => n-stem.to[i]);
  const returned = back.to.map((n,i) => n-stem.to[i]);
  assert.ok(returned[0] > 0 && returned[1] > 0, 'Hitch hooks inside and back, never retraces its stem');
  assert.ok(Math.abs(returned[0]*toward[1]-returned[1]*toward[0]) < 1e-6, 'this illustration returns toward QB');
  assert.ok(Math.abs(Math.hypot(...returned)-2) < 1e-6, 'two yards measures diagonal travel, not depth');
  assert.ok(Math.abs((hitch.field.lineOfScrimmageY-back.to[1])-5.2724) < .001);

  const option = lesson('route-option').players.find(p=>p.id==='X').motion.steps;
  const optionRuns = option.filter(s=>s.type!=='pause');
  assert.equal(optionRuns.length,4,'Option includes its small hook before running outside');
  assert.ok(optionRuns[1].to[0]>optionRuns[0].to[0] && optionRuns[1].to[1]<optionRuns[0].to[1]);
  assert.ok(optionRuns[2].to[1]>optionRuns[1].to[1], 'Option retreats from the slant tip');
  assert.ok(optionRuns[3].to[0]<optionRuns[2].to[0]);
  assert.equal(optionRuns[3].to[1],optionRuns[2].to[1], 'outside cut stays at the returned depth');

  const stopGo = lesson('route-stop-and-go').players.find(p=>p.id==='X').motion.steps;
  const stopGoRuns = stopGo.filter(s=>s.type!=='pause');
  assert.equal(stopGoRuns.length,4,'Stop & Go includes return, outside escape and another deep run');
  assert.ok(stopGoRuns[1].to[0]>stopGoRuns[0].to[0] && stopGoRuns[1].to[1]>stopGoRuns[0].to[1]);
  assert.ok(stopGo.some(s=>s.type==='pause' && s.facePlayer==='QB'),'fake catch faces QB');
  assert.ok(stopGoRuns[2].to[0]<stopGoRuns[0].to[0], 'escape past the outside of the original stem');
  assert.equal(stopGoRuns[2].to[1],stopGoRuns[1].to[1]);
  assert.equal(stopGoRuns[3].to[0],stopGoRuns[2].to[0]);
  assert.ok(stopGoRuns[3].to[1]<stopGoRuns[0].to[1]);
});
