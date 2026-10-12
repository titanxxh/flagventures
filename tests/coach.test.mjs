import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  newPlay,
  adaptLesson,
  compilePlay,
  validatePlay,
  clone,
  explanation,
  teachingText,
  markReview,
  movePlayer,
  retime,
  stepLength,
  copyScenario,
  promotePrefix,
  splitShared,
} from "../app/coach-model.js";
import {
  CoachStore,
  makeRecord,
  teachingRecord,
  backup,
  parseBackup,
  copyRecord,
  assertPlay,
} from "../app/coach-storage.js";
import { getBallState } from "../app/ball.js";
import { positionAt } from "../app/scene.js";
import { IDBFactory } from "fake-indexeddb";

const line = (id, to, seconds = 2) => ({
  id,
  type: "line",
  to,
  seconds,
  timing: "fixed",
});
function sample() {
  const p = newPlay("offense");
  p.title.zh = "测试配合";
  const x = p.players.find((p) => p.id === "X");
  x.motion = {
    type: "path",
    start: { type: "delay", seconds: 0 },
    steps: [line("turn", [5, 43]), line("cross", [15, 43])],
  };
  return p;
}
const store = () => new CoachStore({ temporary: true });

test("every built-in can be copied to a five-player native play with full source snapshot", () => {
  const pack = JSON.parse(readFileSync("content/default.flagbook.json"));
  for (const lesson of pack.lessons) {
    const p = adaptLesson(lesson);
    assertPlay(p);
    assert.equal(p.players.length, 5, lesson.id);
    assert.deepEqual(p.origin.original, lesson);
    assert.equal(p.origin.kind, "adapted");
    assert.deepEqual(validatePlay(p).errors, [], lesson.id);
  }
});
test("full-field extension keeps concept distances and normalized diagrams are labeled coaching geometry", () => {
  const pack = JSON.parse(readFileSync("content/default.flagbook.json"));
  const source = pack.lessons.find((l) => l.id === "concept-mesh"),
    p = adaptLesson(source);
  assert.equal(p.field.height, 70);
  assert.equal(
    p.players[0].at[1] - p.players[1].at[1],
    source.players[0].at[1] - source.players[1].at[1],
  );
  const d = adaptLesson(pack.lessons.find((l) => l.kind === "defense"));
  assert.ok(d.players.every((p) => p.team === "defense"));
  assert.equal(d.targets.length, 5);
  assert.equal(d.distanceBasis, "coach");
});
test("action starts and bound stops follow a teammate while fixed stops stay at their seconds", () => {
  const p = sample(),
    y = p.players.find((p) => p.id === "Y");
  y.motion = {
    type: "path",
    start: {
      type: "action",
      player: "X",
      action: "turn",
      phase: "end",
      offset: 0.5,
    },
    steps: [line("y-run", [25, 45], 1)],
  };
  p.bookmarks.push({
    id: "bound",
    title: { zh: "转折", en: "" },
    binding: { type: "action", player: "X", action: "turn", phase: "end" },
    explanation: explanation(),
  });
  p.bookmarks.push({
    id: "fixed",
    title: { zh: "固定", en: "" },
    binding: { type: "time", seconds: 1 },
    explanation: explanation(),
  });
  let c = compilePlay(p);
  assert.equal(c.lesson.players.find((p) => p.id === "Y").motion.startAt, 2.5);
  assert.equal(c.keyframes.find((f) => f.id === "bound").at, 2);
  p.players.find((p) => p.id === "X").motion.steps[0].seconds = 3;
  c = compilePlay(p);
  assert.equal(c.lesson.players.find((p) => p.id === "Y").motion.startAt, 3.5);
  assert.equal(c.keyframes.find((f) => f.id === "bound").at, 3);
  assert.equal(c.keyframes.find((f) => f.id === "fixed").at, 1);
});
test("cycles and deleted action references remain repairable draft errors", () => {
  const p = sample();
  p.players.find((p) => p.id === "X").motion.start = {
    type: "action",
    player: "Y",
    action: "y-run",
    phase: "end",
  };
  p.players.find((p) => p.id === "Y").motion = {
    type: "path",
    start: { type: "action", player: "X", action: "turn", phase: "end" },
    steps: [line("y-run", [25, 40])],
  };
  assert.ok(validatePlay(p).errors.some((e) => e.message.includes("Cyclic")));
  const q = sample();
  q.bookmarks.push({
    id: "lost",
    title: { zh: "转折", en: "" },
    binding: { type: "action", player: "X", action: "turn", phase: "end" },
  });
  q.players.find((p) => p.id === "X").motion.steps.shift();
  assert.equal(
    compilePlay(q).keyframes.find((f) => f.id === "lost").valid,
    false,
  );
  assert.ok(validatePlay(q).errors.some((e) => e.object === "lost"));
  assertPlay(q);
});
test("curve lengths use actual arc and moving starts preserves shape and manual durations", () => {
  const p = sample(),
    x = p.players.find((p) => p.id === "X");
  x.motion.steps = [
    {
      id: "curve",
      type: "quadratic",
      to: [15, 45],
      control: [5, 35],
      seconds: 4,
      timing: "auto",
    },
    line("fixed", [20, 40], 7),
  ];
  const length = stepLength(x.at, x.motion.steps[0]);
  assert.ok(length > Math.hypot(10, -5));
  retime(x, x.motion);
  const before = clone(x.motion.steps);
  movePlayer(p, x, [7, 52]);
  assert.deepEqual(x.motion.steps[0].to, [17, 47]);
  assert.equal(x.motion.steps[0].seconds, before[0].seconds);
  assert.equal(x.motion.steps[1].seconds, 7);
  movePlayer(p, x, [8, 52], false);
  assert.deepEqual(x.motion.steps[0].to, [17, 47]);
  assert.notEqual(x.motion.steps[0].seconds, before[0].seconds);
});
test("shared route changes reach all plans and an override remains independent", () => {
  const p = sample(),
    original = p.scenarios[0],
    second = copyScenario(p, original);
  second.overrides.X = {
    type: "path",
    start: { type: "delay", seconds: 0 },
    steps: [line("override", [10, 40], 2)],
  };
  p.players.find((p) => p.id === "X").motion.steps[0].to = [6, 42];
  assert.deepEqual(
    compilePlay(p, original.id).lesson.players.find((p) => p.id === "X").motion
      .steps[0].to,
    [6, 42],
  );
  assert.deepEqual(
    compilePlay(p, second.id).lesson.players.find((p) => p.id === "X").motion
      .steps[0].to,
    [10, 40],
  );
});
function ballSample() {
  const p = sample();
  p.initialOwner = "QB";
  p.scenarios[0].mode = "ball";
  p.scenarios[0].events = [
    {
      id: "pass",
      type: "pass",
      from: "QB",
      to: "X",
      start: { type: "time", seconds: 1 },
      end: { type: "action", player: "X", action: "turn", phase: "end" },
      label: "Pass",
      cue: "",
    },
  ];
  return p;
}
test("ball flights fix endpoints at release and catch; reverse seeks reconstruct one ball", () => {
  const p = ballSample();
  assert.deepEqual(validatePlay(p).errors, []);
  const c = compilePlay(p);
  const state = (t) => getBallState(c.lesson, t, {}, c.scenario);
  assert.equal(state(1.5).owner, null);
  assert.equal(state(2).owner, "X");
  assert.equal(state(0.5).owner, "QB");
  assert.deepEqual(state(1.5).flights[0].end, [5, 43]);
  assert.deepEqual(
    state(3).position,
    positionAt(
      c.lesson.players.find((p) => p.id === "X"),
      3,
    ),
  );
});
test("fake actions preserve possession and failed meetings block only the affected plan", () => {
  const p = ballSample();
  const bad = copyScenario(p, p.scenarios[0]);
  bad.events = [
    {
      id: "fake",
      type: "fake-handoff",
      from: "QB",
      to: "Z",
      start: { type: "time", seconds: 0.5 },
      label: "Fake",
      cue: "",
    },
  ];
  assert.ok(
    validatePlay(p).errors.some(
      (e) => e.scenario === bad.id && e.message.includes("meet"),
    ),
  );
  assert.ok(
    !validatePlay(p).errors.some((e) => e.scenario === p.scenarios[0].id),
  );
  p.players.find((p) => p.id === "Z").at = clone(
    p.players.find((p) => p.id === "QB").at,
  );
  const c = compilePlay(p, bad.id);
  assert.equal(getBallState(c.lesson, 1, {}, c.scenario).owner, "QB");
});
test("invalid ball bindings keep the valid route timeline available for staged previews", () => {
  const p = ballSample();
  p.scenarios[0].events[0].end.action = "deleted";
  const c = compilePlay(p);
  assert.equal(c.lesson.timeline.duration, 4);
  assert.ok(c.errors.some((e) => e.object === "pass"));
});
test("deleted duty targets are never replaced by an unrelated free endpoint", () => {
  const p = newPlay("defense");
  p.title.zh = "盯人";
  p.assignments = [
    {
      id: "duty",
      type: "matchup",
      player: "D1",
      target: "deleted",
      end: [15, 50],
    },
  ];
  assert.equal(compilePlay(p).lesson.assignments[0].guide, undefined);
  assert.ok(validatePlay(p).errors.some((e) => e.object === "duty"));
  delete p.assignments[0].target;
  p.assignments[0].end = [31, 50];
  assert.ok(
    validatePlay(p).errors.some(
      (e) => e.object === "duty" && e.message.includes("Coordinates"),
    ),
  );
});
test("bound stops outside the timeline stay pending instead of seeking past its end", () => {
  const p = sample();
  p.bookmarks.push({
    id: "late",
    title: { zh: "稍后", en: "" },
    binding: {
      type: "action",
      player: "X",
      action: "turn",
      phase: "end",
      offset: 3,
    },
  });
  assert.equal(
    compilePlay(p).keyframes.find((f) => f.id === "late").valid,
    false,
  );
  p.referenceDuration = 5;
  assert.equal(
    compilePlay(p).keyframes.find((f) => f.id === "late").valid,
    true,
  );
});
test("sharing and splitting a multi-action prefix preserves IDs or explicitly rebinds stop copies", () => {
  const p = ballSample();
  p.bookmarks.push({
    id: "catch",
    title: { zh: "接球", en: "" },
    scenario: p.scenarios[0].id,
    binding: { type: "ball", event: "pass", phase: "end" },
  });
  const other = copyScenario(p, p.scenarios[0]);
  other.events = [];
  promotePrefix(p, p.scenarios[0], 0);
  assert.equal(p.sharedEvents[0].id, "pass");
  assert.equal(p.bookmarks.find((f) => f.id === "catch").scenario, undefined);
  splitShared(p, 0);
  assert.equal(p.sharedEvents.length, 0);
  assert.equal(p.scenarios[0].events.length, 1);
  assert.equal(p.scenarios[1].events.length, 1);
  assert.notEqual(p.scenarios[0].events[0].id, p.scenarios[1].events[0].id);
  for (const plan of p.scenarios) {
    const frame = p.bookmarks.find(
      (f) => f.scenario === plan.id && f.binding.event === plan.events[0].id,
    );
    assert.ok(frame);
  }
  assert.ok(compilePlay(p, other.id).keyframes.some((f) => !f.valid)); // An explicitly removed private action is not silently rebound.
});
test("copied plan overrides and private bindings use independent stable action identities", () => {
  const p = ballSample(),
    s = p.scenarios[0];
  s.overrides.Y = {
    type: "path",
    start: { type: "delay", seconds: 0 },
    steps: [line("y-own", [25, 43])],
  };
  p.bookmarks.push({
    id: "y-stop",
    title: { zh: "Y", en: "" },
    scenario: s.id,
    binding: { type: "action", player: "Y", action: "y-own", phase: "end" },
  });
  const copy = copyScenario(p, s),
    frame = p.bookmarks.find((f) => f.scenario === copy.id && f.binding.action);
  assert.notEqual(copy.overrides.Y.steps[0].id, "y-own");
  assert.equal(frame.binding.action, copy.overrides.Y.steps[0].id);
});
test("bound duties follow edited objects and do not turn static defenders into runners", () => {
  const p = newPlay("defense");
  p.title.zh = "区域";
  p.zones = [
    {
      id: "zone",
      type: "rectangle",
      label: "短区",
      center: [10, 35],
      radiusX: 3,
      radiusY: 4,
    },
  ];
  p.assignments = [
    { id: "duty", type: "coverage", player: "D1", zone: "zone" },
  ];
  let c = compilePlay(p);
  assert.deepEqual(c.lesson.assignments[0].guide.steps[0].to, [10, 35]);
  p.zones[0].center = [12, 36];
  c = compilePlay(p);
  assert.deepEqual(c.lesson.assignments[0].guide.steps[0].to, [12, 36]);
  assert.deepEqual(positionAt(c.lesson.players[0], 100), p.players[0].at);
  assert.deepEqual(validatePlay(p).errors, []);
  p.zones = [];
  assert.ok(validatePlay(p).errors.some((e) => e.object === "duty"));
});
test("same-time stops survive, independent layer views are validated, deleted scenario stops block save", () => {
  const p = sample();
  p.bookmarks.push(
    {
      id: "a",
      title: { zh: "A", en: "" },
      binding: { type: "time", seconds: 1 },
    },
    {
      id: "b",
      title: { zh: "B", en: "" },
      binding: { type: "time", seconds: 1 },
    },
  );
  assert.equal(compilePlay(p).keyframes.filter((f) => f.at === 1).length, 2);
  assert.deepEqual(validatePlay(p).errors, []);
  p.bookmarks[1].view = { zoneIds: ["missing"], assignmentIds: [] };
  assert.ok(validatePlay(p).errors.some((e) => e.object === "a"));
  p.bookmarks[2].scenario = "deleted";
  assert.ok(validatePlay(p).errors.some((e) => e.object === "b"));
});
test("teaching uses confirmed text and marks changed translations for review without erasing them", () => {
  const p = sample();
  p.explanation = explanation("中文", "English");
  markReview(p);
  assert.equal(teachingText(p, "en").pending, true);
  assert.equal(p.explanation.en.text, "English");
  p.explanation.zh.status = "confirmed";
  assert.deepEqual(teachingText(p, "en"), { text: "中文", fallback: true });
});
test("type-specific minimums permit formations and one-defender duties, not empty offense", () => {
  const p = newPlay("formation");
  p.title.en = "Lineup";
  assert.deepEqual(validatePlay(p).errors, []);
  const d = newPlay("defense");
  d.title.en = "Rush";
  d.assignments = [{ id: "rush", player: "D2", type: "rush", end: [15, 50] }];
  assert.deepEqual(validatePlay(d).errors, []);
  assert.ok(validatePlay(newPlay("offense")).errors.length > 0);
});
test("incomplete drafts survive full backups while malformed saved versions and old formats are rejected", () => {
  const p = newPlay("route");
  p.players[0].at = [null, 50];
  const r = makeRecord(p);
  r.draft.bookmarks.push({
    id: "lost",
    title: { zh: "", en: "" },
    binding: { type: "action", player: "X", action: "missing" },
  });
  assert.deepEqual(parseBackup(JSON.stringify(backup([r]))), [r]);
  r.saved = clone(r.draft);
  assert.throws(() => parseBackup(JSON.stringify(backup([r]))), /teaching/);
  assert.throws(() =>
    parseBackup('{"format":"flag-playbook","version":1,"records":[]}'),
  );
});
test("stored drafts and saved snapshots stay separate without retaining version history", async () => {
  const db = store(),
    p = sample();
  await db.open();
  let r = makeRecord(p);
  [r] = await db.change([{ id: r.id, expected: 0, record: r }]);
  for (let i = 0; i < 11; i++) {
    p.explanation = explanation(`版本 ${i}`);
    const value = teachingRecord(r, p);
    [r] = await db.change([
      { id: r.id, expected: r.revision, record: value, enforceNames: true },
    ]);
  }
  assert.equal(Object.hasOwn(r, "history"), false);
  const saved = clone(r.saved);
  r.draft.title.zh = "草稿修改";
  [r] = await db.change([{ id: r.id, expected: r.revision, record: r }]);
  assert.deepEqual(r.saved, saved);
  assert.deepEqual(parseBackup(JSON.stringify(backup([r]))), [r]);
});
test("revision conflicts never overwrite another page and a copy retains current edits", async () => {
  const db = store(),
    p = sample();
  let r = makeRecord(p);
  [r] = await db.change([{ id: r.id, expected: 0, record: r }]);
  const page2 = clone(r);
  r.draft.title.zh = "页面一";
  [r] = await db.change([{ id: r.id, expected: r.revision, record: r }]);
  page2.draft.title.zh = "页面二";
  await assert.rejects(
    db.change([{ id: page2.id, expected: page2.revision, record: page2 }]),
    (e) => e.code === "CONFLICT",
  );
  assert.equal((await db.list())[0].draft.title.zh, "页面一");
  const copied = copyRecord(page2, await db.list());
  await db.change([{ id: copied.id, expected: 0, record: copied }]);
  assert.equal((await db.list()).length, 2);
});
test("drafts allow duplicate temporary names but formal save/import reject normalized collisions atomically", async () => {
  const db = store(),
    a = makeRecord(sample()),
    b = makeRecord(sample());
  a.draft.title.zh = " Foo  Bar ";
  b.draft.title.zh = "foo bar";
  await db.change([
    { id: a.id, expected: 0, record: a },
    { id: b.id, expected: 0, record: b },
  ]);
  assert.equal((await db.list()).length, 2);
  const records = await db.list();
  await assert.rejects(
    db.change([
      {
        id: a.id,
        expected: records[0].revision,
        record: teachingRecord(records[0], a.draft),
        enforceNames: true,
      },
    ]),
    /name already exists/,
  );
  assert.equal((await db.list())[0].saved, null);
});
test("replacement is atomic and does not delete unselected library records; undo restore uses fresh revision", async () => {
  const db = store(),
    a = makeRecord(sample()),
    b = makeRecord(sample());
  let records = await db.change([
    { id: a.id, expected: 0, record: a },
    { id: b.id, expected: 0, record: b },
  ]);
  const current = records[0],
    replacement = clone(current);
  replacement.draft.title.zh = "替换";
  records = await db.change([
    { id: current.id, expected: current.revision, record: replacement },
  ]);
  assert.equal(
    records.find((r) => r.id === b.id).draft.title.zh,
    b.draft.title.zh,
  );
  const deleted = records.find((r) => r.id === a.id);
  await db.change([{ id: a.id, expected: deleted.revision, remove: true }]);
  records = await db.change([{ id: a.id, expected: 0, record: deleted }]);
  assert.ok(records.find((r) => r.id === a.id).revision > deleted.revision);
});
test("an unsaved rename cannot make another saved teaching title available", async () => {
  const db = store();
  let a = makeRecord(sample());
  a.draft.title.zh = "原名称";
  a = teachingRecord(a, a.draft);
  [a] = await db.change([
    { id: a.id, expected: 0, record: a, enforceNames: true },
  ]);
  a.draft.title.zh = "草稿新名称";
  [a] = await db.change([{ id: a.id, expected: a.revision, record: a }]);
  const b = makeRecord(sample());
  b.draft.title.zh = "原名称";
  await assert.rejects(
    db.change([
      {
        id: b.id,
        expected: 0,
        record: teachingRecord(b, b.draft),
        enforceNames: true,
      },
    ]),
    /name already exists/,
  );
  assert.equal((await db.list()).length, 1);
});
test("unavailable persistence fails explicitly rather than pretending to be an empty library", async () => {
  const db = new CoachStore({ indexedDB: null });
  await assert.rejects(db.open(), /Local storage unavailable/);
  await assert.rejects(db.list(), /Storage is not open/);
});
test("IndexedDB commits persist through reopening and rejects stale writes from a second page", async () => {
  const factory = new IDBFactory(),
    one = new CoachStore({ indexedDB: factory }),
    two = new CoachStore({ indexedDB: factory });
  await one.open();
  await two.open();
  let r = makeRecord(sample());
  [r] = await one.change([{ id: r.id, expected: 0, record: r }]);
  const stale = (await two.list())[0];
  r.draft.title.zh = "已提交";
  [r] = await one.change([{ id: r.id, expected: r.revision, record: r }]);
  await assert.rejects(
    two.change([{ id: stale.id, expected: stale.revision, record: stale }]),
    (e) => e.code === "CONFLICT",
  );
  one.db.close();
  two.db.close();
  const reopened = new CoachStore({ indexedDB: factory });
  await reopened.open();
  assert.equal((await reopened.list())[0].draft.title.zh, "已提交");
  reopened.db.close();
});
test("failed IndexedDB write aborts the whole batch and leaves the previous library readable", async () => {
  const db = new CoachStore({ indexedDB: new IDBFactory() });
  await db.open();
  let r = makeRecord(sample());
  [r] = await db.change([{ id: r.id, expected: 0, record: r }]);
  const original = db.db.transaction.bind(db.db);
  db.db.transaction = (...args) => {
    const tx = original(...args);
    if (args[1] === "readwrite") {
      const store = tx.objectStore("plays");
      store.put = () => {
        throw new DOMException("Test quota exhaustion", "QuotaExceededError");
      };
      tx.objectStore = () => store;
    }
    return tx;
  };
  const edited = clone(r);
  edited.draft.title.zh = "未提交";
  await assert.rejects(
    db.change([{ id: r.id, expected: r.revision, record: edited }]),
    /quota exhaustion/,
  );
  assert.deepEqual((await db.list())[0], r);
  db.db.close();
});
test("future database versions report an opening error and are never reset", async () => {
  const factory = new IDBFactory();
  await new Promise((resolve, reject) => {
    const request = factory.open("flagventures-coach", 3);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("plays", { keyPath: "id" });
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
  const db = new CoachStore({ indexedDB: factory });
  await assert.rejects(db.open(), { name: "VersionError" });
  await new Promise((resolve, reject) => {
    const request = factory.open("flagventures-coach", 3);
    request.onsuccess = () => {
      assert.equal(request.result.version, 3);
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
});
