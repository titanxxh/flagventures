import { t, getLanguage, setLanguage, captureStaticTranslations } from './i18n.js';
import { localizePack } from './localization.js';
import { getRouteMeasurements } from './route-measurements.js';
import { dump } from 'js-yaml';
import { getScene, getRoutes, getActiveRoute, pathToSvg, positionAt } from './scene.js';
import { resolveBallScenario, getBallState } from './ball.js';
import { prepareImport, validatePack } from './validation.js';

const $ = id => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
const types = { route: '基础路线', formation: '静态阵型', offense: '进攻战术', run: '跑球战术', defense: '防守方案' };
const bases = { source: '来源明确命名', 'shape-match': '路线形态对照', description: '按图描述', author: '作者编写', unspecified: '资料未说明' };
const colors = ['#80d4ff', '#ffc078', '#c7e8a2', '#fff1d5', '#ff9690', '#d7c9ff'];
const builtIn = JSON.parse($('builtInData').textContent);
const template = JSON.parse($('templateData').textContent);
try { setLanguage(localStorage.getItem('flagventures.language')); } catch {}
const updateStaticLanguage = captureStaticTranslations(document.documentElement);
let canonicalPack = builtIn;
let libraryStatus = '内置手册';
let pack = localizePack(builtIn, getLanguage(), t);
let lesson;
let sourceLesson;
let ballScenario;
let rebuildingLesson = false;
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

function text(node, value) { value = t(value); if (node.textContent !== String(value ?? '')) node.textContent = value ?? ''; }
function node(tag, attributes = {}, value) {
  const result = document.createElement(tag);
  for (const [key, val] of Object.entries(attributes)) result.setAttribute(key, ['aria-label', 'title'].includes(key) ? t(val) : val);
  if (value !== undefined) result.textContent = t(value);
  return result;
}
function svg(tag, attributes = {}, value) {
  const result = document.createElementNS(NS, tag);
  for (const [key, val] of Object.entries(attributes)) result.setAttribute(key, ['aria-label', 'title'].includes(key) ? t(val) : val);
  if (value !== undefined) result.textContent = t(value);
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
  canonicalPack = value; libraryStatus = status;
  pack = localizePack(value, getLanguage(), t);
  expandedGroups = new Set();
  expandedSections = new Set();
  order = pack.sections.flatMap(section => section.lessonIds);
  assetMap = new Map((pack.assets || []).map(asset => [asset.id, asset]));
  text($('libraryStatus'), status);
  text($('libraryCount'), t`${pack.lessons.length} 个教学条目 · 本地可用`);
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
      const haystack = [canonicalPack.lessons.find(original => original.id === item.id)?.title.zh, item.title.zh, item.title.en, item.source?.page, ...item.players.flatMap(p => [p.label.en, p.label.zh])].join(' ').toLocaleLowerCase();
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
      button.append(node('strong', {}, title), node('small', {}, `${item.title.en || t(types[item.kind])}${item.source?.page ? ` · p${item.source.page}` : ''}`));
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
      summary.append(node('strong', {}, subgroup.title), node('span', { class: 'catalog-group-count' }, t`${entries.length} 项`));
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
      text(count, t`${contents.querySelectorAll('[data-lesson]').length} 项`);
      fragment.append(group);
    }
  });
  if (!catalogNodes.size) fragment.append(node('p', { class: 'empty-search' }, '没有找到，试试英文跑法或页码。'));
  $('catalog').replaceChildren(fragment);
}
function selectLesson(id, preserve = false) {
  // Replacing focused controls fires focusout synchronously. Wait until the new
  // lesson and every control/field node agree before rendering those events.
  rebuildingLesson = true;
  try { rebuildLesson(id, preserve); }
  finally { rebuildingLesson = false; }
  render();
}
function rebuildLesson(id, preserve = false) {
  sourceLesson = pack.lessons.find(item => item.id === id);
  if (!preserve) state = { time: 0, playing: false, speed: state.speed, role: sourceLesson?.kind === 'route' ? sourceLesson.players.find(player => ['path', 'choice'].includes(player.motion.type))?.id || null : null, choices: {}, showBall: true, scenarioId: sourceLesson?.ball?.defaultScenario };
  lesson = sourceLesson;
  ballScenario = undefined;
  if (sourceLesson?.ball && state.showBall) {
    const resolved = resolveBallScenario(sourceLesson, state.scenarioId);
    lesson = resolved.lesson;
    ballScenario = resolved.scenario;
    state.choices = resolved.choices;
    state.scenarioId = ballScenario.id;
  }
  hovered = focused = null; lastTick = undefined;
  $('routeDistances').hidden = !lesson?.routeGuide;
  $('routeOrientation').hidden = lesson?.kind !== 'route';
  $('teamPlanHeading').textContent = t(lesson?.kind === 'route' ? '这条路线怎么跑' : '这套配合想做到什么');
  $('ballControls').hidden = !sourceLesson?.ball;
  $('ballReadout').hidden = $('ballLegend').hidden = !ballScenario;
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
  text($('breadcrumb'), [section.title, subgroup?.title, t(types[lesson.kind])].filter(Boolean).join(' / '));
  if (subgroup) {
    expandedGroups.add(JSON.stringify([section.id, subgroup.id]));
    const details = catalogNodes.get(id)?.closest('.catalog-group');
    if (details) details.open = true;
  }
  text($('lessonTitle'), lesson.title.zh);
  text($('lessonEnglish'), `${lesson.title.en || ''}${lesson.source?.page ? t` · 来源第 ${lesson.source.page} 页` : ''}`);
  text($('summary'), lesson.summary);
  $('teamPlan').hidden = !lesson.teaching;
  text($('teachingGoal'), lesson.teaching?.goal);
  text($('teamCooperation'), lesson.teaching?.cooperation);
  text($('teachingCue'), lesson.teaching?.cue || '「你站在哪里？」');
  text($('teachingQuestion'), lesson.teaching?.question || '「你跑的时候，队友去哪儿？」');
  text($('direction'), `${lesson.field.attackDirection === 'up' ? '↑' : '↓'} ${t('进攻方向')}${lesson.kind === 'defense' ? t(' · 防守视角') : ''}`);
  text($('fieldHint'), lesson.kind === 'defense' ? '区域与箭头表示分工' : lesson.kind === 'formation' ? '看站位，认识彼此的位置' : lesson.kind === 'route' ? lesson.field.unit === 'yard' ? '全场按码绘制 · 秒数仅为演示时间' : '全场示意 · 距离与时间用于教学' : '悬停球员看跑法 · 点击保留');
  text($('timingNote'), lesson.timeline.note);
  text($('sourceNote'), lesson.source ? `${lesson.source.title}${lesson.source.page ? t`，第 ${lesson.source.page} 页` : ''}${getLanguage() === 'en' ? '. ' : '。'}${lesson.source.note || ''}` : '这是一条独立编写的教学内容，没有附带原书来源。');
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
  buildRoles(); buildChoices(); buildBallControls(); buildField(); buildFrames(); buildDistanceGuide();
}
function buildRoles() {
  const buttons = [node('button', { class: 'role', 'data-show-all': '', 'aria-pressed': 'true' }, '看全队')];
  for (const player of lesson.players) buttons.push(node('button', { class: 'role', 'data-player': player.id, 'aria-pressed': 'false', 'aria-label': t`${player.name || player.id}：${player.label.en || ''} ${player.label.zh}，点击保留` }, player.id));
  $('roles').replaceChildren(...buttons);
}
function buildChoices() {
  const players = lesson.players.filter(player => player.motion.type === 'choice');
  $('choices').hidden = !players.length || Boolean(ballScenario);
  const content = [];
  for (const player of players) {
    content.push(node('p', {}, `${player.id} · ${player.motion.prompt}`));
    const options = node('div', { class: 'choice-options', role: 'group', 'aria-label': t`${player.id} 的演示选项` });
    for (const option of player.motion.options) options.append(node('button', { 'data-choice-player': player.id, 'data-option': option.id, 'aria-pressed': 'false' }, option.title));
    content.push(options, node('p', { class: 'choice-note', 'data-choice-note': player.id, role: 'status' }));
  }
  $('choices').replaceChildren(...content);
}
function buildBallControls() {
  if (!sourceLesson.ball) return;
  $('ballEnabled').checked = Boolean(state.showBall);
  text($('ballChoiceHeading'), lesson.kind === 'offense' ? '这次球传给谁' : '选择球的流转');
  $('ballOptions').replaceChildren(...sourceLesson.ball.scenarios.map(scenario =>
    node('button', {'data-ball-scenario': scenario.id, 'aria-pressed': String(state.scenarioId === scenario.id), ...(state.showBall ? {} : {disabled: ''})}, scenario.title)));
  text($('ballScenarioNote'), ballScenario?.note || '已切换为只看跑位。打开球路可查看传球和交接。');
  text($('ballSourceNote'), sourceLesson.ball.note);
}
function buildFrames() {
  $('frames').replaceChildren(...lesson.keyframes.map((frame, index) => {
    const button = node('button', { class: 'frame', 'data-frame': index, 'aria-pressed': 'false' });
    button.append(node('span', {}, `${String(index + 1).padStart(2, '0')} · ${frame.at.toFixed(1)}s`), node('strong', {}, frame.label));
    return button;
  }));
}
function numberLabel(value) { return Number(value.toFixed(1)).toString(); }
function depthLabel(value) { return t`${numberLabel(value)} 码`; }
function buildDistanceGuide() {
  text($('distanceNote'), lesson.routeGuide?.note);
  $('distanceMarks').replaceChildren(...getRouteMeasurements(lesson).map((mark, index) => {
    const card = node('div', {class: 'distance-mark'});
    const button = node('button', {class: 'distance-jump', 'data-distance-jump': mark.id});
    button.append(node('strong', {}, t`${index + 1} · 深度 ${numberLabel(mark.depthYards)} 码（约 ${numberLabel(mark.depthYards * .9144)} 米）`), node('span', {}, mark.label));
    button.addEventListener('click', () => seek(mark.at));
    const basis = node('span', {class: 'distance-basis'}, mark.basis === 'source-example' ? '官方示例' : '本次演示设置');
    card.append(button, basis, node('p', {}, mark.note));
    const reference = lesson.source?.references?.[mark.sourceReference];
    if (reference) card.append(node('a', {href: reference.url, target: '_blank', rel: 'noopener noreferrer'}, '查看距离出处 ↗'));
    return card;
  }));
}

function buildField() {
  const { width: w, height: h, lineOfScrimmageY } = lesson.field;
  const isRoute = lesson.kind === 'route';
  const scaled = isRoute && lesson.field.unit === 'yard';
  const unit = isRoute ? Math.min(w / 48, h / 80) : Math.min(w / 100, h / 55);
  const field = $('field');
  const viewport = { x: -3 * unit, y: -3 * unit, width: w + (scaled ? 14 : 6) * unit, height: h + 6 * unit };
  field.classList.toggle('full-route-field', isRoute);
  $('routeMotionHint').hidden = !isRoute;
  field.setAttribute('viewBox', `${viewport.x} ${viewport.y} ${viewport.width} ${viewport.height}`);
  field.style.overflow = 'hidden';
  field.replaceChildren();
  fieldNodes = { players: new Map(), routes: [], zones: new Map(), assignments: new Map(), facingGuides: new Map(), unit, viewport };
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
    for (let y = endZone, count = 0; y <= h - endZone && count <= 200; y += majorInterval, count++) field.append(svg('path', {d: `M0 ${y}H${w}`, stroke: '#ffffff20', 'stroke-width': .15 * unit}));
    for (let y = endZone, count = 0; y <= h - endZone && count <= 200; y += yardInterval, count++) field.append(svg('path', {d: `M${w * .02} ${y}h${unit} M${w * .96} ${y}h${unit}`, stroke: '#ffffff30', 'stroke-width': .13 * unit}));
    if (lineOfScrimmageY !== undefined) {
      const direction = lesson.field.attackDirection === 'up' ? -1 : 1;
      const limit = direction < 0 ? lineOfScrimmageY - endZone : h - endZone - lineOfScrimmageY;
      for (let distance = 0, count = 0; distance <= limit && count <= 200; distance += majorInterval, count++) {
        const y = lineOfScrimmageY + direction * distance;
        field.append(svg('path', {d: `M${w} ${y}h${unit}`, stroke: '#e8cf90', 'stroke-width': .2 * unit}));
        field.append(svg('text', {x: w + 1.8 * unit, y, fill: '#e8cf90', 'font-size': 2.2 * unit, 'dominant-baseline': 'middle', 'data-yard-tick': distance}, depthLabel(distance)));
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
      field.append(svg('text', {x: w / 2, y: y + depth / 2, 'dominant-baseline': 'middle', 'text-anchor': 'middle', fill: '#d2dfcd', 'font-size': 2 * unit}, label));
    }
    field.append(svg('path', {d: `M${w / 2} ${depth}V${h - depth}`, stroke: '#ffffff40', 'stroke-width': .15 * unit, 'stroke-dasharray': `${unit} ${unit}`}));
    field.append(svg('text', {x: w / 2, y: depth + 4 * unit, fill: '#d2dfcd', 'font-size': 1.7 * unit, 'text-anchor': 'middle'}, '场地中间'));
    field.append(svg('path', {d: `M0 ${h / 2}H${w}`, stroke: '#ffffff45', 'stroke-width': .18 * unit}));
    field.append(svg('text', {x: w - unit, y: h / 2 - unit, fill: '#b9d5d1', 'font-size': 1.5 * unit, 'text-anchor': 'end'}, '中线'));
    for (const [x, angle] of [[1.8 * unit, -90], [w - 1.8 * unit, 90]]) {
      field.append(svg('text', {transform: `translate(${x} ${h * .64}) rotate(${angle})`, 'text-anchor': 'middle', fill: '#b9d5d1', 'font-size': 1.6 * unit}, '边线'));
    }
  }
  if (lineOfScrimmageY !== undefined) {
    field.append(svg('path', { d: `M0 ${lineOfScrimmageY}H${w}`, stroke: '#9bd0db80', 'stroke-width': .25 * unit }));
    field.append(svg('text', { x: isRoute ? w - 2 * unit : 2 * unit, y: lineOfScrimmageY - 1.1 * unit, fill: '#b9d5d1', 'font-size': (isRoute ? 1.6 : 1.35) * unit, 'text-anchor': isRoute ? 'end' : 'start' }, '开球线'));
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
    const shape = {fill: 'none', stroke: playerColor(player), 'stroke-width': .43 * unit, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'pointer-events': 'none'};
    const path = svg('path', { ...shape, class: 'route', 'data-player-route': player.id, d: pathToSvg(route.from, route.steps), 'marker-end': isRoute ? 'none' : `url(#arrow-${player.id})` });
    const activeNode = isRoute ? svg('path', {...shape, 'data-active-route': player.id, 'marker-end': `url(#arrow-${player.id})`, visibility: 'hidden'}) : undefined;
    field.append(path); fieldNodes.routes.push({ node: path, activeNode, ...route });
  }
  buildBallPaths(field, unit);
  const measurements = getRouteMeasurements(lesson);
  const distanceLabels = [];
  for (const [index, mark] of measurements.entries()) {
    const [x, y] = mark.position;
    const group = svg('g', {class: 'distance-marker', 'data-distance-mark': mark.id, 'data-depth-yards': mark.depthYards, 'data-marker-x': x, 'data-marker-y': y, role: 'button', tabindex: 0, 'aria-label': `${depthLabel(mark.depthYards)} · ${mark.label}`});
    group.append(svg('circle', {class: 'distance-marker-focus', cx: x, cy: y, r: 3.3 * unit, fill: 'none', stroke: '#ffe8a7', 'stroke-width': .25 * unit}));
    group.append(svg('circle', {cx: x, cy: y, r: .8 * unit, fill: '#e8cf90', stroke: '#173b30', 'stroke-width': .2 * unit}));
    group.addEventListener('click', () => seek(mark.at));
    group.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); seek(mark.at); } });
    const label = `${index + 1} · ${depthLabel(mark.depthYards)}`;
    const labelNode = svg('text', {x: x + 1.7 * unit, y: y - 1.8 * unit, fill: '#ffe8a7', stroke: '#214f40', 'stroke-width': .5 * unit, 'paint-order': 'stroke', 'font-size': 2.2 * unit, 'font-weight': 700}, label);
    group.append(labelNode);
    field.append(group);
    // Cuts at the same depth still need separate readable labels (for example Chair).
    let bounds = labelNode.getBBox();
    for (let attempt = 0; attempt < measurements.length; attempt++) {
      const overlap = distanceLabels.some(box => bounds.x < box.x + box.width + unit && bounds.x + bounds.width + unit > box.x && bounds.y < box.y + box.height + unit && bounds.y + bounds.height + unit > box.y);
      if (!overlap) break;
      labelNode.setAttribute('y', Number(labelNode.getAttribute('y')) - 3.5 * unit);
      bounds = labelNode.getBBox();
    }
    if (Number(labelNode.getAttribute('y')) !== y - 1.8 * unit) {
      group.insertBefore(svg('path', {d: `M${x} ${y}L${labelNode.getAttribute('x')} ${Number(labelNode.getAttribute('y')) + .6 * unit}`, stroke: '#e8cf90', 'stroke-width': .16 * unit, 'stroke-dasharray': `${.4 * unit} ${.4 * unit}`, 'pointer-events': 'none', fill: 'none'}), group.firstChild);
    }
    distanceLabels.push(bounds);
  }
  const firstMark = measurements[0];
  if (firstMark) {
    const runner = lesson.players.find(player => player.id === lesson.routeGuide.player);
    // Mark the initial straight stem separately from the route's total travel.
    if (firstMark.step === 0 && runner.at[0] === firstMark.position[0] && runner.at[1] === lineOfScrimmageY) {
      const x = Math.max(unit, runner.at[0] - 4 * unit), top = firstMark.position[1], bottom = lineOfScrimmageY;
      field.append(svg('path', {d: `M${x + unit} ${top}H${x}V${bottom}h${unit}`, stroke: '#e8cf90', 'stroke-width': .2 * unit, fill: 'none', 'data-stem-bracket': ''}));
      field.append(svg('text', {x: x - unit, y: (top + bottom) / 2, fill: '#ffe8a7', 'font-size': 2.2 * unit, 'text-anchor': 'end', 'dominant-baseline': 'middle'}, depthLabel(firstMark.depthYards)));
    }
  }
  // Current-step arrows sit above distance dots so a turn marker cannot hide the arrowhead.
  for (const route of fieldNodes.routes) if (route.activeNode) field.append(route.activeNode);
  const facingPlayers = new Set(getRoutes(lesson).filter(route => route.steps.some(step => step.facePlayer)).map(route => route.playerId));
  $('facingHint').hidden = facingPlayers.size === 0;
  for (const id of facingPlayers) {
    const guide = svg('line', {'data-facing-guide': id, stroke: '#ffe8a7', 'stroke-width': .2 * unit, 'stroke-dasharray': `${.45 * unit} ${.6 * unit}`, 'pointer-events': 'none', visibility: 'hidden'});
    field.append(guide); fieldNodes.facingGuides.set(id, guide);
  }
  for (const player of lesson.players) {
    const group = svg('g', { class: 'player', 'data-player': player.id, tabindex: 0, role: 'button', 'aria-label': t`${player.name || player.id}：${player.label.en || ''} ${player.label.zh}，点击保留` });
    group.append(svg('circle', { class: 'focus-ring', r: 2.85 * unit, fill: 'none', stroke: '#fff8d6', 'stroke-width': .25 * unit, opacity: 0 }));
    const common = { fill: playerColor(player), stroke: '#153b2f', 'stroke-width': .22 * unit };
    if (player.team === 'defense') group.append(svg('path', { ...common, d: `M0 ${-2.2 * unit}L${2.2 * unit} ${1.85 * unit}L${-2.2 * unit} ${1.85 * unit}Z` }));
    else if (player.id === 'C') group.append(svg('rect', { ...common, x: -1.85 * unit, y: -1.85 * unit, width: 3.7 * unit, height: 3.7 * unit, rx: .45 * unit }));
    else group.append(svg('circle', { ...common, r: 1.95 * unit }));
    if (facingPlayers.has(player.id)) group.append(svg('path', {'data-facing': '', d: `M${-1.1 * unit} ${-2.65 * unit}L0 ${-4.25 * unit}L${1.1 * unit} ${-2.65 * unit}Z`, fill: '#ffe8a7', stroke: '#153b2f', 'stroke-width': .2 * unit, visibility: 'hidden'}));
    group.append(svg('text', { x: 0, y: (player.team === 'defense' ? .95 : .75) * unit, 'text-anchor': 'middle', 'font-size': (player.id.length > 2 ? 1.25 : player.id.length > 1 ? 1.7 : 2.2) * unit, 'font-weight': 750, fill: '#153b2f' }, player.id));
    if (isRoute && player.id === 'QB') group.append(svg('text', {x: 0, y: 4.5 * unit, 'text-anchor': 'middle', fill: '#ffd3a2', 'font-size': 1.6 * unit}, '传球参照'));
    group.append(svg('circle', { r: 2.7 * unit, fill: 'transparent' }));
    field.append(group); fieldNodes.players.set(player.id, group);
  }
  buildBallActions(field, unit);
  if (ballScenario) {
    const ball = svg('g', {'data-ball': '', role: 'img', 'pointer-events': 'none'});
    // The same small offset is used for held balls and both flight endpoints.
    // It keeps the football visible beside a player's letter without teleporting.
    const glyph = svg('g', {transform: `translate(${2.65 * unit} ${-1.7 * unit}) rotate(-30)`});
    glyph.append(svg('ellipse', {rx: 1.65 * unit, ry: .96 * unit, fill: '#934725', stroke: '#fff5ce', 'stroke-width': .4 * unit}));
    glyph.append(svg('path', {d: `M${-.85 * unit} 0H${.85 * unit} M${-.45 * unit} ${-.35 * unit}V${.35 * unit} M0 ${-.35 * unit}V${.35 * unit} M${.45 * unit} ${-.35 * unit}V${.35 * unit}`, stroke: '#fff5ce', 'stroke-width': .2 * unit, fill: 'none'}));
    ball.append(glyph); field.append(ball); fieldNodes.ball = ball;
    const carrier = svg('circle', {'data-ball-carrier': '', r: 2.45 * unit, stroke: '#fff5ce', 'stroke-width': .45 * unit, fill: 'none', 'pointer-events': 'none'});
    field.insertBefore(carrier, ball); fieldNodes.carrier = carrier;
  }
  const tooltip = svg('g', { id: 'fieldTooltip', 'pointer-events': 'none', 'aria-hidden': 'true', style: 'display:none' });
  tooltip.append(svg('rect', { width: 26 * unit, height: 7.5 * unit, rx: 1 * unit, fill: '#fffefa', stroke: '#d1ddc5', 'stroke-width': .15 * unit }));
  const first = svg('text', { x: 1.2 * unit, y: 3 * unit, fill: '#183c32', 'font-size': 2 * unit, 'font-weight': 700 });
  const second = svg('text', { x: 1.2 * unit, y: 5.8 * unit, fill: '#68775e', 'font-size': 1.35 * unit });
  tooltip.append(first, second); field.append(tooltip);
  Object.assign(fieldNodes, { tooltip, tooltipFirst: first, tooltipSecond: second });
}

function buildBallPaths(field, unit) {
  $('ballReadout').hidden = $('ballLegend').hidden = !ballScenario;
  if (!ballScenario) return;
  const ball = getBallState(lesson, 0, state.choices, ballScenario);
  fieldNodes.ballPaths = ball.flights.map(flight => {
    const group = svg('g', {class: 'ball-flight', 'data-ball-flight': flight.id});
    const points = [flight.start, flight.end].map(([x, y]) => [x + 2.65 * unit, y - 1.7 * unit]);
    group.append(svg('path', {d: `M${points[0].join(' ')}L${points[1].join(' ')}`, stroke: '#ffba75', 'stroke-width': .55 * unit, 'stroke-dasharray': `${1.5 * unit} ${.95 * unit}`, fill: 'none', 'marker-end': 'url(#ball-arrow)'}));
    const middle = points[0].map((value, axis) => (value + points[1][axis]) / 2);
    group.append(svg('text', {class: 'ball-flight-label', x: middle[0] + unit, y: middle[1] - unit, fill: '#ffd0a0', 'font-size': 1.65 * unit, 'font-weight': 700}, flight.type === 'snap' ? '开球' : '传球'));
    field.append(group);
    return {...flight, node: group};
  });
  fieldNodes.ballCarries = ball.carries.map(carry => {
    const path = svg('path', {class: 'ball-carry', 'data-ball-carry': carry.owner, stroke: '#fff5ce', 'stroke-width': .8 * unit, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: .85, fill: 'none'});
    const player = lesson.players.find(item => item.id === carry.owner);
    const samples = Math.min(160, Math.max(2, Math.ceil((carry.endAt - carry.at) * 12)));
    const points = Array.from({length: samples + 1}, (_, index) => {
      const time = carry.at + (carry.endAt - carry.at) * index / samples;
      return {time, point: positionAt(player, time, state.choices)};
    });
    field.append(path);
    return {...carry, player, points, node: path};
  });
}

function buildBallActions(field, unit) {
  if (!ballScenario) return;
  const types = {'handoff': '交递', 'fake-handoff': '假交', 'pump-fake': '假传'};
  const actions = ballScenario.events.filter(event => types[event.type]).map(event => {
    const position = id => positionAt(lesson.players.find(player => player.id === id), event.at, state.choices);
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
  const obstacles = actions.map(({point: [x, y]}) => ({x: x - 4 * unit, y: y - 4 * unit, width: 8 * unit, height: 8 * unit}));
  for (const player of lesson.players) obstacles.push({x: player.at[0] - 3 * unit, y: player.at[1] - 3 * unit, width: 6 * unit, height: 6 * unit});
  fieldNodes.ballActions = actions.map(({event, point: [x, y], endAt}, index) => {
    const participants = event.type === 'handoff' ? `${event.from} → ${event.to}` : event.to ? `${event.from} / ${event.to}` : event.from;
    const label = `${index + 1} · ${t(types[event.type])} ${participants}`;
    const group = svg('g', {class: 'ball-action', 'data-ball-action': event.id, 'data-action-type': event.type,
      'data-phase': 'preview', 'data-event-at': event.at, 'data-event-position': JSON.stringify([x, y]), role: 'button', tabindex: 0});
    const leader = svg('path', {class: 'ball-action-leader', fill: 'none', 'stroke-width': .2 * unit, 'pointer-events': 'none'});
    // A true exchange gets an open circle at the meeting point. Fake actions have
    // only a location dot and a FAKE label: neither creates a ball-flight arrow.
    const pin = svg('circle', {class: 'ball-action-pin', cx: x, cy: y, r: (event.type === 'handoff' ? 3.2 : .55) * unit,
      fill: event.type === 'handoff' ? 'none' : '#ffce92', stroke: '#ffce92', 'stroke-width': .35 * unit, 'pointer-events': 'none'});
    const card = svg('rect', {class: 'ball-action-card', rx: 1.1 * unit, 'stroke-width': .22 * unit});
    const title = svg('text', {class: 'ball-action-title', 'font-size': 2.25 * unit, 'font-weight': 700}, label);
    const status = svg('text', {class: 'ball-action-status', 'font-size': 1.7 * unit});
    group.append(leader, pin, card, title, status); field.append(group);
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
    const candidates = [];
    for (const offset of [0, -9, 9, -18, 18, -27, 27]) {
      candidates.push([x - box.width - 5.2 * unit, y - box.height / 2 + offset * unit]);
      candidates.push([x + 5.2 * unit, y - box.height / 2 + offset * unit]);
    }
    candidates.push([x - box.width / 2, y - box.height - 5.2 * unit], [x - box.width / 2, y + 5.2 * unit]);
    const scored = candidates.map(([cx, cy]) => {
      const candidate = {...box, x: Math.max(unit, Math.min(width - box.width - unit, cx)), y: Math.max(unit, Math.min(height - box.height - unit, cy))};
      const padded = {...candidate, x: candidate.x - unit, y: candidate.y - unit, width: box.width + 2 * unit, height: box.height + 2 * unit};
      const distance = Math.hypot(candidate.x + box.width / 2 - x, candidate.y + box.height / 2 - y) / unit;
      const score = distance + placed.reduce((sum, other) => sum + overlap(padded, other) / unit ** 2 * 100, 0)
        + obstacles.reduce((sum, other) => sum + overlap(padded, other) / unit ** 2 * 5, 0);
      return {candidate, score};
    }).sort((a, b) => a.score - b.score);
    const position = scored[0].candidate;
    placed.push(position);
    for (const [key, value] of Object.entries(position)) card.setAttribute(key, value);
    title.setAttribute('x', position.x + 1.4 * unit); title.setAttribute('y', position.y + 3.05 * unit);
    status.setAttribute('x', position.x + 1.4 * unit); status.setAttribute('y', position.y + 5.95 * unit);
    const end = [Math.max(position.x, Math.min(position.x + box.width, x)), Math.max(position.y, Math.min(position.y + box.height, y))];
    const length = Math.hypot(end[0] - x, end[1] - y);
    const ratio = length > 0 ? Math.min(3.2 * unit / length, 1) : 0;
    leader.setAttribute('d', `M${x + (end[0] - x) * ratio} ${y + (end[1] - y) * ratio}L${end.join(' ')}`);
    group.addEventListener('click', () => seek(event.at));
    group.addEventListener('keydown', input => {
      if (input.key === 'Enter' || input.key === ' ') { input.preventDefault(); seek(event.at); }
    });
    return {event, endAt, label, node: group, status};
  });
}

function renderBall(time) {
  if (!ballScenario) return;
  const ball = getBallState(lesson, time, state.choices, ballScenario);
  const event = ball.event;
  const fake = event && ['fake-handoff', 'pump-fake'].includes(event.type) && time < (event.endAt ?? event.at + .6);
  const status = ball.state === 'flight'
    ? (event.type === 'snap' ? t`开球：${event.from} → ${event.to}` : t`传球：${event.from} → ${event.to}`)
    : fake ? t`假动作 · 球仍在 ${ball.owner} 手里` : t`球在 ${ball.owner} 手里`;
  text($('ballStatus'), status);
  const eventCue = event?.endAt !== undefined && time >= event.endAt ? event.endCue || event.cue : event?.cue;
  text($('ballEvent'), eventCue || ballScenario.title);
  fieldNodes.ball.setAttribute('transform', `translate(${ball.position.join(' ')})`);
  fieldNodes.ball.setAttribute('data-ball-state', ball.state);
  fieldNodes.ball.setAttribute('data-ball-owner', ball.owner || '');
  fieldNodes.ball.setAttribute('data-ball-position', JSON.stringify(ball.position));
  fieldNodes.ball.setAttribute('aria-label', status);
  fieldNodes.carrier.setAttribute('visibility', ball.owner ? 'visible' : 'hidden');
  fieldNodes.carrier.setAttribute('data-owner', ball.owner || '');
  fieldNodes.carrier.setAttribute('transform', `translate(${ball.position.join(' ')})`);
  for (const path of fieldNodes.ballPaths) {
    path.node.setAttribute('opacity', time < path.at ? .45 : time < path.endAt ? 1 : .3);
    path.node.setAttribute('data-phase', time < path.at ? 'preview' : time < path.endAt ? 'flight' : 'complete');
  }
  for (const carry of fieldNodes.ballCarries) {
    const end = Math.min(time, carry.endAt);
    const points = carry.points.filter(item => item.time < end).map(item => item.point);
    if (time > carry.at) points.push(positionAt(carry.player, end, state.choices));
    carry.node.setAttribute('d', points.length > 1 ? points.map((point, index) => `${index ? 'L' : 'M'}${point.join(' ')}`).join(' ') : '');
  }
  for (const action of fieldNodes.ballActions) {
    const phase = time < action.event.at ? 'preview' : time < action.endAt ? 'active' : 'complete';
    action.node.dataset.phase = phase;
    const status = phase === 'preview' ? '待演示' : phase === 'active' ? '此刻' : '已发生';
    text(action.status, `${action.event.at.toFixed(1)} s · ${t(status)}`);
    action.node.setAttribute('aria-label', t`${action.label}，${status}，点击暂停到 ${action.event.at} 秒`);
  }
}
function render() {
  if (!lesson || rebuildingLesson) return;
  const scene = getScene(lesson, state.time, state.choices);
  const currentBall = ballScenario ? getBallState(lesson, scene.time, state.choices, ballScenario) : undefined;
  const inspected = inspectId();
  for (const player of scene.players) {
    const group = fieldNodes.players.get(player.id);
    group.setAttribute('transform', `translate(${player.position.join(' ')})`);
    group.setAttribute('opacity', inspected === null || player.id === inspected || player.id === currentBall?.owner || (lesson.kind === 'route' && player.id === 'QB') ? 1 : .53);
    group.setAttribute('aria-pressed', String(player.id === state.role));
    group.querySelector('.focus-ring').setAttribute('opacity', player.id === inspected ? 1 : 0);
    const facing = group.querySelector('[data-facing]');
    const guide = fieldNodes.facingGuides.get(player.id);
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
  for (const route of fieldNodes.routes) {
    const option = state.choices[route.playerId];
    const otherOption = route.optionId && option && route.optionId !== option;
    route.node.style.display = otherOption ? 'none' : '';
    route.node.setAttribute('opacity', route.activeNode ? (inspected === null || route.playerId === inspected ? .28 : .12) : inspected === null ? .66 : route.playerId === inspected ? 1 : .2);
    route.node.setAttribute('stroke-dasharray', route.optionId && !option ? `${fieldNodes.unit} ${fieldNodes.unit * .7}` : 'none');
    route.node.setAttribute('stroke-width', (route.playerId === inspected ? .58 : .4) * fieldNodes.unit);
    if (route.activeNode) {
      const player = scene.players.find(item => item.id === route.playerId);
      const active = !otherOption && (!route.optionId || option === route.optionId) ? getActiveRoute(player, scene.time, state.choices) : undefined;
      route.activeNode.setAttribute('visibility', active ? 'visible' : 'hidden');
      route.activeNode.setAttribute('d', active ? pathToSvg(active.from, active.steps) : '');
      route.activeNode.setAttribute('opacity', inspected === null || route.playerId === inspected ? 1 : .35);
      route.activeNode.setAttribute('stroke-width', .58 * fieldNodes.unit);
    }
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
  const scenarioMotion = ballScenario?.motions?.find(item => item.player === player?.id)?.motion;
  text($('focusStatus'), state.role === null ? '正在看全队' : t`关注 ${state.role} · 队友仍可见`);
  text($('routePerson'), player?.id || '?'); $('routePerson').style.background = player ? playerColor(player) : '#e6eadf';
  text($('routeMode'), player ? t`${player.id} 的${t(lesson.kind === 'defense' ? '分工' : '跑法')} · ${t(hovered ? '悬停查看' : focused ? '键盘查看' : '已保留')}` : '认识跑法');
  text($('routeEnglish'), player ? player.label.en || player.label.zh : '移到球员上试试');
  text($('routeChinese'), player?.label.en && player.label.en !== player.label.zh ? player.label.zh : '');
  text($('routeDescription'), scenarioMotion?.note || player?.label.description || '名称、路线和动作一起看。点击一个字母，边播放边观察他和队友怎样配合。');
  $('playerCoaching').hidden = !player?.coaching;
  text($('routeCooperation'), player?.coaching?.cooperation);
  text($('routeTiming'), player?.coaching?.timing);
  const selectedSituation = player?.motion.type === 'choice'
    ? player.motion.options.find(option => option.id === state.choices[player.id]) : undefined;
  const situation = scenarioMotion?.note ? '本次球路中的动作 · 教学编排' : (player?.motion.type === 'choice'
    ? selectedSituation ? selectedSituation.note || t`本次演示：${selectedSituation.title}` : player.motion.prompt
    : '');
  $('routeSituation').hidden = !situation;
  text($('routeSituation'), situation);
  const duties = player ? scene.assignments.filter(a => a.player === player.id).map(a => {
    if (a.type === 'coverage') return t`负责区域：${lesson.zones.find(z => z.id === a.zone).label}`;
    if (a.type === 'matchup') return t`对位球员：${lesson.players.find(p => p.id === a.target).name || a.target}`;
    return '职责：按图示方向冲传';
  }) : [];
  $('routeDuties').hidden = !duties.length;
  text($('routeDuties'), duties.join(getLanguage() === 'en' ? '; ' : '；'));
  text($('routeBasis'), scenarioMotion?.note ? ballScenario.note : player ? `${t(bases[player.label.basis])}${player.label.note ? ` · ${player.label.note}` : ''}` : '');
  fieldNodes.tooltip.style.display = player && (lesson.kind !== 'route' || hovered || focused) ? '' : 'none';
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
    text(fieldNodes.tooltipSecond, (player.label.en ? player.label.zh : t(bases[player.label.basis])).slice(0, 16));
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
    text(element, selected ? selected.note || t`本次演示：${selected.title}` : '请先选择一种情形。切换选项后会回到站位并暂停。');
  });
  renderBall(scene.time);
}

$('language').value = getLanguage();
updateStaticLanguage();
$('language').addEventListener('change', () => {
  const id = lesson?.id;
  setLanguage($('language').value);
  try { localStorage.setItem('flagventures.language', getLanguage()); } catch {}
  updateStaticLanguage();
  pack = localizePack(canonicalPack, getLanguage(), t);
  text($('libraryStatus'), libraryStatus);
  text($('libraryCount'), t`${pack.lessons.length} 个教学条目 · 本地可用`);
  buildCatalog(); selectLesson(id, true);
});
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
$('ballEnabled').addEventListener('change', event => {
  state.showBall = event.target.checked;
  state.time = 0; state.playing = false; state.choices = {};
  selectLesson(lesson.id, true);
});
$('ballOptions').addEventListener('click', event => {
  const button = event.target.closest('[data-ball-scenario]');
  if (!button || button.disabled) return;
  state.scenarioId = button.dataset.ballScenario;
  state.time = 0; state.playing = false;
  selectLesson(lesson.id, true);
});
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
  text($('sourceTitle'), t`${lesson.title.zh} · 原页对照`);
  $('sourceImage').src = `data:${asset.mime};base64,${asset.base64}`;
  text($('sourceCaption'), `${lesson.source.title}${lesson.source.page ? t` · 第 ${lesson.source.page} 页` : ''}${getLanguage() === 'en' ? '. ' : '。'}${lesson.source.note || ''}`);
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
    if (files.length > 200) throw new Error(t('一次最多导入 200 个文件。'));
    for (const file of files) {
      const limit = /\.json$/i.test(file.name) ? 50 * 1024 * 1024 : 1024 * 1024;
      if (file.size > limit) throw new Error(t`${file.name}：文件过大，YAML 上限 1 MB，战术包上限 50 MB。`);
    }
    const data = await Promise.all(files.map(async file => ({ name: file.name, text: await file.text() })));
    if (request !== importRequest) return;
    const result = prepareImport(canonicalPack, data);
    pendingImport = result;
    const lines = result.mode === 'pack'
      ? [t`将替换当前的 ${pack.lessons.length} 个条目，载入战术包中的 ${result.pack.lessons.length} 个条目和 ${result.pack.sections.length} 个章节。`, '当前内容需要保留时，请先保存完整战术包。']
      : [t`检查通过：新增 ${result.added.length} 条，整条更新 ${result.updated.length} 条。`, ...result.added.map(id => t`新增 · ${localizePack(result.pack, getLanguage(), t).lessons.find(l => l.id === id).title.zh} (${id})`), ...result.updated.map(id => t`更新 · ${localizePack(result.pack, getLanguage(), t).lessons.find(l => l.id === id).title.zh} (${id})`), ...(result.updated.length ? ['更新会替换整条内容，省略的旧字段不会保留；目录位置不变。'] : [])];
    if (result.warnings.length) lines.push('', '提示：', ...result.warnings);
    text($('importReport'), lines.map(line => t(line)).join('\n')); $('importActions').hidden = false;
  } catch (error) {
    if (request !== importRequest) return;
    $('importReport').className = 'error';
    text($('importReport'), t`没有改动当前手册。\n${error.message}`);
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
$('exportPack').addEventListener('click', () => { download('Flagventures.flagbook.json', JSON.stringify(canonicalPack, null, 2), 'application/json;charset=utf-8'); notify('已开始保存完整战术包。'); });
$('exportLesson').addEventListener('click', () => { download(`${lesson.id}.yaml`, dump(canonicalPack.lessons.find(item => item.id === lesson.id), { lineWidth: 100, noRefs: true }), 'application/yaml;charset=utf-8'); notify('已开始下载当前条目。'); });
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
