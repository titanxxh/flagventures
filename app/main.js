import { dump } from 'js-yaml';
import { getScene, getRoutes, pathToSvg } from './scene.js';
import { prepareImport, validatePack } from './validation.js';

const $ = id => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
const types = { route: '基础路线', formation: '静态阵型', offense: '进攻战术', run: '跑球战术', defense: '防守方案' };
const bases = { source: '来源明确命名', 'shape-match': '路线形态对照', description: '按图描述', author: '作者编写', unspecified: '资料未说明' };
const colors = ['#80d4ff', '#ffc078', '#c7e8a2', '#fff1d5', '#ff9690', '#d7c9ff'];
const builtIn = JSON.parse($('builtInData').textContent);
const template = JSON.parse($('templateData').textContent);
let pack = builtIn;
let lesson;
let order = [];
let state = { time: 0, playing: false, speed: 2, role: null, choices: {} };
let hovered = null;
let focused = null;
let pendingImport = null;
let importRequest = 0;
let toastTimer;
let lastTick;
let fieldNodes = {};
let assetMap = new Map();
let catalogNodes = new Map();
let expandedGroups = new Set();
let expandedSections = new Set();

function text(node, value) { if (node.textContent !== String(value ?? '')) node.textContent = value ?? ''; }
function node(tag, attributes = {}, value) {
  const result = document.createElement(tag);
  for (const [key, val] of Object.entries(attributes)) result.setAttribute(key, val);
  if (value !== undefined) result.textContent = value;
  return result;
}
function svg(tag, attributes = {}, value) {
  const result = document.createElementNS(NS, tag);
  for (const [key, val] of Object.entries(attributes)) result.setAttribute(key, val);
  if (value !== undefined) result.textContent = value;
  return result;
}
function notify(message) {
  text($('toast'), message); $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500);
}
function playerColor(player) { return player.color || colors[lesson.players.indexOf(player) % colors.length]; }
function inspectId() { return hovered || focused || state.role; }
function pause() { state.playing = false; lastTick = undefined; render(); }
function seek(time) {
  if (time > 0 && !getScene(lesson, 0, state.choices).ready) { notify('先选好要演示的选项，再一起看跑位。'); return; }
  state.time = Math.max(0, Math.min(lesson.timeline.duration, time)); pause();
}
function showDialog(id) { pause(); $(id).showModal(); }
function download(name, content, mime) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const link = node('a', { href: url, download: name });
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
function setPack(value, status) {
  pack = value;
  expandedGroups = new Set();
  expandedSections = new Set();
  order = pack.sections.flatMap(section => section.lessonIds);
  assetMap = new Map((pack.assets || []).map(asset => [asset.id, asset]));
  text($('libraryStatus'), status);
  text($('libraryCount'), `${pack.lessons.length} 个教学条目 · 本地可用`);
  $('search').value = '';
  buildCatalog();
  selectLesson(order[0]);
}
function buildCatalog() {
  const query = $('search').value.trim().toLocaleLowerCase();
  const lessons = new Map(pack.lessons.map(item => [item.id, item]));
  const fragment = document.createDocumentFragment();
  catalogNodes = new Map();
  pack.sections.forEach((section, index) => {
    const sectionMatches = section.title.toLocaleLowerCase().includes(query);
    const matches = item => {
      const haystack = [item.title.zh, item.title.en, item.source?.page, ...item.players.flatMap(p => [p.label.en, p.label.zh])].join(' ').toLocaleLowerCase();
      return sectionMatches || haystack.includes(query);
    };
    const group = node('details', { class: 'catalog-section', 'data-catalog-section': section.id });
    group.open = Boolean(query) || expandedSections.has(section.id);
    const label = node('summary', { class: 'section-label' });
    const count = node('span', { class: 'section-count', 'data-section-count': '' });
    label.append(node('span', { class: 'section-number' }, String(index + 1).padStart(2, '0')), node('strong', { class: 'section-name' }, section.title), count);
    const contents = node('div', { class: 'section-entries' });
    group.append(label, contents);
    label.addEventListener('click', () => {
      if (query) return;
      if (group.open) expandedSections.delete(section.id); else expandedSections.add(section.id);
    });
    const appendEntry = (parent, item, subgroup) => {
      const button = node('button', { class: 'catalog-entry', 'data-lesson': item.id, 'aria-current': String(item.id === lesson?.id), title: item.title.zh });
      const prefix = subgroup ? `${subgroup.title} · ` : '';
      const title = subgroup && item.kind === 'formation' && item.title.zh === subgroup.title ? '阵型站位' : prefix && item.title.zh.startsWith(prefix) ? item.title.zh.slice(prefix.length) : item.title.zh;
      button.append(node('strong', {}, title), node('small', {}, `${item.title.en || types[item.kind]}${item.source?.page ? ` · p${item.source.page}` : ''}`));
      parent.append(button); catalogNodes.set(item.id, button);
    };
    const starts = new Map((section.groups || []).map(subgroup => [subgroup.lessonIds[0], subgroup]));
    for (let position = 0; position < section.lessonIds.length;) {
      const id = section.lessonIds[position];
      const subgroup = starts.get(id);
      if (!subgroup) {
        const item = lessons.get(id);
        if (matches(item)) appendEntry(contents, item);
        position++;
        continue;
      }
      position += subgroup.lessonIds.length;
      const groupMatches = subgroup.title.toLocaleLowerCase().includes(query);
      const entries = subgroup.lessonIds.map(id => lessons.get(id)).filter(item => groupMatches || matches(item));
      if (!entries.length) continue;
      const key = JSON.stringify([section.id, subgroup.id]);
      const details = node('details', { class: 'catalog-group', 'data-catalog-group': subgroup.id });
      details.open = Boolean(query) || expandedGroups.has(key);
      const summary = node('summary', { class: 'catalog-group-title' });
      summary.append(node('strong', {}, subgroup.title), node('span', { class: 'catalog-group-count' }, `${entries.length} 项`));
      const children = node('div', { class: 'catalog-group-entries' });
      entries.forEach(item => appendEntry(children, item, subgroup));
      details.append(summary, children);
      summary.addEventListener('click', () => {
        if (query) return;
        if (details.open) expandedGroups.delete(key); else expandedGroups.add(key);
      });
      contents.append(details);
    }
    if (contents.children.length) {
      text(count, `${contents.querySelectorAll('[data-lesson]').length} 项`);
      fragment.append(group);
    }
  });
  if (!catalogNodes.size) fragment.append(node('p', { class: 'empty-search' }, '没有找到，试试英文跑法或页码。'));
  $('catalog').replaceChildren(fragment);
}
function selectLesson(id) {
  lesson = pack.lessons.find(item => item.id === id);
  state = { time: 0, playing: false, speed: state.speed, role: null, choices: {} };
  hovered = focused = null; lastTick = undefined;
  if (!lesson) {
    text($('lessonTitle'), '内容包暂无教学条目');
    text($('summary'), '可以导入 YAML 添加战术，或从“我的战术文件”恢复内置手册。');
    for (const id of ['breadcrumb', 'lessonEnglish', 'direction', 'fieldHint', 'timingNote', 'sourceNote',
      'focusStatus', 'routeEnglish', 'routeChinese', 'routeDescription', 'routeBasis', 'routeDuties',
      'frameNumber', 'frameTitle', 'frameCue']) text($(id), '');
    for (const id of ['field', 'roles', 'choices', 'frames', 'notes', 'sourceReferences']) $(id).replaceChildren();
    for (const id of ['play', 'reset', 'seek', 'previous', 'next', 'exportLesson']) $(id).disabled = true;
    $('source').hidden = $('choices').hidden = $('routeDuties').hidden = true;
    $('teamPlan').hidden = $('playerCoaching').hidden = $('routeSituation').hidden = $('sourceReferences').hidden = true;
    text($('teachingCue'), '先选择一条教学内容。'); text($('teachingQuestion'), '');
    $('sourceImage').removeAttribute('src');
    $('seek').value = 0; $('seek').max = 0;
    text($('routePerson'), '?'); text($('routeMode'), '请先选择教学条目');
    text($('play'), '暂无条目'); text($('playState'), '暂无条目');
    text($('clock'), '0.0 / 0.0 s'); text($('lessonIndex'), '0 / 0');
    return;
  }
  $('exportLesson').disabled = $('reset').disabled = false;
  if (!catalogNodes.has(id) && $('search').value) {
    $('search').value = '';
    buildCatalog();
  }
  const section = pack.sections.find(item => item.lessonIds.includes(id));
  expandedSections.add(section.id);
  const sectionNode = catalogNodes.get(id)?.closest('.catalog-section');
  if (sectionNode) sectionNode.open = true;
  const subgroup = section.groups?.find(item => item.lessonIds.includes(id));
  text($('breadcrumb'), [section.title, subgroup?.title, types[lesson.kind]].filter(Boolean).join(' / '));
  if (subgroup) {
    expandedGroups.add(JSON.stringify([section.id, subgroup.id]));
    const details = catalogNodes.get(id)?.closest('.catalog-group');
    if (details) details.open = true;
  }
  text($('lessonTitle'), lesson.title.zh);
  text($('lessonEnglish'), `${lesson.title.en || ''}${lesson.source?.page ? ` · 来源第 ${lesson.source.page} 页` : ''}`);
  text($('summary'), lesson.summary);
  $('teamPlan').hidden = !lesson.teaching;
  text($('teachingGoal'), lesson.teaching?.goal);
  text($('teamCooperation'), lesson.teaching?.cooperation);
  text($('teachingCue'), lesson.teaching?.cue || '「你站在哪里？」');
  text($('teachingQuestion'), lesson.teaching?.question || '「你跑的时候，队友去哪儿？」');
  text($('direction'), `${lesson.field.attackDirection === 'up' ? '↑' : '↓'} 进攻方向${lesson.kind === 'defense' ? ' · 防守视角' : ''}`);
  text($('fieldHint'), lesson.kind === 'defense' ? '区域与箭头表示分工' : lesson.kind === 'formation' ? '看站位，认识彼此的位置' : lesson.kind === 'route' ? '单路线放大 · 保留原图方向' : '悬停球员看跑法 · 点击保留');
  text($('timingNote'), lesson.timeline.note);
  text($('sourceNote'), lesson.source ? `${lesson.source.title}${lesson.source.page ? `，第 ${lesson.source.page} 页` : ''}。${lesson.source.note || ''}` : '这是一条独立编写的教学内容，没有附带原书来源。');
  $('notes').replaceChildren(...(lesson.notes || []).map(note => node('li', {}, note)));
  const references = lesson.source?.references || [];
  $('sourceReferences').hidden = !references.length;
  $('sourceReferences').replaceChildren(...references.map(reference => {
    const item = node('li');
    item.append(node('a', { href: reference.url, target: '_blank', rel: 'noopener noreferrer' }, `${reference.title}${reference.locator ? ` · ${reference.locator}` : ''} ↗`));
    if (reference.note) item.append(node('span', {}, reference.note));
    return item;
  }));
  const asset = assetMap.get(lesson.source?.referenceAsset);
  $('source').hidden = !asset;
  $('sourceImage').removeAttribute('src');
  $('seek').max = lesson.timeline.duration;
  for (const [entryId, button] of catalogNodes) button.setAttribute('aria-current', String(entryId === id));
  const index = order.indexOf(id);
  text($('lessonIndex'), `${index + 1} / ${order.length}`);
  $('previous').disabled = index === 0; $('next').disabled = index === order.length - 1;
  buildRoles(); buildChoices(); buildField(); buildFrames(); render();
}
function buildRoles() {
  const buttons = [node('button', { class: 'role', 'data-show-all': '', 'aria-pressed': 'true' }, '看全队')];
  for (const player of lesson.players) buttons.push(node('button', { class: 'role', 'data-player': player.id, 'aria-pressed': 'false', 'aria-label': `${player.name || player.id}：${player.label.en || ''} ${player.label.zh}，点击保留` }, player.id));
  $('roles').replaceChildren(...buttons);
}
function buildChoices() {
  const players = lesson.players.filter(player => player.motion.type === 'choice');
  $('choices').hidden = !players.length;
  const content = [];
  for (const player of players) {
    content.push(node('p', {}, `${player.id} · ${player.motion.prompt}`));
    const options = node('div', { class: 'choice-options', role: 'group', 'aria-label': `${player.id} 的演示选项` });
    for (const option of player.motion.options) options.append(node('button', { 'data-choice-player': player.id, 'data-option': option.id, 'aria-pressed': 'false' }, option.title));
    content.push(options, node('p', { class: 'choice-note', 'data-choice-note': player.id, role: 'status' }));
  }
  $('choices').replaceChildren(...content);
}
function buildFrames() {
  $('frames').replaceChildren(...lesson.keyframes.map((frame, index) => {
    const button = node('button', { class: 'frame', 'data-frame': index, 'aria-pressed': 'false' });
    button.append(node('span', {}, `${String(index + 1).padStart(2, '0')} · ${frame.at.toFixed(1)}s`), node('strong', {}, frame.label));
    return button;
  }));
}
function buildField() {
  const { width: w, height: h, lineOfScrimmageY } = lesson.field;
  const unit = Math.min(w / 100, h / 55);
  const field = $('field');
  let viewport = { x: -3 * unit, y: -3 * unit, width: w + 6 * unit, height: h + 6 * unit };
  if (lesson.kind === 'route') {
    const points = lesson.players.map(p => p.at);
    for (const route of getRoutes(lesson, state.choices)) for (const step of route.steps) {
      for (const key of ['to', 'control', 'control1', 'control2']) if (step[key]) points.push(step[key]);
    }
    const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const height = Math.max(maxY - minY + 14 * unit, 28 * unit);
    const width = Math.max(maxX - minX + 14 * unit, height * 1.8);
    viewport = { x: (minX + maxX - width) / 2, y: (minY + maxY - height) / 2, width, height };
  }
  field.setAttribute('viewBox', `${viewport.x} ${viewport.y} ${viewport.width} ${viewport.height}`);
  field.style.overflow = 'hidden';
  field.replaceChildren();
  fieldNodes = { players: new Map(), routes: [], zones: new Map(), assignments: new Map(), unit, viewport };
  const defs = svg('defs');
  const arrow = svg('marker', { id: 'guide-arrow', viewBox: '0 0 8 8', refX: 6, refY: 4, markerWidth: 5, markerHeight: 5, orient: 'auto-start-reverse' });
  arrow.append(svg('path', { d: 'M0 0 L8 4 L0 8 L2 4 Z', fill: '#d7c9ff' })); defs.append(arrow);
  for (const player of lesson.players) {
    const marker = svg('marker', { id: `arrow-${player.id}`, viewBox: '0 0 8 8', refX: 6, refY: 4, markerWidth: 5, markerHeight: 5, orient: 'auto' });
    marker.append(svg('path', { d: 'M0 0 L8 4 L0 8 L2 4 Z', fill: playerColor(player) })); defs.append(marker);
  }
  field.append(defs, svg('rect', { x: 0, y: 0, width: w, height: h, rx: unit, fill: '#214f40', stroke: '#ffffff3c', 'stroke-width': .18 * unit }));
  for (let index = 1; index < 6; index++) field.append(svg('path', { d: `M0 ${h * index / 6}H${w}`, stroke: '#ffffff14', 'stroke-width': .15 * unit }));
  for (let index = 1; index < 22; index++) {
    const y = h * index / 22;
    field.append(svg('path', { d: `M${w * .02} ${y}h${unit} M${w * .33} ${y}h${unit} M${w * .66} ${y}h${unit} M${w * .97} ${y}h${unit}`, stroke: '#ffffff24', 'stroke-width': .13 * unit }));
  }
  if (lineOfScrimmageY !== undefined) {
    field.append(svg('path', { d: `M0 ${lineOfScrimmageY}H${w}`, stroke: '#9bd0db80', 'stroke-width': .25 * unit }));
    field.append(svg('text', { x: 2 * unit, y: lineOfScrimmageY - 1.1 * unit, fill: '#b9d5d1', 'font-size': 1.35 * unit }, '开球线'));
  }
  for (const zone of lesson.zones || []) {
    const group = svg('g', { 'data-zone': zone.id });
    const attributes = { fill: '#d7c9ff', 'fill-opacity': .17, stroke: '#d7c9ff', 'stroke-width': .22 * unit, 'stroke-dasharray': `${.7 * unit} ${.5 * unit}` };
    group.append(zone.type === 'ellipse' ? svg('ellipse', { ...attributes, cx: zone.center[0], cy: zone.center[1], rx: zone.radiusX, ry: zone.radiusY }) : svg('polygon', { ...attributes, points: zone.points.map(p => p.join(',')).join(' ') }));
    group.append(svg('title', {}, zone.label));
    field.append(group); fieldNodes.zones.set(zone.id, group);
  }
  for (const assignment of lesson.assignments || []) {
    const group = svg('g', { 'data-assignment': assignment.id });
    if (assignment.guide) group.append(svg('path', { d: pathToSvg(assignment.guide.from, assignment.guide.segments), fill: 'none', stroke: '#d7c9ff', 'stroke-width': .28 * unit, 'stroke-dasharray': `${.7 * unit} ${.5 * unit}`, ...(assignment.type === 'matchup' ? {} : {'marker-end': 'url(#guide-arrow)'}) }));
    field.append(group); fieldNodes.assignments.set(assignment.id, group);
  }
  for (const route of getRoutes(lesson, state.choices)) {
    const player = lesson.players.find(player => player.id === route.playerId);
    const path = svg('path', { class: 'route', 'data-player-route': player.id, d: pathToSvg(route.from, route.steps), fill: 'none', stroke: playerColor(player), 'stroke-width': .43 * unit, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'marker-end': `url(#arrow-${player.id})`, 'pointer-events': 'none' });
    field.append(path); fieldNodes.routes.push({ node: path, ...route });
  }
  for (const player of lesson.players) {
    const group = svg('g', { class: 'player', 'data-player': player.id, tabindex: 0, role: 'button', 'aria-label': `${player.name || player.id}：${player.label.en || ''} ${player.label.zh}，点击保留` });
    group.append(svg('circle', { class: 'focus-ring', r: 2.85 * unit, fill: 'none', stroke: '#fff8d6', 'stroke-width': .25 * unit, opacity: 0 }));
    const common = { fill: playerColor(player), stroke: '#153b2f', 'stroke-width': .22 * unit };
    if (player.team === 'defense') group.append(svg('path', { ...common, d: `M0 ${-2.2 * unit}L${2.2 * unit} ${1.85 * unit}L${-2.2 * unit} ${1.85 * unit}Z` }));
    else if (player.id === 'C') group.append(svg('rect', { ...common, x: -1.85 * unit, y: -1.85 * unit, width: 3.7 * unit, height: 3.7 * unit, rx: .45 * unit }));
    else group.append(svg('circle', { ...common, r: 1.95 * unit }));
    group.append(svg('text', { x: 0, y: (player.team === 'defense' ? .95 : .75) * unit, 'text-anchor': 'middle', 'font-size': (player.id.length > 2 ? 1.25 : player.id.length > 1 ? 1.7 : 2.2) * unit, 'font-weight': 750, fill: '#153b2f' }, player.id));
    group.append(svg('circle', { r: 2.7 * unit, fill: 'transparent' }));
    field.append(group); fieldNodes.players.set(player.id, group);
  }
  const tooltip = svg('g', { id: 'fieldTooltip', 'pointer-events': 'none', 'aria-hidden': 'true', style: 'display:none' });
  tooltip.append(svg('rect', { width: 26 * unit, height: 7.5 * unit, rx: 1 * unit, fill: '#fffefa', stroke: '#d1ddc5', 'stroke-width': .15 * unit }));
  const first = svg('text', { x: 1.2 * unit, y: 3 * unit, fill: '#183c32', 'font-size': 2 * unit, 'font-weight': 700 });
  const second = svg('text', { x: 1.2 * unit, y: 5.8 * unit, fill: '#68775e', 'font-size': 1.35 * unit });
  tooltip.append(first, second); field.append(tooltip);
  Object.assign(fieldNodes, { tooltip, tooltipFirst: first, tooltipSecond: second });
}
function render() {
  if (!lesson) return;
  const scene = getScene(lesson, state.time, state.choices);
  const inspected = inspectId();
  for (const player of scene.players) {
    const group = fieldNodes.players.get(player.id);
    group.setAttribute('transform', `translate(${player.position.join(' ')})`);
    group.setAttribute('opacity', inspected === null || player.id === inspected ? 1 : .53);
    group.setAttribute('aria-pressed', String(player.id === state.role));
    group.querySelector('.focus-ring').setAttribute('opacity', player.id === inspected ? 1 : 0);
  }
  for (const route of fieldNodes.routes) {
    const option = state.choices[route.playerId];
    const otherOption = route.optionId && option && route.optionId !== option;
    route.node.style.display = otherOption ? 'none' : '';
    route.node.setAttribute('opacity', inspected === null ? .66 : route.playerId === inspected ? 1 : .2);
    route.node.setAttribute('stroke-dasharray', route.optionId && !option ? `${fieldNodes.unit} ${fieldNodes.unit * .7}` : 'none');
    route.node.setAttribute('stroke-width', (route.playerId === inspected ? .58 : .4) * fieldNodes.unit);
  }
  const zoneIds = new Set(scene.zones.map(zone => zone.id));
  for (const [id, group] of fieldNodes.zones) {
    group.style.display = zoneIds.has(id) ? '' : 'none';
    const owner = (lesson.assignments || []).find(a => a.type === 'coverage' && a.zone === id)?.player;
    group.setAttribute('opacity', inspected === null || inspected === owner ? 1 : .45);
  }
  const assignmentIds = new Set(scene.assignments.map(a => a.id));
  for (const [id, group] of fieldNodes.assignments) {
    group.style.display = assignmentIds.has(id) ? '' : 'none';
    const owner = lesson.assignments.find(a => a.id === id).player;
    group.setAttribute('opacity', inspected === null || owner === inspected ? 1 : .35);
  }
  $('roles').querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(button.hasAttribute('data-show-all') ? state.role === null : button.dataset.player === state.role)));
  const player = lesson.players.find(player => player.id === inspected);
  text($('focusStatus'), state.role === null ? '正在看全队' : `关注 ${state.role} · 队友仍可见`);
  text($('routePerson'), player?.id || '?'); $('routePerson').style.background = player ? playerColor(player) : '#e6eadf';
  text($('routeMode'), player ? `${player.id} 的${lesson.kind === 'defense' ? '分工' : '跑法'} · ${hovered ? '悬停查看' : focused ? '键盘查看' : '已保留'}` : '认识跑法');
  text($('routeEnglish'), player ? player.label.en || player.label.zh : '移到球员上试试');
  text($('routeChinese'), player?.label.en ? player.label.zh : '');
  text($('routeDescription'), player?.label.description || '名称、路线和动作一起看。点击一个字母，边播放边观察他和队友怎样配合。');
  $('playerCoaching').hidden = !player?.coaching;
  text($('routeCooperation'), player?.coaching?.cooperation);
  text($('routeTiming'), player?.coaching?.timing);
  const selectedSituation = player?.motion.type === 'choice'
    ? player.motion.options.find(option => option.id === state.choices[player.id]) : undefined;
  const situation = player?.motion.type === 'choice'
    ? selectedSituation ? selectedSituation.note || `本次演示：${selectedSituation.title}` : player.motion.prompt
    : '';
  $('routeSituation').hidden = !situation;
  text($('routeSituation'), situation);
  const duties = player ? scene.assignments.filter(a => a.player === player.id).map(a => {
    if (a.type === 'coverage') return `负责区域：${lesson.zones.find(z => z.id === a.zone).label}`;
    if (a.type === 'matchup') return `对位球员：${lesson.players.find(p => p.id === a.target).name || a.target}`;
    return '职责：按图示方向冲传';
  }) : [];
  $('routeDuties').hidden = !duties.length;
  text($('routeDuties'), duties.join('；'));
  text($('routeBasis'), player ? `${bases[player.label.basis]}${player.label.note ? ` · ${player.label.note}` : ''}` : '');
  fieldNodes.tooltip.style.display = player ? '' : 'none';
  if (player) {
    const position = scene.players.find(p => p.id === player.id).position;
    const unit = fieldNodes.unit;
    const view = fieldNodes.viewport;
    const x = Math.max(view.x + unit, Math.min(view.x + view.width - 27 * unit, position[0] + 3.3 * unit));
    const above = position[1] - 9 * unit;
    const desiredY = above > view.y + unit ? above : position[1] + 3.5 * unit;
    const y = Math.max(view.y + unit, Math.min(view.y + view.height - 8.5 * unit, desiredY));
    fieldNodes.tooltip.setAttribute('transform', `translate(${x} ${y})`);
    const title = `${player.id} · ${player.label.en || player.label.zh}`;
    text(fieldNodes.tooltipFirst, title.length > 23 ? `${title.slice(0, 22)}…` : title);
    text(fieldNodes.tooltipSecond, (player.label.en ? player.label.zh : bases[player.label.basis]).slice(0, 16));
  }
  const staticScene = lesson.timeline.duration === 0;
  text($('playState'), staticScene ? '静态站位' : !scene.ready ? '先选演示选项' : state.playing ? '演示中' : '已暂停 · 可讲解');
  text($('play'), staticScene ? '静态站位' : !scene.ready ? '先选演示选项' : state.playing ? 'Ⅱ 暂停讲解' : state.time >= lesson.timeline.duration ? '↻ 再看一遍' : state.time > 0 ? '▶ 继续播放' : '▶ 开始演示');
  $('play').disabled = staticScene || !scene.ready;
  $('seek').disabled = staticScene || !scene.ready;
  $('seek').value = state.time;
  text($('clock'), `${state.time.toFixed(1)} / ${lesson.timeline.duration.toFixed(1)} s`);
  const frameIndex = lesson.keyframes.indexOf(scene.keyframe);
  text($('frameNumber'), String(frameIndex + 1).padStart(2, '0'));
  text($('frameTitle'), scene.keyframe.label); text($('frameCue'), scene.keyframe.cue);
  $('frames').querySelectorAll('button').forEach((button, index) => {
    button.setAttribute('aria-pressed', String(index === frameIndex));
    button.disabled = !scene.ready && lesson.keyframes[index].at > 0;
  });
  $('choices').querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(state.choices[button.dataset.choicePlayer] === button.dataset.option)));
  $('choices').querySelectorAll('[data-choice-note]').forEach(element => {
    const player = lesson.players.find(player => player.id === element.dataset.choiceNote);
    const selected = player.motion.options.find(option => option.id === state.choices[player.id]);
    text(element, selected ? selected.note || `本次演示：${selected.title}` : '请先选择一种情形。切换选项后会回到站位并暂停。');
  });
}

$('search').addEventListener('input', buildCatalog);
$('catalog').addEventListener('click', event => { const button = event.target.closest('[data-lesson]'); if (button) selectLesson(button.dataset.lesson); });
$('previous').addEventListener('click', () => selectLesson(order[order.indexOf(lesson.id) - 1]));
$('next').addEventListener('click', () => selectLesson(order[order.indexOf(lesson.id) + 1]));
$('play').addEventListener('click', () => {
  if (!getScene(lesson, 0, state.choices).ready) return;
  if (state.time >= lesson.timeline.duration) state.time = 0;
  state.playing = !state.playing; lastTick = undefined; render();
});
$('reset').addEventListener('click', () => seek(0));
$('seek').addEventListener('input', event => seek(Number(event.target.value)));
$('frames').addEventListener('click', event => { const button = event.target.closest('[data-frame]'); if (button) seek(lesson.keyframes[Number(button.dataset.frame)].at); });
document.querySelectorAll('[data-speed]').forEach(button => button.addEventListener('click', () => {
  state.speed = Number(button.dataset.speed);
  lastTick = undefined;
  document.querySelectorAll('[data-speed]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
}));
$('choices').addEventListener('click', event => {
  const button = event.target.closest('[data-choice-player]'); if (!button) return;
  state.choices[button.dataset.choicePlayer] = button.dataset.option;
  state.time = 0; pause();
});
for (const id of ['field', 'roles']) {
  const surface = $(id);
  surface.addEventListener('click', event => {
    const target = event.target.closest('[data-player],[data-show-all]'); if (!target) return;
    state.role = target.hasAttribute('data-show-all') ? null : target.dataset.player;
    hovered = focused = null; render();
  });
  surface.addEventListener('pointermove', event => {
    const target = event.target.closest('[data-player]');
    const value = target?.dataset.player;
    hovered = value || null; render();
  });
  surface.addEventListener('pointerleave', () => { hovered = null; render(); });
  surface.addEventListener('focusin', event => {
    const target = event.target.closest('[data-player]');
    focused = target?.dataset.player || null; hovered = null; render();
  });
  surface.addEventListener('focusout', () => { focused = null; render(); });
}
$('field').addEventListener('keydown', event => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const target = event.target.closest('[data-player]'); if (!target) return;
  event.preventDefault(); state.role = target.dataset.player; hovered = focused = null; render();
});
$('source').addEventListener('click', () => {
  const asset = assetMap.get(lesson.source?.referenceAsset); if (!asset) return;
  text($('sourceTitle'), `${lesson.title.zh} · 原页对照`);
  $('sourceImage').src = `data:${asset.mime};base64,${asset.base64}`;
  text($('sourceCaption'), `${lesson.source.title}${lesson.source.page ? ` · 第 ${lesson.source.page} 页` : ''}。${lesson.source.note || ''}`);
  showDialog('sourceDialog');
});
$('manage').addEventListener('click', () => showDialog('manageDialog'));
$('help').addEventListener('click', () => showDialog('helpDialog'));
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
$('chooseFiles').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', async event => {
  const files = [...event.target.files]; if (!files.length) return;
  const request = ++importRequest;
  pendingImport = null; $('importActions').hidden = true;
  $('importReport').hidden = false; $('importReport').className = '';
  text($('importReport'), '正在检查文件…');
  try {
    if (files.length > 200) throw new Error('一次最多导入 200 个文件。');
    for (const file of files) {
      const limit = /\.json$/i.test(file.name) ? 50 * 1024 * 1024 : 1024 * 1024;
      if (file.size > limit) throw new Error(`${file.name}：文件过大，YAML 上限 1 MB，战术包上限 50 MB。`);
    }
    const data = await Promise.all(files.map(async file => ({ name: file.name, text: await file.text() })));
    if (request !== importRequest) return;
    const result = prepareImport(pack, data);
    pendingImport = result;
    const lines = result.mode === 'pack'
      ? [`将替换当前的 ${pack.lessons.length} 个条目，载入战术包中的 ${result.pack.lessons.length} 个条目和 ${result.pack.sections.length} 个章节。`, '当前内容需要保留时，请先保存完整战术包。']
      : [`检查通过：新增 ${result.added.length} 条，整条更新 ${result.updated.length} 条。`, ...result.added.map(id => `新增 · ${result.pack.lessons.find(l => l.id === id).title.zh} (${id})`), ...result.updated.map(id => `更新 · ${result.pack.lessons.find(l => l.id === id).title.zh} (${id})`), ...(result.updated.length ? ['更新会替换整条内容，省略的旧字段不会保留；目录位置不变。'] : [])];
    if (result.warnings.length) lines.push('', '提示：', ...result.warnings);
    text($('importReport'), lines.join('\n')); $('importActions').hidden = false;
  } catch (error) {
    if (request !== importRequest) return;
    $('importReport').className = 'error';
    text($('importReport'), `没有改动当前手册。\n${error.message}`);
  } finally { if (request === importRequest) $('fileInput').value = ''; }
});
function clearImport() { importRequest++; pendingImport = null; $('importActions').hidden = true; $('importReport').hidden = true; }
$('manageDialog').addEventListener('close', clearImport);
$('cancelImport').addEventListener('click', clearImport);
$('applyImport').addEventListener('click', () => {
  if (!pendingImport) return;
  const result = pendingImport;
  setPack(result.pack, '本次导入的内容');
  if (result.mode === 'lessons') selectLesson(result.added[0] || result.updated[0] || order[0]);
  clearImport(); $('manageDialog').close(); notify('已载入。离开前记得保存完整战术包。');
});
$('restore').addEventListener('click', () => {
  clearImport(); setPack(builtIn, '内置手册'); $('manageDialog').close(); notify('已回到内置手册。');
});
$('exportPack').addEventListener('click', () => { download('我的腰旗战术.flagbook.json', JSON.stringify(pack, null, 2), 'application/json;charset=utf-8'); notify('已开始保存完整战术包。'); });
$('exportLesson').addEventListener('click', () => { download(`${lesson.id}.yaml`, dump(lesson, { lineWidth: 100, noRefs: true }), 'application/yaml;charset=utf-8'); notify('已开始下载当前条目。'); });
$('downloadTemplate').addEventListener('click', () => { download('new-play.yaml', template, 'application/yaml;charset=utf-8'); });
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
function tick(now) {
  if (state.playing) {
    if (lastTick !== undefined) state.time = Math.min(lesson.timeline.duration, state.time + Math.min((now - lastTick) / 1000, .1) * state.speed);
    lastTick = now;
    if (state.time >= lesson.timeline.duration) state.playing = false;
    render();
  } else lastTick = undefined;
  requestAnimationFrame(tick);
}
try { validatePack(builtIn, '内置手册'); setPack(builtIn, '内置手册'); requestAnimationFrame(tick); }
catch (error) { text($('lessonTitle'), '内置内容检查未通过'); text($('summary'), error.message); console.error(error); }
