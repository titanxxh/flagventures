// Validated lesson data is the single source of route geometry and timing.
// Depth is perpendicular to the line of scrimmage, not distance traveled.
export function getRouteMeasurements(lesson) {
  const guide = lesson.routeGuide;
  if (!guide) return [];
  const player = lesson.players.find(item => item.id === guide.player);
  let position = player.at;
  let at = player.motion.startAt;
  const endpoints = player.motion.steps.map(step => {
    at += step.seconds;
    if (step.type !== 'pause') position = step.to;
    return {position: [...position], at};
  });
  const direction = lesson.field.attackDirection === 'up' ? -1 : 1;
  return guide.marks.map(mark => {
    const endpoint = endpoints[mark.step];
    return {...mark, position: [...endpoint.position], at: endpoint.at,
      depthYards: (endpoint.position[1] - lesson.field.lineOfScrimmageY) * direction};
  });
}
