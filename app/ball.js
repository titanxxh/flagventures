import {positionAt} from './scene.js';

const flightTypes = new Set(['snap', 'pass']);

/**
 * Resolve one authored teaching scenario without changing the canonical lesson.
 * Runtime keyframes are derived from the same events as the ball animation.
 */
export function resolveBallScenario(lesson, scenarioId) {
  if (!lesson.ball) return {lesson, choices: {}, scenario: undefined};
  const scenario = lesson.ball.scenarios.find(item => item.id === scenarioId)
    || lesson.ball.scenarios.find(item => item.id === lesson.ball.defaultScenario);
  if (!scenario) return {lesson, choices: {}, scenario: undefined};

  const motions = new Map((scenario.motions || []).map(item => [item.player, item.motion]));
  const players = lesson.players.map(player => motions.has(player.id)
    ? {...player, motion: motions.get(player.id)} : player);
  const frames = new Map(lesson.keyframes.map(frame => [frame.at, frame]));
  const ids = new Set(lesson.keyframes.map(frame => frame.id));
  const addFrame = (event, index, phase, at) => {
    let id = `ball-event-${index}-${phase}`;
    while (ids.has(id)) id += '-ball';
    ids.add(id);
    // Event captions must not unexpectedly reveal an existing hidden teaching layer.
    const previous = lesson.keyframes.findLast(frame => frame.at <= at);
    frames.set(at, {id, at,
      label: phase === 'end' ? event.endLabel ?? event.label : event.label,
      cue: phase === 'end' ? event.endCue ?? event.cue : event.cue,
      ...(previous?.view ? {view: previous.view} : {})});
  };
  scenario.events.forEach((event, index) => {
    addFrame(event, index, 'start', event.at);
    if (event.endAt !== undefined) addFrame(event, index, 'end', event.endAt);
  });
  return {
    lesson: {...lesson, players, keyframes: [...frames.values()].sort((a, b) => a.at - b.at)},
    choices: {...scenario.choices},
    scenario,
  };
}

/**
 * One ball, reconstructed from teaching time rather than previous animation frames.
 * Flight endpoints are fixed at release/catch times, never attached to a moving
 * receiver during the flight. A carrier keeps moving on their authored route.
 */
export function getBallState(lesson, time, choices = {}, scenario) {
  if (!lesson.ball || !scenario) return undefined;
  const players = new Map(lesson.players.map(player => [player.id, player]));
  const ready = lesson.players.every(player => player.motion.type !== 'choice'
    || player.motion.options.some(option => option.id === choices[player.id]));
  const at = ready ? Math.max(0, Math.min(lesson.timeline.duration, Number.isFinite(time) ? time : 0)) : 0;
  const position = (id, when) => positionAt(players.get(id), when, choices);
  const flights = scenario.events.filter(event => flightTypes.has(event.type)).map(event => ({
    id: event.id, type: event.type, from: event.from, to: event.to,
    start: position(event.from, event.at), end: position(event.to, event.endAt),
    at: event.at, endAt: event.endAt,
  }));
  const carries = [];
  let carrier = lesson.ball.initialOwner, carryAt = 0;
  const carryUntil = endAt => {
    if (endAt > carryAt) carries.push({owner: carrier, at: carryAt, endAt});
  };
  for (const event of scenario.events) {
    if (flightTypes.has(event.type)) {
      carryUntil(event.at);
      carrier = event.to; carryAt = event.endAt;
    } else if (event.type === 'handoff') {
      carryUntil(event.at);
      carrier = event.to; carryAt = event.at;
    }
  }
  carryUntil(lesson.timeline.duration);
  const byId = new Map(flights.map(flight => [flight.id, flight]));
  let owner = lesson.ball.initialOwner;
  let latest;
  for (const event of scenario.events) {
    if (at < event.at) break;
    latest = event;
    if (flightTypes.has(event.type)) {
      if (at < event.endAt) {
        const flight = byId.get(event.id);
        const progress = (at - event.at) / (event.endAt - event.at);
        return {state: 'flight', owner: null,
          position: flight.start.map((value, axis) => value + (flight.end[axis] - value) * progress),
          event, progress, flights, carries};
      }
      owner = event.to;
    } else if (event.type === 'handoff') owner = event.to;
    // Both fake-handoff and pump-fake preserve possession throughout the action.
  }
  return {state: 'held', owner, position: position(owner, at), event: latest, flights, carries};
}
