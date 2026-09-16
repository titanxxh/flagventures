// Lesson data is validated before it reaches this module. Scene calculation has
// no playback state: seeking to a time always reconstructs the same positions.
const CURVE_SAMPLES = 256;
const curveTables = new WeakMap();

const copyPoint = point => [point[0], point[1]];
const interpolate = (from, to, ratio) => [
  from[0] + (to[0] - from[0]) * ratio,
  from[1] + (to[1] - from[1]) * ratio,
];

function curvePoint(from, step, t) {
  const u = 1 - t;
  if (step.type === 'quadratic') {
    return [0, 1].map(axis =>
      u * u * from[axis] + 2 * u * t * step.control[axis] + t * t * step.to[axis]);
  }
  return [0, 1].map(axis =>
    u * u * u * from[axis]
    + 3 * u * u * t * step.control1[axis]
    + 3 * u * t * t * step.control2[axis]
    + t * t * t * step.to[axis]);
}

function curveTable(from, step) {
  // The signature keeps cached geometry correct if a caller edits lesson data.
  const signature = [step.type, ...from, ...(step.control || []),
    ...(step.control1 || []), ...(step.control2 || []), ...step.to].join(',');
  const cached = curveTables.get(step);
  if (cached?.signature === signature) return cached;

  const lengths = new Float64Array(CURVE_SAMPLES + 1);
  let previous = from;
  for (let i = 1; i <= CURVE_SAMPLES; i += 1) {
    const point = curvePoint(from, step, i / CURVE_SAMPLES);
    lengths[i] = lengths[i - 1] + Math.hypot(point[0] - previous[0], point[1] - previous[1]);
    previous = point;
  }
  const table = {signature, lengths, total: lengths[CURVE_SAMPLES]};
  curveTables.set(step, table);
  return table;
}

function alongCurve(from, step, progress) {
  if (progress <= 0) return copyPoint(from);
  if (progress >= 1) return copyPoint(step.to);
  const {lengths, total} = curveTable(from, step);
  if (total === 0) return copyPoint(from);

  const distance = progress * total;
  let low = 0;
  let high = CURVE_SAMPLES;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (lengths[middle] <= distance) low = middle;
    else high = middle;
  }
  const portion = (distance - lengths[low]) / (lengths[high] - lengths[low]);
  return curvePoint(from, step, (low + portion) / CURVE_SAMPLES);
}

function chosenOption(player, choices) {
  if (player.motion.type !== 'choice') return undefined;
  const optionId = Object.hasOwn(choices, player.id) ? choices[player.id] : undefined;
  return player.motion.options.find(option => option.id === optionId);
}

function positionAt(player, time, choices) {
  const motion = player.motion;
  if (motion.type === 'still' || motion.type === 'unspecified') return copyPoint(player.at);
  const steps = motion.type === 'choice' ? chosenOption(player, choices)?.steps : motion.steps;
  if (!steps) return copyPoint(player.at);

  let remaining = time - motion.startAt;
  let from = player.at;
  if (remaining <= 0) return copyPoint(from);
  for (const step of steps) {
    if (remaining >= step.seconds) {
      remaining -= step.seconds;
      if (step.type !== 'pause') from = step.to;
      continue;
    }
    switch (step.type) {
      case 'pause': return copyPoint(from);
      case 'line': return interpolate(from, step.to, remaining / step.seconds);
      case 'quadratic':
      case 'cubic': return alongCurve(from, step, remaining / step.seconds);
      default: throw new Error(`Unsupported motion step: ${step.type}`);
    }
  }
  return copyPoint(from);
}

/**
 * choices maps player IDs to option IDs. Missing or invalid choices hold the
 * entire scene at zero; the returned IDs let the UI explain what remains to pick.
 */
export function getScene(lesson, time, choices = {}) {
  const missingChoices = lesson.players
    .filter(player => player.motion.type === 'choice' && !chosenOption(player, choices))
    .map(player => player.id);
  const ready = missingChoices.length === 0;
  const effectiveTime = ready
    ? Math.max(0, Math.min(lesson.timeline.duration, Number.isFinite(time) ? time : 0))
    : 0;

  let keyframe = lesson.keyframes[0];
  for (const candidate of lesson.keyframes) {
    if (candidate.at > effectiveTime) break;
    keyframe = candidate;
  }
  const view = keyframe?.view;
  return {
    time: effectiveTime,
    players: lesson.players.map(player => ({
      ...player,
      position: positionAt(player, effectiveTime, choices),
    })),
    keyframe,
    zones: (lesson.zones || []).filter(zone => !view || view.zoneIds.includes(zone.id)),
    assignments: (lesson.assignments || [])
      .filter(assignment => !view || view.assignmentIds.includes(assignment.id)),
    ready,
    missingChoices,
  };
}

/** Returns full paths, including unselected alternatives, for route drawing. */
export function getRoutes(lesson, choices = {}) {
  return lesson.players.flatMap(player => {
    if (player.motion.type === 'path') {
      return [{playerId: player.id, selected: true, from: copyPoint(player.at), steps: player.motion.steps}];
    }
    if (player.motion.type === 'choice') {
      const selected = chosenOption(player, choices);
      return player.motion.options.map(option => ({
        playerId: player.id,
        optionId: option.id,
        selected: selected?.id === option.id,
        from: copyPoint(player.at),
        steps: option.steps,
      }));
    }
    return [];
  });
}

/** Also accepts a guide's geometric segments; pauses add no visible path. */
export function pathToSvg(from, steps) {
  const commands = [`M ${from[0]} ${from[1]}`];
  for (const step of steps) {
    switch (step.type) {
      case 'line': commands.push(`L ${step.to[0]} ${step.to[1]}`); break;
      case 'quadratic':
        commands.push(`Q ${step.control[0]} ${step.control[1]} ${step.to[0]} ${step.to[1]}`);
        break;
      case 'cubic':
        commands.push(`C ${step.control1[0]} ${step.control1[1]} ${step.control2[0]} ${step.control2[1]} ${step.to[0]} ${step.to[1]}`);
        break;
      case 'pause': break;
      default: throw new Error(`Unsupported path step: ${step.type}`);
    }
  }
  return commands.join(' ');
}
