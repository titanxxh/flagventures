// App state, panels and event wiring. The field drawing lives in field.js, the catalog in
// catalog.js, and the address/keyboard rules in navigation.js.
import { t, getLanguage, setLanguage, captureStaticTranslations } from './i18n.js';
import { localizePack } from './localization.js';
import { getRouteMeasurements } from './route-measurements.js';
import { dump } from 'js-yaml';
import { getScene } from './scene.js';
import { resolveBallScenario, getBallState } from './ball.js';
import { prepareImport, validatePack } from './validation.js';
import { getProvenance, resolveRelatedLesson } from './provenance.js';
import { $, text, node } from './dom.js';
import { buildField, renderField, renderBallLayer, colorFor, basisLabels, depthLabel, numberLabel } from './field.js';
import { renderCatalog, revealCatalogEntry, kindLabels } from './catalog.js';
import { lessonFromHash, lessonHash, adjacentKeyframe, shortcutFor } from './navigation.js';

const builtIn = JSON.parse($('builtInData').textContent);
const template = JSON.parse($('templateData').textContent);
// Phones get larger players and labels; tablets and phones open the catalog as a drawer.
const narrowQuery = matchMedia('(max-width: 650px)');
const drawerQuery = matchMedia('(max-width: 900px)');
const touchQuery = matchMedia('(hover: none)');
// Keep in step with the short-screen block in style.css.
const shortQuery = matchMedia('screen and (min-width: 901px) and (max-height: 860px)');
// The summary often restates the teaching goal shown with the teaching notes; say it once.
// Built-in route summaries prefix the goal with the route name ("HITCH · …").
function repeatsGoal(summary = '', goal = '') {
  const clean = value => value.replace(/^[^·]{1,30} · /u, '').replace(/[\s。.]+$/u, '').trim();
  return Boolean(goal) && clean(summary) === goal.replace(/[\s。.]+$/u, '').trim();
}
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
let state = { time: 0, playing: false, speed: 2, role: null, choices: {}, fullField: false };
let hovered = null;
let focused = null;
let pendingImport = null;
let importRequest = 0;
let toastTimer;
let lastTick;
let tickRequest;
let fieldNodes = {};
let assetMap = new Map();
let catalogNodes = new Map();
let expandedGroups = new Set();
let expandedSections = new Set();

function notify(message) {
  text($('toast'), message); $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500);
}
function playerColor(player) { return colorFor(lesson, player); }
function inspectId() { return hovered || focused || state.role; }
function pause() { state.playing = false; lastTick = undefined; render(); }
function seek(time) {
  if (time > 0 && !getScene(lesson, 0, state.choices).ready) { notify('先选好要演示的选项，再一起看跑位。'); return; }
  state.time = Math.max(0, Math.min(lesson.timeline.duration, time)); pause();
}
function togglePlay() {
  if (!lesson || $('play').disabled || !getScene(lesson, 0, state.choices).ready) return;
  if (state.time >= lesson.timeline.duration) state.time = 0;
  state.playing = !state.playing; lastTick = undefined; render();
  if (state.playing) startTicking();
}
function startTicking() { if (tickRequest === undefined) tickRequest = requestAnimationFrame(tick); }
function setSpeed(value) {
  state.speed = value; lastTick = undefined;
  document.querySelectorAll('[data-speed]').forEach(item => item.setAttribute('aria-pressed', String(Number(item.dataset.speed) === value)));
}
function stepKeyframe(direction) {
  const frame = lesson && adjacentKeyframe(lesson.keyframes, state.time, direction);
  if (frame) seek(frame.at);
}
// The address keeps the current lesson so a refresh or a shared link returns to it.
// A parent's own navigation adds a history entry so the browser Back button returns to the
// previous lesson; everything else (first load, imports, language) replaces the current one.
function syncHash(mode = 'replace') {
  const target = lesson ? lessonHash(lesson.id) : '';
  if (location.hash === target) return;
  const url = target || `${location.pathname}${location.search}`;
  try { history[mode === 'push' ? 'pushState' : 'replaceState'](null, '', url); }
  catch { if (target) location.replace(target); }
}
function revealEntry(id) { revealCatalogEntry($('catalog'), catalogNodes.get(id)); }
function setCatalogOpen(open, moveFocus = true) {
  if (document.body.classList.contains('catalog-open') === open) return;
  document.body.classList.toggle('catalog-open', open);
  $('catalogBackdrop').hidden = !open;
  $('catalogToggle').setAttribute('aria-expanded', String(open));
  if (open) {
    revealEntry(lesson?.id);
    if (moveFocus) (catalogNodes.get(lesson?.id) || $('search')).focus({preventScroll: true});
  } else if (moveFocus && $('library').contains(document.activeElement)) $('catalogToggle').focus({preventScroll: true});
}
// On wide screens, size the field so its caption and controls fit in the first screen.
// Narrow screens scroll to the board instead and use the CSS limits.
function fitField() {
  const board = document.querySelector('.board');
  const fullscreen = board.classList.contains('board-fullscreen');
  if (drawerQuery.matches || !lesson || fullscreen) board.style.removeProperty('--field-max');
  else {
    const fieldTop = $('field').getBoundingClientRect().top;
    const below = document.querySelector('.cue').offsetHeight + document.querySelector('.controls').offsetHeight + 16;
    // Field, caption and controls share the first screen so play is always in reach; the
    // short-screen styles trim the heading to leave the field room. Only the opt-in full-field
    // view of a route is too tall to squeeze in, so it keeps a usable height and scrolls.
    const box = $('field').viewBox.baseVal;
    const floor = box && box.width / box.height < .8 ? innerHeight * .62 : 140;
    // When not even that much fits under the heading (a big phone held sideways, a very short
    // window), squeezing helps nobody: the board fills the window once scrolled to, and the
    // floating play button keeps play in reach.
    const firstScreen = innerHeight - fieldTop - scrollY - below;
    const space = firstScreen >= floor ? firstScreen : innerHeight - (fieldTop - board.getBoundingClientRect().top) - below;
    const value = `${Math.round(Math.max(floor, Math.min(680, space)))}px`;
    if (board.style.getPropertyValue('--field-max') !== value) board.style.setProperty('--field-max', value);
  }
  // Measured after sizing: a phone held sideways or a very short window cannot show the whole
  // board at once, and full screen can.
  boardTooTall = Boolean(lesson) && !fullscreen
    && document.querySelector('.controls').getBoundingClientRect().bottom - board.getBoundingClientRect().top > innerHeight + 1;
  hintFullscreen(boardTooTall || (Boolean(lesson) && !fullscreen && !drawerQuery.matches && $('field').getBoundingClientRect().height < 240));
  measureFloatingPlay();
}
// A small field is easier to follow in full screen; the button says so.
function hintFullscreen(small) {
  text($('fullscreen'), small ? '全屏看大图' : '全屏');
}
// Phones, and windows too short for the board, put the play button below the first screen.
// While it is below, a floating copy brings the board into view and plays or pauses. When the
// board is taller than the window (a phone held sideways) it opens full screen instead.
let playBelow = false, boardTooTall = false;
const floatingFullscreen = () => boardTooTall && !state.playing;
// Measured on scroll, after each fit, and whenever the lesson column changes size (a longer
// caption or choice note pushes the controls down without scrolling), rather than through an
// IntersectionObserver, which WebKit did not notify after the viewport changed. The play
// button counts as out of reach once less than 24px of it shows above the window's edge.
function measureFloatingPlay() {
  const rect = $('play').getBoundingClientRect();
  playBelow = rect.height > 0 && rect.top > innerHeight - 24;
  syncFloatingPlay();
}
let floatingRequest;
addEventListener('scroll', () => { cancelAnimationFrame(floatingRequest); floatingRequest = requestAnimationFrame(measureFloatingPlay); }, {passive: true});
new ResizeObserver(measureFloatingPlay).observe(document.querySelector('.stage'));
document.fonts?.ready.then(measureFloatingPlay);
function syncFloatingPlay() {
  const floating = $('floatingPlay');
  floating.hidden = !playBelow || $('play').disabled;
  const label = floatingFullscreen() ? t('▶ 全屏演示') : $('play').textContent;
  if (floating.textContent !== label) floating.textContent = label;
}
let fitRequest;
addEventListener('resize', () => { cancelAnimationFrame(fitRequest); fitRequest = requestAnimationFrame(() => { syncBallNote(); fitField(); }); });
function goToLesson(direction) {
  const id = lesson && order[order.indexOf(lesson.id) + direction];
  if (id) navigateTo(id);
}
function navigateTo(id) { selectLesson(id, false, 'push'); }
// Full screen keeps the field, caption and controls together on short screens (phones held
// sideways, a TV). The CSS class does the layout; the Fullscreen API also hides browser chrome.
function setFullscreen(on) {
  const board = document.querySelector('.board');
  if (board.classList.contains('board-fullscreen') === on) return;
  board.classList.toggle('board-fullscreen', on);
  document.body.classList.toggle('board-fullscreen-open', on);
  $('fullscreen').setAttribute('aria-pressed', String(on));
  if (on) board.requestFullscreen?.()?.catch(() => {});
  else if (document.fullscreenElement) document.exitFullscreen?.()?.catch(() => {});
  fitField();
}
function showDialog(id) { pause(); setCatalogOpen(false, false); $(id).showModal(); }
function download(name, content, mime) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const link = node('a', { href: url, download: name });
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
function setPack(value, status, initialId) {
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
  selectLesson(order.includes(initialId) ? initialId : order[0]);
}
function buildCatalog() {
  catalogNodes = renderCatalog($('catalog'), {pack, canonicalPack, query: $('search').value.trim().toLocaleLowerCase(),
    currentId: lesson?.id, expandedSections, expandedGroups});
}
function selectLesson(id, preserve = false, historyMode = 'replace') {
  // Replacing focused controls fires focusout synchronously. Wait until the new
  // lesson and every control/field node agree before rendering those events.
  rebuildingLesson = true;
  try { rebuildLesson(id, preserve); }
  finally { rebuildingLesson = false; }
  render();
  fitField();
  syncHash(historyMode);
}
// Rebuild only the SVG (zoom or screen-size changes) without touching playback state.
function rebuildField() {
  if (!lesson) return;
  rebuildingLesson = true;
  try { drawField(); }
  finally { rebuildingLesson = false; }
  render();
  fitField();
}
function rebuildLesson(id, preserve = false) {
  sourceLesson = pack.lessons.find(item => item.id === id);
  if (!preserve) state = { time: 0, playing: false, speed: state.speed, role: sourceLesson?.kind === 'route' ? sourceLesson.players.find(player => ['path', 'choice'].includes(player.motion.type))?.id || null : null, choices: {}, showBall: true, scenarioId: sourceLesson?.ball?.defaultScenario, fullField: state.fullField };
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
  $('provenanceBar').replaceChildren();
  $('relatedPlays').replaceChildren();
  $('relatedPlays').hidden = true;
  $('sourceAdaptation').hidden = true;
  $('sourceDetails').open = false;
  $('routeDistances').hidden = !lesson?.routeGuide;
  $('routeOrientation').hidden = lesson?.kind !== 'route';
  $('teamPlanHeading').textContent = t(lesson?.kind === 'route' ? '这条路线怎么跑' : '这套配合想做到什么');
  $('ballControls').hidden = !sourceLesson?.ball;
  $('ballSourceNote').hidden = !sourceLesson?.ball?.note;
  $('ballReadout').hidden = $('ballLegend').hidden = !ballScenario;
  $('lessonMain').dataset.kind = lesson?.kind || '';
  $('lessonMain').dataset.hasBall = String(Boolean(ballScenario));
  $('fieldZoom').hidden = lesson?.kind !== 'route';
  if (!lesson) {
    text($('lessonTitle'), '内容包暂无教学条目');
    document.title = t('Flagventures · 一起看懂跑位');
    text($('summary'), '可以导入 YAML 添加战术，或从“我的战术文件”恢复内置手册。');
    $('lessonMain').dataset.summaryRepeats = 'false';
    for (const id of ['breadcrumb', 'lessonEnglish', 'direction', 'fieldHint', 'timingNote', 'sourceNote',
      'focusStatus', 'routeEnglish', 'routeChinese', 'routeDescription', 'routeBasis', 'routeDuties',
      'frameNumber', 'frameTitle', 'frameCue']) text($(id), '');
    for (const id of ['field', 'roles', 'choices', 'frames', 'printFrames', 'timelineTicks', 'notes', 'sourceReferences']) $(id).replaceChildren();
    for (const id of ['play', 'reset', 'seek', 'previous', 'next', 'headPrevious', 'headNext', 'exportLesson', 'printLesson']) $(id).disabled = true;
    $('source').hidden = $('choices').hidden = $('routeDuties').hidden = true;
    $('teamPlan').hidden = $('playerCoaching').hidden = $('routeSituation').hidden = $('sourceReferences').hidden = true;
    text($('teachingCue'), '先选择一条教学内容。'); text($('teachingQuestion'), '');
    $('sourceImage').removeAttribute('src');
    $('seek').value = 0; $('seek').max = 0;
    text($('routePerson'), '?'); text($('routeMode'), '请先选择教学条目');
    text($('play'), '暂无条目'); text($('playState'), '暂无条目');
    text($('clock'), '0.0 / 0.0 s'); text($('lessonIndex'), '0 / 0'); text($('headIndex'), '0 / 0');
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
  text($('breadcrumb'), [section.title, subgroup?.title, t(kindLabels[lesson.kind])].filter(Boolean).join(' / '));
  if (subgroup) {
    expandedGroups.add(JSON.stringify([section.id, subgroup.id]));
    const details = catalogNodes.get(id)?.closest('.catalog-group');
    if (details) details.open = true;
  }
  text($('lessonTitle'), lesson.title.zh);
  document.title = `${lesson.title.zh} · Flagventures`;
  text($('lessonEnglish'), `${lesson.title.en || ''}${lesson.source?.page ? t` · 来源第 ${lesson.source.page} 页` : ''}`);
  text($('summary'), lesson.summary);
  $('lessonMain').dataset.summaryRepeats = String(repeatsGoal(lesson.summary, lesson.teaching?.goal));
  $('teamPlan').hidden = !lesson.teaching;
  text($('teachingGoal'), lesson.teaching?.goal);
  text($('teamCooperation'), lesson.teaching?.cooperation);
  text($('teachingCue'), lesson.teaching?.cue || '「你站在哪里？」');
  text($('teachingQuestion'), lesson.teaching?.question || '「你跑的时候，队友去哪儿？」');
  text($('direction'), `${lesson.field.attackDirection === 'up' ? '↑' : '↓'} ${t('进攻方向')}${lesson.kind === 'defense' ? t(' · 防守视角') : ''}`);
  text($('fieldHint'), lesson.kind === 'defense' ? '区域与箭头表示分工' : lesson.kind === 'formation' ? '看站位，认识彼此的位置' : lesson.kind === 'route' ? lesson.field.unit === 'yard' ? '全场按码绘制 · 秒数仅为演示时间' : '全场示意 · 距离与时间用于教学' : lesson.field.unit === 'yard' ? '按码绘制的教学区域 · 秒数为演示时间' : touchQuery.matches ? '点一下球员，看他的跑法' : '悬停球员看跑法 · 点击保留');
  text($('timingNote'), lesson.timeline.note);
  text($('sourceNote'), lesson.source ? `${lesson.source.title}${lesson.source.page ? t`，第 ${lesson.source.page} 页` : ''}${getLanguage() === 'en' ? '. ' : '。'}${lesson.source.note || ''}` : '来源待补：没有附带可识别的出处，也未声明自编。');
  $('notes').replaceChildren(...(lesson.notes || []).map(note => node('li', {}, note)));
  buildProvenance();
  const asset = assetMap.get(lesson.source?.referenceAsset);
  $('source').hidden = !asset;
  $('sourceImage').removeAttribute('src');
  $('seek').max = lesson.timeline.duration;
  for (const [entryId, button] of catalogNodes) button.setAttribute('aria-current', String(entryId === id));
  const index = order.indexOf(id);
  text($('lessonIndex'), `${index + 1} / ${order.length}`);
  text($('headIndex'), `${index + 1} / ${order.length}`);
  $('headPrevious').disabled = index === 0; $('headNext').disabled = index === order.length - 1;
  $('printLesson').disabled = false;
  $('previous').disabled = index === 0; $('next').disabled = index === order.length - 1;
  revealEntry(id);
  $('fieldZoom').setAttribute('aria-pressed', String(Boolean(state.fullField)));
  buildRoles(); buildChoices(); buildBallControls(); drawField(); buildFrames(); buildDistanceGuide();
}

function buildProvenance() {
  const data = getProvenance(lesson);
  const bar = $('provenanceBar');
  const label = reference => `${reference.title}${reference.locator ? ` · ${reference.locator}` : ''}`;
  const link = (reference, title) => node('a', {
    href: reference.url, target: '_blank', rel: 'noopener noreferrer',
    title: label(reference), 'data-primary-source': '',
  }, `${title || label(reference)} ↗${reference.availability === 'unavailable' ? ` · ${t('链接已知失效')}` : ''}`);
  if (data.primary.length === 1) bar.append(link(data.primary[0], t('原始出处')));
  else if (data.primary.length > 1) {
    const menu = node('details', {class: 'source-menu'});
    const entries = node('div', {class: 'source-menu-links'});
    data.primary.forEach(reference => entries.append(link(reference)));
    menu.append(node('summary', {}, t`原始出处（${data.primary.length}）`), entries);
    bar.append(menu);
  }
  if (data.authored || data.pending) bar.append(node('span', {class: 'source-status', 'data-source-status': data.authored ? 'authored' : 'pending'}, data.authored ? '自编' : '来源待补'));
  if (data.adaptation) {
    const button = node('button', {class: 'source-chip', 'aria-controls': 'sourceDetails'}, '含教学改编');
    button.addEventListener('click', () => {
      $('sourceDetails').open = true;
      $('sourceDetails').querySelector('summary').focus();
      $('sourceDetails').scrollIntoView({block: 'nearest'});
    });
    bar.append(button);
    $('sourceAdaptation').hidden = false;
    text($('sourceAdaptation'), `${t('教学改编')} · ${data.adaptation}`);
  }
  const kinds = {diagram: '原始图示', explanation: '原作者说明', concept: '配合概念', training: '训练参考', rules: '规则参考'};
  const groups = [['原始资料', data.primary], ['补充参考', data.supporting], ['未分类资料', data.unclassified]];
  $('sourceReferences').replaceChildren();
  $('sourceReferences').hidden = !groups.some(([, references]) => references.length);
  for (const [title, references] of groups) {
    if (!references.length) continue;
    const list = node('ul');
    for (const reference of references) {
      const item = node('li');
      item.append(node('a', {href: reference.url, target: '_blank', rel: 'noopener noreferrer'}, `${label(reference)} ↗`));
      const meta = [reference.publisher, t(kinds[reference.kind] || '')].filter(Boolean).join(' · ');
      if (meta) item.append(node('span', {class: 'reference-meta'}, meta));
      if (reference.scope) item.append(node('span', {}, `${t('资料支持')} · ${reference.scope}`));
      if (reference.note) item.append(node('span', {}, reference.note));
      if (reference.availability === 'unavailable') item.append(node('strong', {class: 'source-status'}, '链接已知失效；本地演示仍可使用。'));
      list.append(item);
    }
    $('sourceReferences').append(node('h3', {}, title), list);
  }
  if (lesson.relatedLessons?.length) {
    $('relatedPlays').hidden = false;
    $('relatedPlays').append(node('h2', {}, '相近配合'));
    for (const reference of lesson.relatedLessons) {
      const target = resolveRelatedLesson(pack, reference);
      const item = node('div', {class: 'related-play'});
      const button = node('button', {class: 'text-button', 'data-related-lesson': reference.id}, target?.title.zh || reference.title);
      button.disabled = !target;
      button.addEventListener('click', () => navigateTo(target.id));
      item.append(button, node('p', {}, reference.note));
      if (!target) item.append(node('small', {}, '对应条目不在当前战术包中。'));
      $('relatedPlays').append(item);
    }
  }
}
function buildRoles() {
  const buttons = [node('button', { class: 'role', 'data-show-all': '', 'aria-pressed': 'true' }, '看全队')];
  for (const player of lesson.players) buttons.push(node('button', { class: 'role', 'data-player': player.id, 'aria-pressed': 'false', style: `--chip-color: ${playerColor(player)}`, 'aria-label': t`${player.name || player.id}：${player.label.en || ''} ${player.label.zh}，点击保留` }, player.id));
  $('roles').replaceChildren(...buttons);
  // Offense and defense together are too many chips to share a row with the direction and
  // full-screen button; give them their own row instead of wrapping into three.
  $('lessonMain').dataset.manyRoles = String(lesson.players.length > 5);
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
  // Sequences often open the same way ("Y 接开球后交 Q · Q 传给 C"); say the shared part once
  // so each button shows only what differs. The button's name keeps the full title.
  const titles = sourceLesson.ball.scenarios.map(scenario => t(scenario.title).split(' · '));
  let shared = 0;
  while (titles.length > 1 && titles.every(parts => parts.length > shared + 1 && parts[shared] === titles[0][shared])) shared++;
  const lead = shared ? [node('span', {class: 'ball-options-lead'}, `${titles[0].slice(0, shared).join(' · ')} ·`)] : [];
  $('ballOptions').replaceChildren(...lead, ...sourceLesson.ball.scenarios.map((scenario, index) =>
    node('button', {'data-ball-scenario': scenario.id, 'aria-pressed': String(Boolean(state.showBall) && state.scenarioId === scenario.id), ...(state.showBall ? {} : {disabled: ''}),
      ...(shared ? {'aria-label': titles[index].join(' · ')} : {})}, titles[index].slice(shared).join(' · '))));
  text($('ballScenarioNote'), ballScenario?.note || '已切换为只看跑位。打开球路可查看传球和交接。');
  text($('ballSourceNote'), sourceLesson.ball.note);
  syncBallNote();
}
// On short screens the scenario note shows one line so the play button stays in the first
// screen; the button opens the rest when it does not fit.
function syncBallNote() {
  const note = $('ballScenarioNote'), more = $('ballNoteMore');
  const open = shortQuery.matches && $('ballControls').dataset.noteOpen === 'true';
  more.hidden = !shortQuery.matches || (!open && note.scrollWidth <= note.clientWidth + 1);
  more.setAttribute('aria-expanded', String(open));
  text(more, open ? '收起' : '展开说明');
}
function buildFrames() {
  $('frames').replaceChildren(...lesson.keyframes.map((frame, index) => {
    const button = node('button', { class: 'frame', 'data-frame': index, 'aria-pressed': 'false' });
    button.append(node('span', {}, `${String(index + 1).padStart(2, '0')} · ${frame.at.toFixed(1)}s`), node('strong', {}, frame.label));
    return button;
  }));
  // The printed handout lists every keyframe with its explanation, not only the current one.
  $('printFrames').replaceChildren(...lesson.keyframes.map((frame, index) => {
    const item = node('li');
    item.append(node('strong', {}, `${String(index + 1).padStart(2, '0')} · ${frame.label}`), node('p', {}, frame.cue));
    return item;
  }));
  // Keyframe dots sit under the progress bar so playback shows where the teaching stops are.
  const duration = lesson.timeline.duration;
  $('timelineTicks').replaceChildren(...(duration > 0 ? lesson.keyframes : []).map((frame, index) =>
    node('span', {class: 'timeline-tick', 'data-tick': index, style: `--at: ${Math.min(1, frame.at / duration)}`})));
}
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

function drawField() {
  fieldNodes = buildField($('field'), {lesson, choices: state.choices, ballScenario, fullField: state.fullField,
    glyphScale: narrowQuery.matches ? 1.4 : 1, onSeek: seek});
  $('routeMotionHint').hidden = lesson.kind !== 'route';
  $('facingHint').hidden = fieldNodes.facingPlayers.size === 0;
  $('ballReadout').hidden = $('ballLegend').hidden = !ballScenario;
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
  // The caption beside the readout often already says the same thing.
  $('ballEvent').hidden = $('ballEvent').textContent === $('frameCue').textContent;
  renderBallLayer(fieldNodes, {ball, time, choices: state.choices, status});
}
function render() {
  if (!lesson || rebuildingLesson) return;
  const scene = getScene(lesson, state.time, state.choices);
  const currentBall = ballScenario ? getBallState(lesson, scene.time, state.choices, ballScenario) : undefined;
  const inspected = inspectId();
  const player = lesson.players.find(item => item.id === inspected);
  renderField(fieldNodes, {lesson, scene, choices: state.choices, inspected, role: state.role, ballOwner: currentBall?.owner,
    tooltip: {player, visible: lesson.kind !== 'route' || Boolean(hovered || focused)}});
  $('roles').querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(button.hasAttribute('data-show-all') ? state.role === null : button.dataset.player === state.role)));
  const scenarioMotion = ballScenario?.motions?.find(item => item.player === player?.id)?.motion;
  text($('focusStatus'), state.role === null ? '正在看全队' : t`关注 ${state.role} · 队友仍可见`);
  text($('routePerson'), player?.id || '?'); $('routePerson').style.background = player ? playerColor(player) : 'var(--surface)';
  $('routePerson').style.color = player ? '#153b2f' : 'var(--ink)';
  text($('routeMode'), player ? t`${player.id} 的${t(lesson.kind === 'defense' ? '分工' : '跑法')} · ${t(hovered ? '悬停查看' : focused ? '键盘查看' : '已保留')}` : '认识跑法');
  $('routeCard').classList.toggle('is-empty', !player);
  text($('routeEnglish'), player ? player.label.en || player.label.zh : touchQuery.matches ? '点一下球员试试' : '移到球员上试试');
  text($('routeChinese'), player?.label.en && player.label.en !== player.label.zh ? player.label.zh : '');
  $('routeChinese').hidden = !$('routeChinese').textContent;
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
  text($('routeBasis'), scenarioMotion?.note ? ballScenario.note : player ? `${t(basisLabels[player.label.basis])}${player.label.note ? ` · ${player.label.note}` : ''}` : '');
  const staticScene = lesson.timeline.duration === 0;
  text($('playState'), staticScene ? '静态站位' : !scene.ready ? '先选演示选项' : state.playing ? '演示中' : '已暂停 · 可讲解');
  text($('play'), staticScene ? '静态站位' : !scene.ready ? '先选演示选项' : state.playing ? 'Ⅱ 暂停讲解' : state.time >= lesson.timeline.duration ? '↻ 再看一遍' : state.time > 0 ? '▶ 继续播放' : '▶ 开始演示');
  $('play').disabled = staticScene || !scene.ready;
  syncFloatingPlay();
  $('seek').disabled = staticScene || !scene.ready;
  $('seek').value = state.time;
  const progress = lesson.timeline.duration > 0 ? state.time / lesson.timeline.duration : 0;
  $('seek').style.setProperty('--progress', `calc(8px + (100% - 16px) * ${progress})`);
  text($('clock'), `${state.time.toFixed(1)} / ${lesson.timeline.duration.toFixed(1)} s`);
  const frameIndex = lesson.keyframes.indexOf(scene.keyframe);
  $('timelineTicks').querySelectorAll('[data-tick]').forEach((tick, index) => { tick.dataset.current = String(index === frameIndex); });
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
$('catalog').addEventListener('click', event => {
  const button = event.target.closest('[data-lesson]'); if (!button) return;
  navigateTo(button.dataset.lesson);
  if (drawerQuery.matches) setCatalogOpen(false);
});
$('catalogToggle').addEventListener('click', () => setCatalogOpen(!document.body.classList.contains('catalog-open')));
$('catalogClose').addEventListener('click', () => setCatalogOpen(false));
$('catalogBackdrop').addEventListener('click', () => setCatalogOpen(false));
drawerQuery.addEventListener('change', () => setCatalogOpen(false, false));
narrowQuery.addEventListener('change', rebuildField);
document.querySelector('.brand').addEventListener('click', event => { event.preventDefault(); scrollTo({top: 0}); });
// Back/forward and edited links both arrive here; whichever event fires first does the work.
function followAddress() {
  const id = lessonFromHash(location.hash);
  if (id && id !== lesson?.id && pack.lessons.some(item => item.id === id)) selectLesson(id);
}
window.addEventListener('hashchange', followAddress);
window.addEventListener('popstate', followAddress);
$('previous').addEventListener('click', () => goToLesson(-1));
$('headPrevious').addEventListener('click', () => goToLesson(-1));
$('headNext').addEventListener('click', () => goToLesson(1));
$('printLesson').addEventListener('click', () => { pause(); print(); });
addEventListener('beforeprint', () => { if (state.playing) pause(); });
$('next').addEventListener('click', () => goToLesson(1));
$('play').addEventListener('click', togglePlay);
$('fullscreen').addEventListener('click', () => setFullscreen(!document.body.classList.contains('board-fullscreen-open')));
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) setFullscreen(false); });
$('fieldZoom').addEventListener('click', () => {
  state.fullField = !state.fullField;
  $('fieldZoom').setAttribute('aria-pressed', String(state.fullField));
  rebuildField();
});
$('reset').addEventListener('click', () => seek(0));
$('floatingPlay').addEventListener('click', () => {
  if (floatingFullscreen()) setFullscreen(true);
  else document.querySelector('.controls').scrollIntoView({block: 'end'});
  togglePlay();
  // The floating copy hides once the controls are in view; keep keyboard focus with them.
  $('play').focus({preventScroll: true});
});
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
$('ballNoteMore').addEventListener('click', () => {
  const controls = $('ballControls');
  controls.dataset.noteOpen = String(controls.dataset.noteOpen !== 'true');
  syncBallNote(); fitField();
});
$('seek').addEventListener('input', event => seek(Number(event.target.value)));
$('frames').addEventListener('click', event => { const button = event.target.closest('[data-frame]'); if (button) seek(lesson.keyframes[Number(button.dataset.frame)].at); });
document.querySelectorAll('[data-speed]').forEach(button => button.addEventListener('click', () => setSpeed(Number(button.dataset.speed))));
// Shortcuts stay out of the way of typing, sliders, menus and focused buttons.
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && document.body.classList.contains('catalog-open')) { setCatalogOpen(false); return; }
  if (event.key === 'Escape' && document.body.classList.contains('board-fullscreen-open')) { setFullscreen(false); return; }
  if (event.defaultPrevented || !lesson || document.querySelector('dialog[open]') || document.body.classList.contains('catalog-open')) return;
  const target = event.target instanceof Element ? event.target : null;
  const action = shortcutFor(event, {
    typing: Boolean(target?.closest('input, select, textarea, [contenteditable="true"]')),
    onControl: Boolean(target?.closest('button, summary, a, [role="button"]')),
  });
  if (!action) return;
  if (action.type !== 'speed') event.preventDefault();
  if (action.type === 'toggle') togglePlay();
  else if (action.type === 'keyframe') stepKeyframe(action.direction);
  else if (action.type === 'speed') setSpeed(action.value);
  else if (action.type === 'reset') seek(0);
  else if (action.type === 'lesson') goToLesson(action.direction);
  else if (action.type === 'fullscreen') setFullscreen(!document.body.classList.contains('board-fullscreen-open'));
});
// The legend opens by default on wide screens; a parent's own choice is remembered.
try {
  const legend = localStorage.getItem('flagventures.legend');
  $('boardLegend').open = legend ? legend === 'open' : !drawerQuery.matches;
} catch { $('boardLegend').open = !drawerQuery.matches; }
$('boardLegend').querySelector('summary').addEventListener('click', () => setTimeout(() => {
  try { localStorage.setItem('flagventures.legend', $('boardLegend').open ? 'open' : 'closed'); } catch {}
}));
$('choices').addEventListener('click', event => {
  const button = event.target.closest('[data-choice-player]'); if (!button) return;
  state.choices[button.dataset.choicePlayer] = button.dataset.option;
  state.time = 0; pause(); fitField();
});
for (const id of ['field', 'roles']) {
  const surface = $(id);
  surface.addEventListener('click', event => {
    const target = event.target.closest('[data-player],[data-show-all]'); if (!target) return;
    state.role = target.hasAttribute('data-show-all') ? null : target.dataset.player;
    hovered = focused = null; render();
  });
  surface.addEventListener('pointermove', event => {
    const value = event.target.closest('[data-player]')?.dataset.player || null;
    if (value !== hovered) { hovered = value; render(); }
  });
  surface.addEventListener('pointerleave', () => { if (hovered !== null) { hovered = null; render(); } });
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
// Frames are requested only while playing, so a paused lesson costs no CPU or battery.
function tick(now) {
  tickRequest = undefined;
  if (!state.playing || !lesson) { lastTick = undefined; return; }
  if (lastTick !== undefined) state.time = Math.min(lesson.timeline.duration, state.time + Math.min((now - lastTick) / 1000, .1) * state.speed);
  lastTick = now;
  if (state.time >= lesson.timeline.duration) state.playing = false;
  render();
  if (state.playing) startTicking(); else lastTick = undefined;
}
// The online copy installs to the home screen and works offline. The downloaded single
// file (file://) has no manifest or service worker to load, so it skips both.
if (location.protocol === 'https:' || location.protocol === 'http:') {
  document.head.append(node('link', {rel: 'manifest', href: 'manifest.webmanifest'}), node('link', {rel: 'apple-touch-icon', href: 'apple-touch-icon.png'}));
  if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
function showStartupError(error) { text($('lessonTitle'), '内置内容检查未通过'); text($('summary'), error.message); console.error(error); }
try { setPack(builtIn, '内置手册', lessonFromHash(location.hash)); }
catch (error) { showStartupError(error); }
// The build already validated the built-in pack. Re-checking it here is only a safety net,
// so it waits until the first lesson is on screen (it costs ~0.3 s on a slow phone).
(window.requestIdleCallback || (callback => setTimeout(callback, 300)))(() => {
  try { validatePack(builtIn, '内置手册'); } catch (error) { showStartupError(error); }
});
