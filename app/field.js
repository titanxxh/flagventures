// Draws one lesson's field as SVG and updates those nodes for each moment of playback.
// Geometry comes from scene.js/ball.js; this module only turns it into SVG.
import { t } from './i18n.js';
import { svg, text } from './dom.js';
import { getRouteMeasurements } from './route-measurements.js';
import { getRoutes, getActiveRoute, pathToSvg, positionAt } from './scene.js';
import { getBallState } from './ball.js';

const colors = ['#80d4ff', '#ffc078', '#c7e8a2', '#fff1d5', '#ff9690', '#d7c9ff'];
export const basisLabels = { source: '来源明确命名', 'shape-match': '路线形态对照', description: '按图描述', author: '作者编写', unspecified: '资料未说明' };
export function colorFor(lesson, player) { return player.color || colors[lesson.players.indexOf(player) % colors.length]; }

export function numberLabel(value) { return Number(value.toFixed(1)).toString(); }
export function depthLabel(value) { return t`${numberLabel(value)} 码`; }

// An explicit aspect ratio lets every browser derive the field height from its width.
function setViewBox(field, {x, y, width, height}) {
  field.setAttribute('viewBox', `${x} ${y} ${width} ${height}`);
  field.style.aspectRatio = `${width} / ${height}`;
}
// Keep the line-of-scrimmage caption clear of the players lined up on it: try just above
// the line, then just below, sliding along it from the preferred side until there is a gap.
function placeLineLabel(label, {width, lineY, players, unit, glyph, preferEnd}) {
  label.setAttribute('text-anchor', 'start');
  label.setAttribute('x', 0); label.setAttribute('y', lineY);
  const measured = label.getBBox();
  const rise = lineY - measured.y;
  const circles = players.map(player => ({x: player.at[0], y: player.at[1], r: 2.6 * glyph}));
  const fits = (left, baseline) => {
    const box = {x: left, y: baseline - rise, width: measured.width, height: measured.height};
    return box.x >= unit && box.x + box.width <= width - unit
      && !circles.some(({x, y, r}) => x + r > box.x && x - r < box.x + box.width && y + r > box.y && y - r < box.y + box.height);
  };
  const lefts = [];
  for (let left = 2 * unit; left + measured.width <= width - unit; left += unit) lefts.push(left);
  if (preferEnd) lefts.reverse();
  // Hug the line first; then clear the players' circles entirely above or below it.
  const clear = 2.8 * glyph;
  for (const baseline of [lineY - 1.1 * glyph, lineY + rise + 1.1 * glyph, lineY - clear - (measured.height - rise), lineY + clear + rise]) {
    const left = lefts.find(value => fits(value, baseline));
    if (left !== undefined) { label.setAttribute('x', left); label.setAttribute('y', baseline); return; }
  }
  label.setAttribute('x', preferEnd ? Math.max(unit, width - 2 * unit - measured.width) : 2 * unit);
  label.setAttribute('y', lineY - 1.1 * glyph);
}
// Field y-positions of the yard numbers drawn beside a yard-scaled field (every 5 yards from the line).
function yardTicks({unit, height: h, lineOfScrimmageY, endZoneDepth = 0, attackDirection}) {
  if (unit !== 'yard' || lineOfScrimmageY === undefined) return [];
  const majorInterval = Math.max(1, Math.ceil(h / 200)) * 5;
  const direction = attackDirection === 'up' ? -1 : 1;
  const limit = direction < 0 ? lineOfScrimmageY - endZoneDepth : h - endZoneDepth - lineOfScrimmageY;
  const ticks = [];
  for (let distance = 0; distance <= limit && ticks.length <= 200; distance += majorInterval) ticks.push(lineOfScrimmageY + direction * distance);
  return ticks;
}
// Basic routes open zoomed to the route, QB and depth labels; "看全场" restores the whole field.
function routeViewport(viewport, {lesson, choices}, labels, unit, glyph) {
  const {lineOfScrimmageY, height, endZoneDepth = 0} = lesson.field;
  const points = lesson.players.map(player => player.at);
  for (const route of getRoutes(lesson, choices)) {
    points.push(route.from);
    for (const step of route.steps) for (const key of ['to', 'control', 'control1', 'control2']) if (step[key]) points.push(step[key]);
  }
  for (const box of labels) points.push([box.x, box.y], [box.x, box.y + box.height]);
  if (lineOfScrimmageY !== undefined) points.push([0, lineOfScrimmageY]);
  const ys = points.map(point => point[1]);
  let top = Math.min(...ys) - 5 * glyph, bottom = Math.max(...ys) + 6 * glyph;
  const minimum = height * .36;
  if (bottom - top < minimum) { const extra = (minimum - (bottom - top)) / 2; top -= extra; bottom += extra; }
  // Never slice a caption (end zones, 场地中间, 中线, yard numbers) in half at the crop edge.
  const bands = [[height / 2 - unit - 1.6 * glyph, height / 2 - unit + .5 * glyph], [endZoneDepth + 4 * unit - 1.6 * glyph, endZoneDepth + 4 * unit + .5 * glyph]];
  if (endZoneDepth) bands.push([endZoneDepth / 2 - 1.4 * glyph, endZoneDepth / 2 + 1.4 * glyph], [height - endZoneDepth / 2 - 1.4 * glyph, height - endZoneDepth / 2 + 1.4 * glyph]);
  for (const y of yardTicks(lesson.field)) bands.push([y - 1.2 * glyph, y + 1.2 * glyph]);
  // Moving one edge can land it inside a neighbouring caption, so settle the edges in a few passes.
  for (let pass = 0; pass < 4; pass++) {
    for (const [from, to] of bands) {
      if (top > from && top < to) top = from - .5 * glyph;
      if (bottom > from && bottom < to) bottom = to + .5 * glyph;
    }
  }
  top = Math.max(viewport.y, top); bottom = Math.min(viewport.y + viewport.height, bottom);
  return {...viewport, y: top, height: bottom - top};
}

export function buildField(field, context) {
  const {lesson, choices, ballScenario, fullField, glyphScale, onSeek} = context;
  const playerColor = player => colorFor(lesson, player);
  const { width: w, height: h, lineOfScrimmageY } = lesson.field;
  const isRoute = lesson.kind === 'route';
  const scaled = lesson.field.unit === 'yard';
  const unit = isRoute ? Math.min(w / 48, h / 80) : scaled ? Math.min(w / 60, h / 60) : Math.min(w / 100, h / 55);
  // Geometry (grid, margins, callouts) uses `unit`; players, lines and captions use `g` so they stay legible on phones.
  const g = unit * glyphScale;
  let viewport = { x: -3 * unit, y: -3 * unit, width: w + (scaled ? 14 : 6) * unit, height: h + 6 * unit };
  setViewBox(field, viewport);
  field.style.overflow = 'hidden';
  field.replaceChildren();
  const nodes = { players: new Map(), routes: [], zones: new Map(), assignments: new Map(), facingGuides: new Map(), unit: g, viewport };
  const defs = svg('defs');
  const arrow = svg('marker', { id: 'guide-arrow', viewBox: '0 0 8 8', refX: 6, refY: 4, markerWidth: 5, markerHeight: 5, orient: 'auto-start-reverse' });
  arrow.append(svg('path', { d: 'M0 0 L8 4 L0 8 L2 4 Z', fill: '#d7c9ff' })); defs.append(arrow);
  const ballArrow = svg('marker', {id: 'ball-arrow', viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 4, markerHeight: 4, orient: 'auto'});
  ballArrow.append(svg('path', {d: 'M0 0L8 4L0 8Z', fill: '#ffba75'})); defs.append(ballArrow);
  for (const player of lesson.players) {
    const marker = svg('marker', { id: `arrow-${player.id}`, viewBox: '0 0 8 8', refX: 6, refY: 4, markerWidth: 5, markerHeight: 5, orient: 'auto' });
    marker.append(svg('path', { d: 'M0 0 L8 4 L0 8 L2 4 Z', fill: playerColor(player) })); defs.append(marker);
  }
  field.append(defs, svg('rect', { x: 0, y: 0, width: w, height: h, rx: unit, fill: '#214f40', stroke: '#ffffff3c', 'stroke-width': .18 * unit }));
  if (scaled) {
    const endZone = lesson.field.endZoneDepth || 0;
    // Keep authored fields with unusually large dimensions bounded to 200 ticks.
    const yardInterval = Math.max(1, Math.ceil(h / 200));
    const majorInterval = yardInterval * 5;
    const gridStart = lineOfScrimmageY === undefined ? endZone : endZone + ((lineOfScrimmageY - endZone) % majorInterval);
    for (let y = gridStart, count = 0; y <= h - endZone && count <= 200; y += majorInterval, count++) field.append(svg('path', {d: `M0 ${y}H${w}`, stroke: '#ffffff20', 'stroke-width': .15 * unit}));
    for (let y = endZone, count = 0; y <= h - endZone && count <= 200; y += yardInterval, count++) field.append(svg('path', {d: `M${w * .02} ${y}h${unit} M${w * .96} ${y}h${unit}`, stroke: '#ffffff30', 'stroke-width': .13 * unit}));
    if (lineOfScrimmageY !== undefined) {
      const direction = lesson.field.attackDirection === 'up' ? -1 : 1;
      const limit = direction < 0 ? lineOfScrimmageY - endZone : h - endZone - lineOfScrimmageY;
      for (let distance = 0, count = 0; distance <= limit && count <= 200; distance += majorInterval, count++) {
        const y = lineOfScrimmageY + direction * distance;
        field.append(svg('path', {d: `M${w} ${y}h${unit}`, stroke: '#e8cf90', 'stroke-width': .2 * unit}));
        field.append(svg('text', {x: w + 1.8 * unit, y, fill: '#e8cf90', 'font-size': 1.8 * g, 'dominant-baseline': 'middle', 'data-yard-tick': distance}, depthLabel(distance)));
      }
    }
  } else {
    for (let index = 1; index < 6; index++) field.append(svg('path', { d: `M0 ${h * index / 6}H${w}`, stroke: '#ffffff14', 'stroke-width': .15 * unit }));
    for (let index = 1; index < 22; index++) {
      const y = h * index / 22;
      field.append(svg('path', { d: `M${w * .02} ${y}h${unit} M${w * .33} ${y}h${unit} M${w * .66} ${y}h${unit} M${w * .97} ${y}h${unit}`, stroke: '#ffffff24', 'stroke-width': .13 * unit }));
    }
  }
  if (isRoute) {
    const depth = lesson.field.endZoneDepth ?? (scaled ? 0 : h * .08);
    for (const [y, label] of [[0, lesson.field.attackDirection === 'up' ? '进攻端区' : '己方端区'], [h - depth, lesson.field.attackDirection === 'up' ? '己方端区' : '进攻端区']]) {
      if (!depth) continue;
      field.append(svg('rect', {x: 0, y, width: w, height: depth, fill: '#cfdfbd', 'fill-opacity': .1, 'data-field-endzone': ''}));
      field.append(svg('text', {x: w / 2, y: y + depth / 2, 'dominant-baseline': 'middle', 'text-anchor': 'middle', fill: '#d2dfcd', 'font-size': 2 * g}, label));
    }
    field.append(svg('path', {d: `M${w / 2} ${depth}V${h - depth}`, stroke: '#ffffff40', 'stroke-width': .15 * unit, 'stroke-dasharray': `${unit} ${unit}`}));
    field.append(svg('text', {x: w / 2, y: depth + 4 * unit, fill: '#d2dfcd', 'font-size': 1.7 * g, 'text-anchor': 'middle'}, '场地中间'));
    field.append(svg('path', {d: `M0 ${h / 2}H${w}`, stroke: '#ffffff45', 'stroke-width': .18 * unit}));
    field.append(svg('text', {x: w - unit, y: h / 2 - unit, fill: '#b9d5d1', 'font-size': 1.5 * g, 'text-anchor': 'end'}, '中线'));
    for (const [x, angle] of [[1.8 * unit, -90], [w - 1.8 * unit, 90]]) {
      field.append(svg('text', {transform: `translate(${x} ${h * .64}) rotate(${angle})`, 'text-anchor': 'middle', fill: '#b9d5d1', 'font-size': 1.6 * g}, '边线'));
    }
  }
  if (lineOfScrimmageY !== undefined) {
    field.append(svg('path', { d: `M0 ${lineOfScrimmageY}H${w}`, stroke: '#9bd0db80', 'stroke-width': .25 * unit }));
    const lineLabel = svg('text', { fill: '#b9d5d1', stroke: '#214f40', 'stroke-width': .45 * g, 'paint-order': 'stroke', 'font-size': 1.6 * g, 'data-scrimmage-label': '' }, '开球线');
    field.append(lineLabel);
    placeLineLabel(lineLabel, {width: w, lineY: lineOfScrimmageY, players: lesson.players, unit, glyph: g, preferEnd: isRoute});
  }
  for (const zone of lesson.zones || []) {
    const group = svg('g', { 'data-zone': zone.id });
    const attributes = { fill: '#d7c9ff', 'fill-opacity': .17, stroke: '#d7c9ff', 'stroke-width': .22 * unit, 'stroke-dasharray': `${.7 * unit} ${.5 * unit}` };
    group.append(zone.type === 'ellipse' ? svg('ellipse', { ...attributes, cx: zone.center[0], cy: zone.center[1], rx: zone.radiusX, ry: zone.radiusY }) : svg('polygon', { ...attributes, points: zone.points.map(p => p.join(',')).join(' ') }));
    group.append(svg('title', {}, zone.label));
    field.append(group); nodes.zones.set(zone.id, group);
  }
  for (const assignment of lesson.assignments || []) {
    const group = svg('g', { 'data-assignment': assignment.id });
    if (assignment.guide) group.append(svg('path', { d: pathToSvg(assignment.guide.from, assignment.guide.segments), fill: 'none', stroke: '#d7c9ff', 'stroke-width': .28 * g, 'stroke-dasharray': `${.7 * unit} ${.5 * unit}`, ...(assignment.type === 'matchup' ? {} : {'marker-end': 'url(#guide-arrow)'}) }));
    field.append(group); nodes.assignments.set(assignment.id, group);
  }
  for (const route of getRoutes(lesson, choices)) {
    const player = lesson.players.find(player => player.id === route.playerId);
    const shape = {fill: 'none', stroke: playerColor(player), 'stroke-width': .43 * g, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'pointer-events': 'none'};
    const path = svg('path', { ...shape, class: 'route', 'data-player-route': player.id, d: pathToSvg(route.from, route.steps), 'marker-end': isRoute ? 'none' : `url(#arrow-${player.id})` });
    const activeNode = isRoute ? svg('path', {...shape, 'data-active-route': player.id, 'marker-end': `url(#arrow-${player.id})`, visibility: 'hidden'}) : undefined;
    field.append(path); nodes.routes.push({ node: path, activeNode, ...route });
  }
  buildBallPaths(field, g, context, nodes);
  const measurements = getRouteMeasurements(lesson);
  const distanceLabels = [];
  for (const [index, mark] of measurements.entries()) {
    const [x, y] = mark.position;
    const group = svg('g', {class: 'distance-marker', 'data-distance-mark': mark.id, 'data-depth-yards': mark.depthYards, 'data-marker-x': x, 'data-marker-y': y, role: 'button', tabindex: 0, 'aria-label': `${depthLabel(mark.depthYards)} · ${mark.label}`});
    group.append(svg('circle', {class: 'distance-marker-focus', cx: x, cy: y, r: 3.3 * g, fill: 'none', stroke: '#ffe8a7', 'stroke-width': .25 * g}));
    group.append(svg('circle', {cx: x, cy: y, r: .8 * g, fill: '#e8cf90', stroke: '#173b30', 'stroke-width': .2 * g}));
    group.addEventListener('click', () => onSeek(mark.at));
    group.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSeek(mark.at); } });
    const label = `${index + 1} · ${depthLabel(mark.depthYards)}`;
    const labelNode = svg('text', {x: x + 1.7 * g, y: y - 1.8 * g, fill: '#ffe8a7', stroke: '#214f40', 'stroke-width': .5 * g, 'paint-order': 'stroke', 'font-size': 2.2 * g, 'font-weight': 700}, label);
    group.append(labelNode);
    field.append(group);
    // Cuts at the same depth still need separate readable labels (for example Chair).
    let bounds = labelNode.getBBox();
    for (let attempt = 0; attempt < measurements.length; attempt++) {
      const overlap = distanceLabels.some(box => bounds.x < box.x + box.width + g && bounds.x + bounds.width + g > box.x && bounds.y < box.y + box.height + g && bounds.y + bounds.height + g > box.y);
      if (!overlap) break;
      labelNode.setAttribute('y', Number(labelNode.getAttribute('y')) - 3.5 * g);
      bounds = labelNode.getBBox();
    }
    if (Number(labelNode.getAttribute('y')) !== y - 1.8 * g) {
      group.insertBefore(svg('path', {d: `M${x} ${y}L${labelNode.getAttribute('x')} ${Number(labelNode.getAttribute('y')) + .6 * g}`, stroke: '#e8cf90', 'stroke-width': .16 * g, 'stroke-dasharray': `${.4 * g} ${.4 * g}`, 'pointer-events': 'none', fill: 'none'}), group.firstChild);
    }
    distanceLabels.push(bounds);
  }
  const firstMark = measurements[0];
  if (firstMark) {
    const runner = lesson.players.find(player => player.id === lesson.routeGuide.player);
    // Mark the initial straight stem separately from the route's total travel.
    if (firstMark.step === 0 && runner.at[0] === firstMark.position[0] && runner.at[1] === lineOfScrimmageY) {
      const x = Math.max(unit, runner.at[0] - 4 * g), top = firstMark.position[1], bottom = lineOfScrimmageY;
      field.append(svg('path', {d: `M${x + unit} ${top}H${x}V${bottom}h${unit}`, stroke: '#e8cf90', 'stroke-width': .2 * g, fill: 'none', 'data-stem-bracket': ''}));
      field.append(svg('text', {x: x - unit, y: (top + bottom) / 2, fill: '#ffe8a7', 'font-size': 2.2 * g, 'text-anchor': 'end', 'dominant-baseline': 'middle'}, depthLabel(firstMark.depthYards)));
    }
  }
  // Current-step arrows sit above distance dots so a turn marker cannot hide the arrowhead.
  for (const route of nodes.routes) if (route.activeNode) field.append(route.activeNode);
  const facingPlayers = new Set(getRoutes(lesson).filter(route => route.steps.some(step => step.facePlayer)).map(route => route.playerId));
  for (const id of facingPlayers) {
    const guide = svg('line', {'data-facing-guide': id, stroke: '#ffe8a7', 'stroke-width': .2 * g, 'stroke-dasharray': `${.45 * g} ${.6 * g}`, 'pointer-events': 'none', visibility: 'hidden'});
    field.append(guide); nodes.facingGuides.set(id, guide);
  }
  for (const player of lesson.players) {
    const group = svg('g', { class: 'player', 'data-player': player.id, tabindex: 0, role: 'button', 'aria-label': t`${player.name || player.id}：${player.label.en || ''} ${player.label.zh}，点击保留` });
    group.append(svg('circle', { class: 'focus-ring', r: 2.85 * g, fill: 'none', stroke: '#fff8d6', 'stroke-width': .25 * g, opacity: 0 }));
    const common = { fill: playerColor(player), stroke: '#153b2f', 'stroke-width': .22 * g };
    if (player.team === 'defense') group.append(svg('path', { ...common, d: `M0 ${-2.2 * g}L${2.2 * g} ${1.85 * g}L${-2.2 * g} ${1.85 * g}Z` }));
    else if (player.id === 'C') group.append(svg('rect', { ...common, x: -1.85 * g, y: -1.85 * g, width: 3.7 * g, height: 3.7 * g, rx: .45 * g }));
    else group.append(svg('circle', { ...common, r: 1.95 * g }));
    if (facingPlayers.has(player.id)) group.append(svg('path', {'data-facing': '', d: `M${-1.1 * g} ${-2.65 * g}L0 ${-4.25 * g}L${1.1 * g} ${-2.65 * g}Z`, fill: '#ffe8a7', stroke: '#153b2f', 'stroke-width': .2 * g, visibility: 'hidden'}));
    group.append(svg('text', { x: 0, y: (player.team === 'defense' ? .95 : .75) * g, 'text-anchor': 'middle', 'font-size': (player.id.length > 2 ? 1.25 : player.id.length > 1 ? 1.7 : 2.2) * g, 'font-weight': 750, fill: '#153b2f' }, player.id));
    if (isRoute && player.id === 'QB') group.append(svg('text', {x: 0, y: 4.5 * g, 'text-anchor': 'middle', fill: '#ffd3a2', 'font-size': 1.6 * g}, '传球参照'));
    // A generous invisible hit area keeps small letters easy to tap.
    group.append(svg('circle', { r: 2.7 * g * (glyphScale > 1 ? 1.2 : 1), fill: 'transparent' }));
    field.append(group); nodes.players.set(player.id, group);
  }
  buildBallActions(field, unit, g, context, nodes);
  if (ballScenario) {
    const ball = svg('g', {'data-ball': '', role: 'img', 'pointer-events': 'none'});
    // The same small offset is used for held balls and both flight endpoints.
    // It keeps the football visible beside a player's letter without teleporting.
    const glyph = svg('g', {transform: `translate(${2.65 * g} ${-1.7 * g}) rotate(-30)`});
    glyph.append(svg('ellipse', {rx: 1.65 * g, ry: .96 * g, fill: '#934725', stroke: '#fff5ce', 'stroke-width': .4 * g}));
    glyph.append(svg('path', {d: `M${-.85 * g} 0H${.85 * g} M${-.45 * g} ${-.35 * g}V${.35 * g} M0 ${-.35 * g}V${.35 * g} M${.45 * g} ${-.35 * g}V${.35 * g}`, stroke: '#fff5ce', 'stroke-width': .2 * g, fill: 'none'}));
    ball.append(glyph); field.append(ball); nodes.ball = ball;
    const carrier = svg('circle', {'data-ball-carrier': '', r: 2.45 * g, stroke: '#fff5ce', 'stroke-width': .45 * g, fill: 'none', 'pointer-events': 'none'});
    field.insertBefore(carrier, ball); nodes.carrier = carrier;
  }
  if (isRoute && !fullField) {
    viewport = routeViewport(viewport, context, distanceLabels, unit, g);
    setViewBox(field, viewport);
    nodes.viewport = viewport;
  }
  const tooltip = svg('g', { id: 'fieldTooltip', 'pointer-events': 'none', 'aria-hidden': 'true', style: 'display:none' });
  tooltip.append(svg('rect', { width: 26 * g, height: 7.5 * g, rx: 1 * g, fill: '#fffefa', stroke: '#d1ddc5', 'stroke-width': .15 * g }));
  const first = svg('text', { x: 1.2 * g, y: 3 * g, fill: '#183c32', 'font-size': 2 * g, 'font-weight': 700 });
  const second = svg('text', { x: 1.2 * g, y: 5.8 * g, fill: '#4f5f53', 'font-size': 1.35 * g });
  tooltip.append(first, second); field.append(tooltip);
  return Object.assign(nodes, { tooltip, tooltipFirst: first, tooltipSecond: second, facingPlayers });
}

function buildBallPaths(field, unit, {lesson, choices, ballScenario}, nodes) {
  // `unit` is the glyph size here: flight endpoints must match the drawn ball offset.
  if (!ballScenario) return;
  const ball = getBallState(lesson, 0, choices, ballScenario);
  nodes.ballPaths = ball.flights.map(flight => {
    const group = svg('g', {class: 'ball-flight', 'data-ball-flight': flight.id});
    const points = [flight.start, flight.end].map(([x, y]) => [x + 2.65 * unit, y - 1.7 * unit]);
    group.append(svg('path', {d: `M${points[0].join(' ')}L${points[1].join(' ')}`, stroke: '#ffba75', 'stroke-width': .55 * unit, 'stroke-dasharray': `${1.5 * unit} ${.95 * unit}`, fill: 'none', 'marker-end': 'url(#ball-arrow)'}));
    const middle = points[0].map((value, axis) => (value + points[1][axis]) / 2);
    group.append(svg('text', {class: 'ball-flight-label', x: middle[0] + unit, y: middle[1] - unit, fill: '#ffd0a0', 'font-size': 1.65 * unit, 'font-weight': 700}, flight.type === 'snap' ? '开球' : '传球'));
    field.append(group);
    return {...flight, node: group};
  });
  nodes.ballCarries = ball.carries.map(carry => {
    const path = svg('path', {class: 'ball-carry', 'data-ball-carry': carry.owner, stroke: '#fff5ce', 'stroke-width': .8 * unit, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: .85, fill: 'none'});
    const player = lesson.players.find(item => item.id === carry.owner);
    const samples = Math.min(160, Math.max(2, Math.ceil((carry.endAt - carry.at) * 12)));
    const points = Array.from({length: samples + 1}, (_, index) => {
      const time = carry.at + (carry.endAt - carry.at) * index / samples;
      return {time, point: positionAt(player, time, choices)};
    });
    field.append(path);
    return {...carry, player, points, node: path};
  });
}

function buildBallActions(field, unit, glyph, {lesson, choices, ballScenario, onSeek}, nodes) {
  if (!ballScenario) return;
  const types = {'handoff': '交递', 'fake-handoff': '假交', 'pump-fake': '假传'};
  const actions = ballScenario.events.filter(event => types[event.type]).map(event => {
    const position = id => positionAt(lesson.players.find(player => player.id === id), event.at, choices);
    const from = position(event.from);
    const point = event.type === 'pump-fake' ? from : from.map((value, axis) => (value + position(event.to)[axis]) / 2);
    const next = ballScenario.events.find(item => item.at > event.at);
    const endAt = Math.min(event.endAt ?? event.at + .6, next?.at ?? lesson.timeline.duration);
    return {event, point, endAt};
  });
  const placed = [];
  const {width, height} = lesson.field;
  const overlap = (a, b) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  // Cards stay put while players move, so keep them clear of every player at
  // each keyframe, and above all while their own action is happening.
  const playerBox = ([x, y], weight) => ({x: x - 4 * glyph, y: y - 4 * glyph, width: 8 * glyph, height: 8 * glyph, weight});
  const playersAt = (times, weight) => lesson.players.flatMap(player => times.map(time => playerBox(positionAt(player, time, choices), weight)));
  const obstacles = [
    ...actions.map(({point: [x, y]}) => ({x: x - 4 * unit, y: y - 4 * unit, width: 8 * unit, height: 8 * unit, weight: 5})),
    ...playersAt([...new Set([0, ...lesson.keyframes.map(frame => frame.at)])], 15),
    ...playersAt([lesson.timeline.duration], 30)
  ];
  nodes.ballActions = actions.map(({event, point: [x, y], endAt}, index) => {
    const participants = event.type === 'handoff' ? `${event.from} → ${event.to}` : event.to ? `${event.from} / ${event.to}` : event.from;
    const label = `${index + 1} · ${t(types[event.type])} ${participants}`;
    const group = svg('g', {class: 'ball-action', 'data-ball-action': event.id, 'data-action-type': event.type,
      'data-phase': 'preview', 'data-event-at': event.at, 'data-event-position': JSON.stringify([x, y]), role: 'button', tabindex: 0});
    const leader = svg('path', {class: 'ball-action-leader', fill: 'none', 'stroke-width': .2 * unit, 'pointer-events': 'none'});
    // Only a true exchange gets an open circle. A fake uses a label and leader;
    // leave its meeting point clear so no location dot covers a player's letter.
    const pin = event.type === 'handoff' ? svg('circle', {class: 'ball-action-pin', cx: x, cy: y, r: 3.2 * unit,
      fill: 'none', stroke: '#ffce92', 'stroke-width': .35 * unit, 'pointer-events': 'none'}) : undefined;
    const card = svg('rect', {class: 'ball-action-card', rx: 1.1 * unit, 'stroke-width': .22 * unit});
    const title = svg('text', {class: 'ball-action-title', 'font-size': 2.25 * unit, 'font-weight': 700}, label);
    const status = svg('text', {class: 'ball-action-status', 'font-size': 1.7 * unit});
    group.append(leader);
    if (pin) group.append(pin);
    group.append(card, title, status); field.append(group);
    let measuredWidth = title.getBBox().width;
    for (const value of ['待演示', '此刻', '已发生']) {
      text(status, `${event.at.toFixed(1)} s · ${t(value)}`);
      measuredWidth = Math.max(measuredWidth, status.getBBox().width);
    }
    const box = {width: Math.min(measuredWidth + 2.8 * unit, width * .48), height: 7.7 * unit};
    // Imported player IDs may be long. Keep the full identifier accessible while
    // fitting the printed label within its callout instead of covering the field.
    const textWidth = box.width - 2.8 * unit;
    if (title.getBBox().width > textWidth) {
      title.setAttribute('textLength', textWidth); title.setAttribute('lengthAdjust', 'spacingAndGlyphs');
    }
    // Keep callouts away from the meeting points and from one another. Their
    // leaders stay anchored while players move; layout is stable during seeking.
    const near = [];
    for (const offset of [0, -9, 9, -18, 18, -27, 27]) {
      near.push([x - box.width - 5.2 * unit, y - box.height / 2 + offset * unit]);
      near.push([x + 5.2 * unit, y - box.height / 2 + offset * unit]);
    }
    near.push([x - box.width / 2, y - box.height - 5.2 * unit], [x - box.width / 2, y + 5.2 * unit]);
    const blockers = [...obstacles, ...playersAt([0, .5, 1].map(step => event.at + (endAt - event.at) * step), 40)];
    const best = candidates => candidates.map(([cx, cy]) => {
      const candidate = {...box, x: Math.max(unit, Math.min(width - box.width - unit, cx)), y: Math.max(unit, Math.min(height - box.height - unit, cy))};
      const padded = {...candidate, x: candidate.x - unit, y: candidate.y - unit, width: box.width + 2 * unit, height: box.height + 2 * unit};
      // A leader that runs through another card reads as pointing at the wrong action.
      const end = [Math.max(candidate.x, Math.min(candidate.x + box.width, x)), Math.max(candidate.y, Math.min(candidate.y + box.height, y))];
      const crossings = Array.from({length: 12}, (_, step) => [x + (end[0] - x) * (step + .5) / 12, y + (end[1] - y) * (step + .5) / 12])
        .filter(([px, py]) => placed.some(other => px > other.x && px < other.x + other.width && py > other.y && py < other.y + other.height)).length;
      const penalty = crossings * 40 + placed.reduce((sum, other) => sum + overlap(padded, other) / unit ** 2 * 100, 0)
        + blockers.reduce((sum, other) => sum + overlap(padded, other) / unit ** 2 * other.weight, 0);
      return {candidate, penalty, score: penalty + Math.hypot(candidate.x + box.width / 2 - x, candidate.y + box.height / 2 - y) / unit};
    }).reduce((a, b) => b.score < a.score ? b : a);
    let choice = best(near);
    // On a crowded or short field none of those spots may be clear; then any
    // clear spot is better than one that hides a player, even if further away.
    if (choice.penalty > 0) {
      const grid = [];
      for (let gx = unit; gx <= width - box.width - unit; gx += 2 * unit) {
        for (let gy = unit; gy <= height - box.height - unit; gy += 2 * unit) grid.push([gx, gy]);
      }
      if (grid.length) { const other = best(grid); if (other.score < choice.score) choice = other; }
    }
    const position = choice.candidate;
    placed.push(position);
    for (const [key, value] of Object.entries(position)) card.setAttribute(key, value);
    title.setAttribute('x', position.x + 1.4 * unit); title.setAttribute('y', position.y + 3.05 * unit);
    status.setAttribute('x', position.x + 1.4 * unit); status.setAttribute('y', position.y + 5.95 * unit);
    const end = [Math.max(position.x, Math.min(position.x + box.width, x)), Math.max(position.y, Math.min(position.y + box.height, y))];
    const length = Math.hypot(end[0] - x, end[1] - y);
    const ratio = length > 0 ? Math.min(3.2 * unit / length, 1) : 0;
    leader.setAttribute('d', `M${x + (end[0] - x) * ratio} ${y + (end[1] - y) * ratio}L${end.join(' ')}`);
    group.addEventListener('click', () => onSeek(event.at));
    group.addEventListener('keydown', input => {
      if (input.key === 'Enter' || input.key === ' ') { input.preventDefault(); onSeek(event.at); }
    });
    return {event, endAt, label, node: group, status};
  });
}

// Moves players, highlights the inspected player's route and shows zones for the current scene.
export function renderField(nodes, {lesson, scene, choices, inspected, role, ballOwner, tooltip}) {
  for (const player of scene.players) {
    const group = nodes.players.get(player.id);
    group.setAttribute('transform', `translate(${player.position.join(' ')})`);
    group.setAttribute('opacity', inspected === null || player.id === inspected || player.id === ballOwner || (lesson.kind === 'route' && player.id === 'QB') ? 1 : .53);
    group.setAttribute('aria-pressed', String(player.id === role));
    group.querySelector('.focus-ring').setAttribute('opacity', player.id === inspected ? 1 : 0);
    const facing = group.querySelector('[data-facing]');
    const guide = nodes.facingGuides.get(player.id);
    if (facing) {
      facing.setAttribute('visibility', player.facing ? 'visible' : 'hidden');
      facing.setAttribute('data-face-player', player.facing?.target || '');
      guide.setAttribute('visibility', player.facing?.target ? 'visible' : 'hidden');
      if (player.facing) {
        const [dx, dy] = player.facing.direction;
        facing.setAttribute('transform', `rotate(${Math.atan2(dy, dx) * 180 / Math.PI + 90})`);
        facing.setAttribute('data-direction', JSON.stringify(player.facing.direction));
        group.setAttribute('aria-label', player.facing.target ? t`${player.id}：面向 ${player.facing.target}，点击保留` : t`${player.id}：面朝跑动方向，点击保留`);
        if (player.facing.target) {
          const target = scene.players.find(item => item.id === player.facing.target);
          for (const [key, value] of Object.entries({x1: player.position[0], y1: player.position[1], x2: target.position[0], y2: target.position[1]})) guide.setAttribute(key, value);
        }
      }
    }
  }
  for (const route of nodes.routes) {
    const option = choices[route.playerId];
    const otherOption = route.optionId && option && route.optionId !== option;
    route.node.style.display = otherOption ? 'none' : '';
    route.node.setAttribute('opacity', route.activeNode ? (inspected === null || route.playerId === inspected ? .28 : .12) : inspected === null ? .66 : route.playerId === inspected ? 1 : .2);
    route.node.setAttribute('stroke-dasharray', route.optionId && !option ? `${nodes.unit} ${nodes.unit * .7}` : 'none');
    route.node.setAttribute('stroke-width', (route.playerId === inspected ? .58 : .4) * nodes.unit);
    if (route.activeNode) {
      const player = scene.players.find(item => item.id === route.playerId);
      const active = !otherOption && (!route.optionId || option === route.optionId) ? getActiveRoute(player, scene.time, choices) : undefined;
      route.activeNode.setAttribute('visibility', active ? 'visible' : 'hidden');
      route.activeNode.setAttribute('d', active ? pathToSvg(active.from, active.steps) : '');
      route.activeNode.setAttribute('opacity', inspected === null || route.playerId === inspected ? 1 : .35);
      route.activeNode.setAttribute('stroke-width', .58 * nodes.unit);
    }
  }
  const zoneIds = new Set(scene.zones.map(zone => zone.id));
  for (const [id, group] of nodes.zones) {
    group.style.display = zoneIds.has(id) ? '' : 'none';
    const owner = (lesson.assignments || []).find(a => a.type === 'coverage' && a.zone === id)?.player;
    group.setAttribute('opacity', inspected === null || inspected === owner ? 1 : .45);
  }
  const assignmentIds = new Set(scene.assignments.map(a => a.id));
  for (const [id, group] of nodes.assignments) {
    group.style.display = assignmentIds.has(id) ? '' : 'none';
    const owner = lesson.assignments.find(a => a.id === id).player;
    group.setAttribute('opacity', inspected === null || owner === inspected ? 1 : .35);
  }
  const player = tooltip.player;
  nodes.tooltip.style.display = player && tooltip.visible ? '' : 'none';
  if (player) {
    const position = scene.players.find(p => p.id === player.id).position;
    const unit = nodes.unit;
    const view = nodes.viewport;
    const x = Math.max(view.x + unit, Math.min(view.x + view.width - 27 * unit, position[0] + 3.3 * unit));
    const above = position[1] - 9 * unit;
    const desiredY = above > view.y + unit ? above : position[1] + 3.5 * unit;
    const y = Math.max(view.y + unit, Math.min(view.y + view.height - 8.5 * unit, desiredY));
    nodes.tooltip.setAttribute('transform', `translate(${x} ${y})`);
    const title = `${player.id} · ${player.label.en || player.label.zh}`;
    text(nodes.tooltipFirst, title.length > 23 ? `${title.slice(0, 22)}…` : title);
    text(nodes.tooltipSecond, (player.label.en ? player.label.zh : t(basisLabels[player.label.basis])).slice(0, 16));
  }
}

// Places the football, its trail and the action markers for the current moment.
export function renderBallLayer(nodes, {ball, time, choices, status}) {
  nodes.ball.setAttribute('transform', `translate(${ball.position.join(' ')})`);
  nodes.ball.setAttribute('data-ball-state', ball.state);
  nodes.ball.setAttribute('data-ball-owner', ball.owner || '');
  nodes.ball.setAttribute('data-ball-position', JSON.stringify(ball.position));
  nodes.ball.setAttribute('aria-label', status);
  nodes.carrier.setAttribute('visibility', ball.owner ? 'visible' : 'hidden');
  nodes.carrier.setAttribute('data-owner', ball.owner || '');
  nodes.carrier.setAttribute('transform', `translate(${ball.position.join(' ')})`);
  for (const path of nodes.ballPaths) {
    path.node.setAttribute('opacity', time < path.at ? .45 : time < path.endAt ? 1 : .3);
    path.node.setAttribute('data-phase', time < path.at ? 'preview' : time < path.endAt ? 'flight' : 'complete');
  }
  for (const carry of nodes.ballCarries) {
    const end = Math.min(time, carry.endAt);
    const points = carry.points.filter(item => item.time < end).map(item => item.point);
    if (time > carry.at) points.push(positionAt(carry.player, end, choices));
    carry.node.setAttribute('d', points.length > 1 ? points.map((point, index) => `${index ? 'L' : 'M'}${point.join(' ')}`).join(' ') : '');
  }
  for (const action of nodes.ballActions) {
    const phase = time < action.event.at ? 'preview' : time < action.endAt ? 'active' : 'complete';
    action.node.dataset.phase = phase;
    const label = phase === 'preview' ? '待演示' : phase === 'active' ? '此刻' : '已发生';
    text(action.status, `${action.event.at.toFixed(1)} s · ${t(label)}`);
    action.node.setAttribute('aria-label', t`${action.label}，${label}，点击暂停到 ${action.event.at} 秒`);
  }
}
