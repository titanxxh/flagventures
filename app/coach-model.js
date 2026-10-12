import { positionAt, pathToSvg } from "./scene.js";

export const clone = (value) => structuredClone(value);
export const uid = (prefix) => {
  if (globalThis.crypto.randomUUID)
    return `${prefix}-${globalThis.crypto.randomUUID()}`;
  // LAN HTTP previews may lack randomUUID, while getRandomValues is available.
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  return `${prefix}-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
export const normalizeName = (value) =>
  String(value || "")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase();
export const explanation = (zh = "", en = "") => ({
  zh: { text: zh, status: "confirmed" },
  en: { text: en, status: "confirmed" },
});
export function teachingText(item, language = "zh") {
  const texts = item?.explanation;
  const own = texts?.[language],
    other = texts?.[language === "zh" ? "en" : "zh"];
  if (own?.text && own.status === "confirmed")
    return { text: own.text, fallback: false };
  if (other?.text && other.status === "confirmed")
    return { text: other.text, fallback: true };
  return { text: "", pending: true };
}
export function markReview(play, objects = []) {
  const affected = new Set(objects.map((object) => object.id));
  const dependents = [
    ...play.assignments.filter(
      (duty) =>
        affected.has(duty.player) ||
        affected.has(duty.zone) ||
        affected.has(duty.target),
    ),
    ...play.bookmarks.filter(
      (frame) =>
        affected.has(frame.binding?.player) ||
        affected.has(frame.binding?.event),
    ),
  ];
  for (const object of [play, ...objects, ...dependents]) {
    for (const value of Object.values(object.explanation || {}))
      if (value.text) value.status = "review";
    if (object.motion) {
      const motions = [
        object.motion,
        ...play.scenarios.map((s) => s.overrides[object.id]).filter(Boolean),
      ];
      object.legacyReview = motions.some((m) =>
        (m.type === "choice"
          ? m.options.flatMap((o) => o.steps)
          : m.steps || []
        ).some((step) => step.facePlayer),
      );
    }
  }
  play.distanceBasis = "coach";
}
export function newPlay(type = "offense") {
  const defense = type === "defense";
  const names = defense
    ? ["D1", "D2", "D3", "D4", "D5"]
    : ["QB", "C", "X", "Y", "Z"];
  const positions = defense
    ? [
        [5, 40],
        [15, 40],
        [25, 40],
        [9, 32],
        [21, 32],
      ]
    : [
        [15, 55],
        [15, 50],
        [5, 50],
        [25, 50],
        [20, 54],
      ];
  const scenario = {
    id: uid("plan"),
    title: { zh: "方案 1", en: "Plan 1" },
    mode: "routes",
    choices: {},
    overrides: {},
    events: [],
    explanation: explanation(),
  };
  return {
    format: "flagventures.play",
    version: 2,
    id: uid("play"),
    createdAt: new Date().toISOString(),
    type,
    title: { zh: "", en: "" },
    field: {
      width: 30,
      height: 70,
      endZoneDepth: 10,
      lineOfScrimmageY: 50,
      unit: "yard",
      attackDirection: "up",
    },
    origin: { kind: "self", references: [] },
    explanation: explanation(),
    distanceBasis: "coach",
    players: names.map((id, index) => ({
      id,
      name: id,
      team: defense ? "defense" : "offense",
      at: positions[index],
      label: { en: "", zh: "", description: "", basis: "author" },
      explanation: explanation(),
      motion: { type: "unspecified", note: "未说明 / Unspecified" },
    })),
    zones: [],
    assignments: [],
    targets: [],
    sharedEvents: [],
    scenarios: [scenario],
    defaultScenario: scenario.id,
    initialOwner: defense ? "" : "C",
    bookmarks: [
      {
        id: uid("stop"),
        title: { zh: "站位", en: "Lineup" },
        binding: { type: "time", seconds: 0 },
        explanation: explanation(),
      },
    ],
  };
}

function nativeMotion(motion) {
  const result = clone(motion);
  if (["path", "choice"].includes(result.type)) {
    result.start = { type: "delay", seconds: result.startAt || 0 };
    for (const steps of result.type === "path"
      ? [result.steps]
      : result.options.map((option) => option.steps)) {
      for (const step of steps) {
        step.id = uid("action");
        step.timing = "fixed";
      }
    }
  }
  return result;
}
const nativeEvent = (event) => ({
  ...clone(event),
  id: uid("ball"),
  start: { type: "time", seconds: event.at },
  ...(event.endAt !== undefined
    ? { end: { type: "time", seconds: event.endAt } }
    : {}),
  explanation: explanation(event.cue),
});

/** The full reference snapshot is retained independently of editable geometry. */
export function adaptLesson(lesson) {
  const kind = lesson.kind || lesson.type;
  const play = newPlay(kind);
  play.title = clone(lesson.title);
  play.origin = {
    kind: "adapted",
    referenceId: lesson.id,
    referenceTitle: clone(lesson.title),
    references: clone(lesson.source?.references || []),
    source: clone(lesson.source || {}),
    original: clone(lesson),
  };
  const en = lesson.translations?.en || {};
  play.explanation = explanation(
    [lesson.summary, lesson.teaching?.goal, lesson.teaching?.cooperation]
      .filter(Boolean)
      .join("\n"),
    [en.summary, en["teaching.goal"], en["teaching.cooperation"]]
      .filter(Boolean)
      .join("\n"),
  );
  play.field =
    lesson.field.unit === "yard" && lesson.field.height === 70
      ? clone(lesson.field)
      : play.field;
  play.bookmarks = lesson.keyframes.map((frame) => ({
    ...clone(frame),
    title: { zh: frame.label, en: en[`keyframes.${frame.id}.label`] || "" },
    binding: { type: "time", seconds: frame.at },
    explanation: explanation(frame.cue, en[`keyframes.${frame.id}.cue`] || ""),
  }));
  const defense = kind === "defense";
  play.players = lesson.players
    .filter((player) => !defense || player.team === "defense")
    .map((player) => ({
      ...clone(player),
      name: player.name || player.id,
      motion: nativeMotion(player.motion),
      explanation: explanation(
        [
          player.label.description,
          player.coaching?.cooperation,
          player.coaching?.timing,
        ]
          .filter(Boolean)
          .join("\n"),
        [
          en[`players.${player.id}.label.description`],
          en[`players.${player.id}.coaching.cooperation`],
          en[`players.${player.id}.coaching.timing`],
        ]
          .filter(Boolean)
          .join("\n"),
      ),
    }));
  if (defense) {
    // Redraw on a yard field. These authored placements are teaching settings.
    const stations = [
      [5, 40],
      [15, 40],
      [25, 40],
      [9, 32],
      [21, 32],
    ];
    play.players.forEach((player, i) => {
      player.at = stations[i];
    });
    play.targets = lesson.players
      .filter((player) => player.team !== "defense")
      .map((player, i) => ({
        id: player.id,
        name: `对方 ${player.id}`,
        at: [
          [5, 50],
          [15, 55],
          [15, 50],
          [25, 50],
          [20, 54],
        ][i] || [15, 50],
        explanation: explanation(),
      }));
    const project = (point) => [
      (point[0] / lesson.field.width) * 30,
      10 + (point[1] / lesson.field.height) * 40,
    ];
    play.zones = (lesson.zones || []).map((zone) => ({
      ...clone(zone),
      explanation: explanation(),
      ...(zone.type === "ellipse"
        ? {
            center: project(zone.center),
            radiusX: (zone.radiusX / lesson.field.width) * 30,
            radiusY: (zone.radiusY / lesson.field.height) * 40,
          }
        : { points: zone.points.map(project) }),
    }));
    play.assignments = (lesson.assignments || []).map((duty) => ({
      ...clone(duty),
      explanation: explanation(),
      ...(duty.type === "rush"
        ? { end: project((duty.guide.segments || duty.guide.steps).at(-1).to) }
        : {}),
    }));
    play.distanceBasis = "coach";
  } else {
    play.zones = clone(lesson.zones || []);
    play.assignments = clone(lesson.assignments || []);
    const defaults = newPlay(kind).players;
    for (const candidate of defaults)
      if (
        play.players.length < 5 &&
        !play.players.some(
          (p) =>
            p.id === candidate.id || (candidate.id === "QB" && p.id === "Q"),
        )
      )
        play.players.push(candidate);
  }
  if (lesson.ball) {
    play.initialOwner = lesson.ball.initialOwner;
    play.scenarios = lesson.ball.scenarios.map((scenario) => ({
      ...clone(scenario),
      title: {
        zh: scenario.title,
        en: en[`ball.scenarios.${scenario.id}.title`] || "",
      },
      mode: "ball",
      overrides: Object.fromEntries(
        (scenario.motions || []).map((item) => [
          item.player,
          nativeMotion(item.motion),
        ]),
      ),
      choices: clone(scenario.choices || {}),
      events: scenario.events.map(nativeEvent),
      explanation: explanation(scenario.note),
    }));
    play.defaultScenario = lesson.ball.defaultScenario;
  }
  if (
    !defense &&
    (lesson.field.unit !== "yard" || lesson.field.height !== 70)
  ) {
    const los = lesson.field.lineOfScrimmageY ?? 31.5;
    const project = (point) =>
      lesson.field.unit === "yard"
        ? [point[0], 50 + (point[1] - los)]
        : [(point[0] / lesson.field.width) * 30, 50 + (point[1] - los) * 0.7];
    const transform = (motion) => {
      for (const steps of motion.type === "choice"
        ? motion.options.map((o) => o.steps)
        : [motion.steps || []])
        for (const step of steps)
          for (const key of ["to", "control", "control1", "control2"])
            if (step[key]) step[key] = project(step[key]);
    };
    play.players.forEach((player) => {
      player.at = project(player.at);
      transform(player.motion);
    });
    play.scenarios.forEach((s) =>
      Object.values(s.overrides).forEach(transform),
    );
    play.distanceBasis = "coach";
  }
  play.referenceDuration = lesson.timeline.duration;
  if (lesson.routeGuide) play.legacyRouteGuide = clone(lesson.routeGuide);
  // Keep explicit choices. Never infer a branch from a route name.
  for (const player of play.players.filter((p) => p.motion.type === "choice")) {
    if (!lesson.ball) {
      play.scenarios = player.motion.options.map((option) => ({
        ...clone(play.scenarios[0]),
        id: uid("plan"),
        title: { zh: option.title, en: "" },
        choices: { [player.id]: option.id },
      }));
      play.defaultScenario = play.scenarios[0].id;
    }
  }
  return play;
}

export function motionFor(play, scenario, player) {
  return scenario?.overrides?.[player.id] || player.motion;
}
export function stepsFor(motion, option) {
  return motion.type === "choice"
    ? motion.options.find((item) => item.id === option)?.steps || []
    : motion.steps || [];
}
export function stepLength(from, step) {
  if (step.type === "pause") return 0;
  if (step.type === "line")
    return Math.hypot(step.to[0] - from[0], step.to[1] - from[1]);
  let total = 0,
    previous = from;
  for (let index = 1; index <= 256; index++) {
    const t = index / 256,
      u = 1 - t;
    const point = [0, 1].map((axis) =>
      step.type === "quadratic"
        ? u * u * from[axis] +
          2 * u * t * step.control[axis] +
          t * t * step.to[axis]
        : u * u * u * from[axis] +
          3 * u * u * t * step.control1[axis] +
          3 * u * t * t * step.control2[axis] +
          t * t * t * step.to[axis],
    );
    total += Math.hypot(point[0] - previous[0], point[1] - previous[1]);
    previous = point;
  }
  return total;
}
export function retime(player, motion) {
  for (const steps of motion.type === "choice"
    ? motion.options.map((option) => option.steps)
    : [motion.steps || []]) {
    let from = player.at;
    for (const step of steps) {
      if (step.timing === "auto")
        step.seconds = Math.max(0.2, stepLength(from, step) / 3);
      if (step.type !== "pause") from = step.to;
    }
  }
}
export function movePlayer(play, player, to, whole = true) {
  const delta = to.map((value, axis) => value - player.at[axis]);
  const motions = [
    player.motion,
    ...play.scenarios
      .map((plan) => plan.overrides?.[player.id])
      .filter(Boolean),
  ];
  if (whole)
    for (const motion of motions)
      for (const steps of motion.type === "choice"
        ? motion.options.map((option) => option.steps)
        : [motion.steps || []]) {
        for (const step of steps)
          for (const key of ["to", "control", "control1", "control2"])
            if (step[key])
              step[key] = step[key].map((value, axis) => value + delta[axis]);
      }
  player.at = to;
  motions.forEach((motion) => retime(player, motion));
  markReview(play, [player]);
}

/** Compile relations once for deterministic playback, including backwards seek. */
export function compilePlay(play, scenarioId = play.defaultScenario) {
  const scenario = play.scenarios.find((item) => item.id === scenarioId);
  const errors = [];
  const issue = (message, object, step = 2) =>
    errors.push({ message, object, scenario: scenarioId, step });
  const byId = new Map(play.players.map((player) => [player.id, player]));
  const motions = new Map(
    play.players.map((player) => [
      player.id,
      motionFor(play, scenario, player),
    ]),
  );
  const starts = new Map(),
    visiting = new Set(),
    actions = new Map();
  function startOf(id) {
    if (starts.has(id)) return starts.get(id);
    const motion = motions.get(id);
    if (!motion) {
      issue("失效球员 / Missing player", id);
      return NaN;
    }
    if (visiting.has(id)) {
      issue("启动形成循环 / Cyclic start", id);
      return NaN;
    }
    visiting.add(id);
    const rule = motion.start || {
      type: "delay",
      seconds: motion.startAt || 0,
    };
    let start = rule.seconds === undefined ? 0 : rule.seconds;
    if (rule.type === "action") {
      startOf(rule.player);
      const action = actions.get(rule.action);
      if (!action || action.player !== rule.player) {
        issue("启动动作待重新选择 / Repair start action", id);
        start = NaN;
      } else
        start =
          (rule.phase === "start" ? action.start : action.end) +
          (rule.offset === undefined ? 0 : rule.offset);
      if (rule.offset !== undefined && !Number.isFinite(rule.offset))
        start = NaN;
    }
    const steps = stepsFor(motion, scenario?.choices?.[id]);
    if (
      motion.type === "choice" &&
      !motion.options.some((option) => option.id === scenario?.choices?.[id])
    )
      issue("请选择备用跑法 / Select route option", id);
    if (!Number.isFinite(start) || start < 0)
      issue("启动时刻无效 / Invalid start time", id);
    starts.set(id, start);
    visiting.delete(id);
    let time = start;
    for (const step of steps) {
      actions.set(step.id, {
        player: id,
        start: time,
        end: time + step.seconds,
      });
      time += step.seconds;
    }
    return start;
  }
  play.players.forEach((player) => startOf(player.id));
  function bindingTime(binding, object) {
    if (!binding) {
      issue("时刻待设置 / Missing time", object, 3);
      return NaN;
    }
    if (binding.type === "time") return binding.seconds;
    if (binding.type === "action") {
      const action = actions.get(binding.action);
      if (!action || action.player !== binding.player) {
        issue("动作绑定待修复 / Repair action binding", object, 3);
        return NaN;
      }
      if (binding.offset !== undefined && !Number.isFinite(binding.offset)) {
        issue("延后时刻无效 / Invalid time offset", object, 3);
        return NaN;
      }
      return (
        (binding.phase === "start" ? action.start : action.end) +
        (binding.offset || 0)
      );
    }
    issue("未知时刻类型 / Unknown time binding", object, 3);
    return NaN;
  }
  const players = play.players.map((player) => {
    const motion = clone(motions.get(player.id));
    if (["choice", "path"].includes(motion.type)) {
      motion.type = "path";
      motion.steps = clone(
        stepsFor(motions.get(player.id), scenario?.choices?.[player.id]),
      );
      motion.startAt = starts.get(player.id);
    }
    return { ...clone(player), motion };
  });
  let duration = Math.max(
    0,
    ...[
      play.referenceDuration || 0,
      ...players.map((player) =>
        player.motion.type === "path"
          ? player.motion.startAt +
            player.motion.steps.reduce((sum, step) => sum + step.seconds, 0)
          : 0,
      ),
    ].filter(Number.isFinite),
  );
  const events = [...play.sharedEvents, ...(scenario?.events || [])].map(
    (event) => ({
      ...clone(event),
      at: bindingTime(event.start, event.id),
      ...(event.end ? { endAt: bindingTime(event.end, event.id) } : {}),
    }),
  );
  duration = Math.max(
    duration,
    ...events.map((event) => event.endAt ?? event.at).filter(Number.isFinite),
    0,
  );
  const eventTimes = new Map(events.map((event) => [event.id, event]));
  const keyframes = play.bookmarks
    .filter((frame) => !frame.scenario || frame.scenario === scenarioId)
    .map((frame) => {
      let at;
      if (frame.binding.type === "ball") {
        const event = eventTimes.get(frame.binding.event);
        at = event
          ? frame.binding.phase === "end"
            ? (event.endAt ?? event.at)
            : event.at
          : NaN;
      } else at = bindingTime(frame.binding, frame.id);
      const valid = Number.isFinite(at) && at >= 0 && at <= duration;
      if (!valid) issue("停点待修复 / Repair teaching stop", frame.id, 3);
      return {
        ...clone(frame),
        at,
        valid,
        label: frame.title.zh || frame.title.en,
        cue: teachingText(frame).text,
      };
    })
    .sort((a, b) => a.at - b.at);
  const zones = play.zones.map((zone) =>
    zone.type === "rectangle"
      ? {
          ...zone,
          type: "polygon",
          points: [
            [zone.center[0] - zone.radiusX, zone.center[1] - zone.radiusY],
            [zone.center[0] + zone.radiusX, zone.center[1] - zone.radiusY],
            [zone.center[0] + zone.radiusX, zone.center[1] + zone.radiusY],
            [zone.center[0] - zone.radiusX, zone.center[1] + zone.radiusY],
          ],
        }
      : zone,
  );
  const assignments = play.assignments.map((duty) => {
    const from = byId.get(duty.player)?.at;
    const zone = play.zones.find((item) => item.id === duty.zone);
    const target = play.targets.find((item) => item.id === duty.target);
    const to =
      duty.type === "coverage"
        ? zoneCenter(zone)
        : duty.target
          ? target?.at
          : duty.end;
    if (!from || !to) issue("职责目标待修复 / Repair duty target", duty.id, 3);
    return {
      ...duty,
      guide: from && to ? { from, steps: [{ type: "line", to }] } : undefined,
    };
  });
  const lesson = {
    id: play.id,
    type: play.type,
    title: clone(play.title),
    field: clone(play.field),
    players,
    zones,
    assignments,
    timeline: { duration: Number.isFinite(duration) ? duration : 0 },
    keyframes: keyframes.filter((frame) => frame.valid),
  };
  if (!lesson.keyframes.length)
    lesson.keyframes.push({ id: "initial", at: 0, label: "站位", cue: "" });
  if (scenario?.mode === "ball")
    lesson.ball = {
      initialOwner: play.initialOwner,
      scenarios: [{ ...scenario, events }],
      defaultScenario: scenario.id,
    };
  return {
    lesson,
    scenario: scenario ? { ...scenario, events } : undefined,
    keyframes,
    actions,
    errors,
    bindingTime,
  };
}
export function zoneCenter(zone) {
  return (
    zone?.center ||
    (zone?.points?.length
      ? [0, 1].map(
          (axis) =>
            zone.points.reduce((sum, point) => sum + point[axis], 0) /
            zone.points.length,
        )
      : undefined)
  );
}
export function validatePlay(play, { name = true } = {}) {
  const errors = [],
    warnings = [];
  const add = (message, object, step = 2, scenario) =>
    errors.push({ message, object, step, scenario });
  if (name && !Object.values(play.title).some((value) => normalizeName(value)))
    add("请输入战术名称 / Enter a tactic name", play.id, 4);
  if (
    play.referenceDuration !== undefined &&
    (!Number.isFinite(play.referenceDuration) || play.referenceDuration < 0)
  )
    add(
      "演示时长必须为非负数字 / Preview duration must be a nonnegative number",
      play.id,
      4,
    );
  if (
    play.players.length !== 5 ||
    new Set(play.players.map((player) => player.id)).size !== 5
  )
    add("需要五名不同球员 / Five distinct players required", play.id, 1);
  if (
    play.players.some(
      (player) =>
        player.team !== (play.type === "defense" ? "defense" : "offense"),
    )
  )
    add(
      "球员队伍与教学类型不符 / Player teams do not match lesson type",
      play.id,
      1,
    );
  if (
    play.type === "route" &&
    !play.players.some((player) => ["QB", "Q"].includes(player.id))
  )
    add("基础路线需要 QB 参照 / Basic routes need a QB reference", play.id, 1);
  if (
    !Number.isFinite(play.field.lineOfScrimmageY) ||
    play.field.lineOfScrimmageY < 10 ||
    play.field.lineOfScrimmageY > 60
  )
    add("开球线须在比赛区域 / LOS must be in the playing area", play.id, 1);
  const point = (value, object, scenario) => {
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      value.some(
        (v, axis) => !Number.isFinite(v) || v < 0 || v > [30, 70][axis],
      )
    )
      add(
        "坐标须在球场内 / Coordinates must be on the field",
        object,
        2,
        scenario,
      );
  };
  const ids = new Set();
  const identity = (id) => {
    if (!id || ids.has(id))
      add("动作或对象身份重复 / Duplicate object identity", id);
    ids.add(id);
  };
  for (const player of play.players) {
    identity(player.id);
    point(player.at, player.id);
  }
  for (const player of play.players)
    if (player.legacyReview)
      add(
        "旧朝向设置受改动影响，请核对或明确移除 / Review or remove affected legacy facing",
        player.id,
        2,
      );
  for (const target of play.targets) {
    identity(target.id);
    point(target.at, target.id);
  }
  for (const zone of play.zones) {
    identity(zone.id);
    if (zone.type === "polygon") {
      if (zone.points.length < 3)
        add("多边形至少三个点 / Polygon needs three points", zone.id);
      zone.points.forEach((p) => point(p, zone.id));
    } else {
      point(zone.center, zone.id);
      if (
        ![zone.radiusX, zone.radiusY].every((v) => Number.isFinite(v) && v > 0)
      )
        add("区域大小须大于零 / Zone dimensions must be positive", zone.id);
      point(
        [zone.center[0] - zone.radiusX, zone.center[1] - zone.radiusY],
        zone.id,
      );
      point(
        [zone.center[0] + zone.radiusX, zone.center[1] + zone.radiusY],
        zone.id,
      );
    }
  }
  const checkMotion = (player, motion, scenario) => {
    for (const steps of motion.type === "choice"
      ? motion.options.map((option) => option.steps)
      : [motion.steps || []])
      for (const step of steps) {
        identity(step.id);
        if (!Number.isFinite(step.seconds) || step.seconds <= 0)
          add(
            "动作耗时须大于零 / Action duration must be positive",
            step.id,
            2,
            scenario,
          );
        for (const key of ["to", "control", "control1", "control2"])
          if (step[key]) point(step[key], step.id, scenario);
        if (
          step.facePlayer &&
          !play.players.some(
            (p) => p.id === step.facePlayer && p.id !== player.id,
          )
        )
          add(
            "旧朝向参照待修复 / Repair legacy facing reference",
            step.id,
            2,
            scenario,
          );
      }
  };
  play.players.forEach((player) => checkMotion(player, player.motion));
  for (const plan of play.scenarios) {
    identity(plan.id);
    Object.entries(plan.overrides).forEach(([id, motion]) => {
      const player = play.players.find((p) => p.id === id);
      if (!player)
        add("独立路线球员已删除 / Override player missing", id, 2, plan.id);
      else checkMotion(player, motion, plan.id);
    });
  }
  for (const event of [
    ...play.sharedEvents,
    ...play.scenarios.flatMap((plan) => plan.events),
  ])
    identity(event.id);
  play.bookmarks.forEach((frame) => identity(frame.id));
  play.assignments.forEach((duty) => {
    identity(duty.id);
    if (duty.end) point(duty.end, duty.id);
  });
  if (!play.scenarios.some((plan) => plan.id === play.defaultScenario))
    add("请选择默认方案 / Choose a default plan", play.id, 3);
  if (
    play.origin.kind === "adapted" &&
    !play.origin.references?.some((reference) => {
      try {
        const url = new URL(reference.url);
        return (
          reference.role === "primary" &&
          ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password
        );
      } catch {
        return false;
      }
    })
  )
    add("改编战术需保留原始链接 / Keep the primary source link", play.id, 4);
  for (const plan of play.scenarios) {
    const compiled = compilePlay(play, plan.id);
    errors.push(...compiled.errors);
    const moving = compiled.lesson.players.some(
      (player) =>
        player.motion.type === "path" &&
        player.motion.steps.some((step) => step.type !== "pause"),
    );
    if (play.type === "formation" && (moving || plan.mode === "ball"))
      add(
        "静态阵型不安排跑动或球路 / Static formations do not include motion or ball actions",
        play.id,
        2,
        plan.id,
      );
    if (
      ["route", "offense", "run"].includes(play.type) &&
      !moving &&
      (play.type === "route" || plan.mode === "routes")
    )
      add(
        "请至少画一条有效路线 / Draw at least one route",
        play.id,
        2,
        plan.id,
      );
    if (play.type === "defense" && !play.assignments.length)
      add("请至少安排一项职责 / Add at least one duty", play.id, 3, plan.id);
    if (plan.mode === "ball") {
      let owner = play.initialOwner,
        until = 0;
      if (
        !moving &&
        !compiled.scenario.events.some((event) =>
          ["snap", "pass", "handoff"].includes(event.type),
        ) &&
        ["offense", "run"].includes(play.type)
      )
        add(
          "请安排跑位或有效球的传递 / Add movement or a valid ball transfer",
          play.id,
          2,
          plan.id,
        );
      const player = (id) => compiled.lesson.players.find((p) => p.id === id);
      if (!player(owner))
        add(
          "请选择初始持球人 / Choose the initial holder",
          play.id,
          3,
          plan.id,
        );
      for (const event of compiled.scenario.events) {
        if (
          !Number.isFinite(event.at) ||
          event.at < until ||
          event.at < 0 ||
          (event.endAt !== undefined &&
            (!Number.isFinite(event.endAt) || event.endAt <= event.at))
        )
          add(
            "球动作时刻冲突 / Ball action times conflict",
            event.id,
            3,
            plan.id,
          );
        if (!player(event.from) || event.from !== owner)
          add(
            "发起人此刻没有球 / Initiator does not hold the ball",
            event.id,
            3,
            plan.id,
          );
        if (
          event.type !== "pump-fake" &&
          (!player(event.to) || event.from === event.to)
        )
          add(
            "请选择另一名目标球员 / Choose another target",
            event.id,
            3,
            plan.id,
          );
        if (
          ["handoff", "fake-handoff"].includes(event.type) &&
          player(event.from) &&
          player(event.to) &&
          Number.isFinite(event.at)
        ) {
          const a = positionAt(player(event.from), event.at),
            b = positionAt(player(event.to), event.at);
          if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 0.5)
            add(
              "交递双方未会合（教学容差 0.5 码）/ Players must meet (0.5 yd teaching tolerance)",
              event.id,
              3,
              plan.id,
            );
        }
        if (["snap", "pass", "handoff"].includes(event.type)) owner = event.to;
        until = event.endAt ?? event.at;
      }
    }
  }
  for (const frame of play.bookmarks) {
    if (frame.scenario && !play.scenarios.some((s) => s.id === frame.scenario))
      add("停点方案已删除 / Stop plan was deleted", frame.id, 3);
    if (
      frame.view &&
      (!Array.isArray(frame.view.zoneIds) ||
        !Array.isArray(frame.view.assignmentIds) ||
        frame.view.zoneIds.some((id) => !play.zones.some((z) => z.id === id)) ||
        frame.view.assignmentIds.some(
          (id) => !play.assignments.some((d) => d.id === id),
        ))
    )
      add("停点图层待修复 / Repair stop layers", frame.id, 3);
  }
  for (const object of [
    play,
    ...play.players,
    ...play.zones,
    ...play.assignments,
    ...play.bookmarks,
  ]) {
    const value = teachingText(object);
    if (value.pending)
      warnings.push({
        message: "讲解待补或待核对 / Explanation missing or awaiting review",
        object: object.id,
      });
  }
  return { errors, warnings };
}

export function copyScenario(play, scenario) {
  const result = clone(scenario),
    remap = new Map();
  result.id = uid("plan");
  result.title.zh += "（副本）";
  result.title.en = result.title.en ? `${result.title.en} (copy)` : "";
  for (const motion of Object.values(result.overrides))
    for (const steps of motion.type === "choice"
      ? motion.options.map((option) => option.steps)
      : [motion.steps || []])
      for (const step of steps) {
        const id = uid("action");
        remap.set(step.id, id);
        step.id = id;
      }
  for (const event of result.events) {
    const id = uid("ball");
    remap.set(event.id, id);
    event.id = id;
  }
  const rebind = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (["action", "event"].includes(key) && remap.has(item))
        value[key] = remap.get(item);
      else rebind(item);
    }
  };
  rebind(result);
  const frames = play.bookmarks
    .filter((frame) => frame.scenario === scenario.id)
    .map((frame) => ({
      ...clone(frame),
      id: uid("stop"),
      scenario: result.id,
    }));
  frames.forEach(rebind);
  play.scenarios.push(result);
  play.bookmarks.push(...frames);
  return result;
}
export function promotePrefix(play, scenario, index) {
  const moved = scenario.events.splice(0, index + 1);
  play.sharedEvents.push(...moved);
  const ids = new Set(moved.map((event) => event.id));
  for (const frame of play.bookmarks)
    if (
      frame.scenario === scenario.id &&
      frame.binding.type === "ball" &&
      ids.has(frame.binding.event)
    )
      delete frame.scenario;
}
export function splitShared(play, index) {
  const moved = play.sharedEvents.splice(index);
  for (const scenario of play.scenarios) {
    const mapping = new Map();
    const events = moved.map((event) => {
      const result = clone(event);
      result.id = uid("ball");
      mapping.set(event.id, result.id);
      return result;
    });
    scenario.events.unshift(...events);
    for (const frame of play.bookmarks.filter(
      (frame) => !frame.scenario && mapping.has(frame.binding.event),
    ))
      play.bookmarks.push({
        ...clone(frame),
        id: uid("stop"),
        scenario: scenario.id,
        binding: { ...frame.binding, event: mapping.get(frame.binding.event) },
      });
  }
  const ids = new Set(moved.map((event) => event.id));
  play.bookmarks = play.bookmarks.filter(
    (frame) => frame.scenario || !ids.has(frame.binding.event),
  );
}
export function routePath(player, motion, choice) {
  return pathToSvg(player.at, stepsFor(motion, choice));
}
