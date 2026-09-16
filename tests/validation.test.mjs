import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dump } from 'js-yaml';
import { ContentError, LIMITS, parseLesson, validateLesson, validatePack, validateCatalog, prepareImport } from '../app/validation.js';

const clone = value => JSON.parse(JSON.stringify(value));
function lesson(id = 'custom') {
  return {
    format: 'flag-lesson', version: 1, id, kind: 'offense', title: { zh: '自编战术' }, summary: '一起跑位。',
    field: { width: 100, height: 55, attackDirection: 'up', lineOfScrimmageY: 35 },
    players: [{ id: 'X', team: 'offense', at: [20, 35], label: { zh: '向前', description: '一起跑', basis: 'author' },
      motion: { type: 'path', startAt: 0, steps: [{ type: 'line', to: [20, 10], seconds: 1 }] } }],
    timeline: { duration: 4, basis: 'illustration', note: '教学时间' },
    keyframes: [{ id: 'start', at: 0, label: '起点', cue: '找队员' }],
  };
}
function pack(...lessons) {
  return { format: 'flag-playbook', version: 1, title: '战术包', lessons,
    sections: [{ id: 'book', title: '内置手册', lessonIds: lessons.map(item => item.id) }] };
}
function catalogFor(data) {
  return { format: 'flag-catalog', version: 1, title: data.title,
    sections: data.sections.map(({ lessonIds, ...section }) => ({ ...clone(section),
      entries: lessonIds.map(id => ({ id, file: `lessons/${id}.yaml` })) })) };
}
function groupedPack() {
  const data = pack(...['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'other'].map(lesson));
  data.sections[0].lessonIds.pop();
  data.sections[0].groups = [
    { id: 'formation-a', title: '阵型 A', lessonIds: ['second', 'third'] },
    { id: 'formation-b', title: '阵型 B', lessonIds: ['fifth', 'sixth'] },
  ];
  data.sections.push({ id: 'extra', title: '另一章', lessonIds: ['other'],
    groups: [{ id: 'formation-a', title: '同名编号在另一章', lessonIds: ['other'] }] });
  return data;
}
const file = data => ({ name: `${data.id}.yaml`, text: dump(data, { noRefs: true }) });
function rejectsEdit(edit, pattern) {
  const data = lesson();
  edit(data);
  assert.throws(() => validateLesson(data, '课堂.yaml'), pattern || ContentError);
}

test('four documented YAML examples and complete sample pack use the same validators', () => {
  for (const path of ['templates/new-play.yaml', 'examples/single-back-play-1.yaml', 'examples/cover-2.yaml', 'examples/route-variants.yaml']) {
    const text = readFileSync(new URL(`../content-format/${path}`, import.meta.url), 'utf8');
    assert.equal(parseLesson(text, path).version, 1);
  }
  const data = JSON.parse(readFileSync(new URL('../content-format/examples.flagbook.json', import.meta.url), 'utf8'));
  assert.equal(validatePack(data).pack.lessons.length, 4);
});

test('YAML rejects tags, anchors, aliases, merge keys and multiple documents before applying anything', () => {
  const text = dump(lesson());
  for (const summary of ['&name plain', '*missing', '!!str plain', '! plain', '!custom plain']) {
    assert.throws(() => parseLesson(text.replace(/^summary:.*$/m, `summary: ${summary}`), '新战术.yaml'), /新战术.yaml.*(标签|锚点|别名)/);
  }
  assert.throws(() => parseLesson(`%TAG !e! tag:example.org,2020:\n---\n${text}`), /标签/);
  assert.throws(() => parseLesson(text.replace('field:\n', 'field:\n  <<: {width: 100}\n')), /合并键/);
  assert.throws(() => parseLesson(`${text}\n---\n${text}`), /无法读取 YAML/);
  assert.throws(() => parseLesson(`${text}\nsummary: 重复\n`), /无法读取 YAML/);
});

test('ordinary quoted and block text containing YAML markers or HTML remains inert text', () => {
  const data = lesson();
  data.summary = '! 注意 & 符号 * 箭头 << <img src=x onerror="alert(1)">';
  assert.equal(parseLesson(dump(data)).summary, data.summary);
  const text = dump(lesson()).replace(/^summary:.*$/m, 'summary: |\n  !hello &anchor *alias\n  <script>alert(1)</script>');
  assert.match(parseLesson(text).summary, /<script>alert\(1\)<\/script>/);
});

test('malformed, oversized and deeply nested text gives bounded readable errors', () => {
  assert.throws(() => parseLesson('title: [oops', '破损.yaml'), /破损.yaml.*第 .*行/);
  assert.throws(() => parseLesson('中'.repeat(Math.ceil(LIMITS.lessonBytes / 3) + 1)), /1 MB/);
  assert.throws(() => parseLesson('['.repeat(100) + '0' + ']'.repeat(100)), /层级/);
  assert.throws(() => parseLesson('summary: 1\n'.repeat(2)), ContentError);
});

test('unknown fields, versions, invalid scalar types and executable object properties are rejected', () => {
  rejectsEdit(data => { data.version = 2; }, /version.*版本 1/);
  rejectsEdit(data => { data.players[0].label.script = 'alert(1)'; }, /label.script.*不认识/);
  rejectsEdit(data => { data.timeline.duration = '4'; }, /类型/);
  rejectsEdit(data => { data.timeline.duration = Infinity; }, /有限/);
  const data = lesson();
  let ran = false;
  Object.defineProperty(data, 'unexpected', { enumerable: true, get() { ran = true; return 1; } });
  assert.throws(() => validateLesson(data), /可执行属性/);
  assert.equal(ran, false);
  assert.throws(() => parseLesson(JSON.stringify({ ...lesson(), ['__proto__']: { x: 1 } })), /不支持/);
});

test('labels preserve provenance and source-backed claims require identifiable source', () => {
  rejectsEdit(data => { data.players[0].label.basis = 'shape-match'; }, /note/);
  rejectsEdit(data => { data.players[0].label.basis = 'source'; }, /source/);
  rejectsEdit(data => { data.timeline.basis = 'coach'; }, /source/);
  const data = lesson();
  data.source = { title: '教练' };
  data.timeline.basis = 'coach';
  data.players[0].label.basis = 'source';
  assert.equal(validateLesson(data).lesson, data);
  data.source.title = '  ';
  assert.throws(() => validateLesson(data), /可识别/);
});

test('all point and control-point coordinates and entire ellipse bounds stay on canvas', () => {
  rejectsEdit(data => { data.players[0].at = [101, 35]; }, /球员 X.at.*画布/);
  rejectsEdit(data => { data.field.lineOfScrimmageY = 56; }, /开球线/);
  rejectsEdit(data => { data.players[0].motion.steps = [{ type: 'quadratic', control: [200, 5], to: [20, 10], seconds: 1 }]; }, /control.*画布/);
  rejectsEdit(data => { data.players[0].motion.steps = [{ type: 'cubic', control1: [20, 5], control2: [200, 5], to: [20, 10], seconds: 1 }]; }, /control2.*画布/);
  rejectsEdit(data => { data.zones = [{ id: 'deep', type: 'ellipse', label: '后区', center: [10, 10], radiusX: 20, radiusY: 5 }]; }, /区域 deep.边界/);
  rejectsEdit(data => { data.zones = [{ id: 'deep', type: 'polygon', label: '后区', points: [[0, 0], [100, 0], [100, 56]] }]; }, /points.*画布/);
});

test('timeline checks every choice branch and keeps formation static', () => {
  rejectsEdit(data => { data.players[0].motion.startAt = 4; }, /球员 X.*超过/);
  rejectsEdit(data => { data.players[0].motion.steps[0].seconds = 0; }, /seconds.*大于 0/);
  rejectsEdit(data => { data.timeline.duration = 0; data.players[0].motion.steps[0].seconds = 1e-12; }, /超过/);
  rejectsEdit(data => { data.players[0].motion = { type: 'choice', startAt: 0, prompt: '选择', options: [
    { id: 'short', title: '短', steps: [{ type: 'line', to: [20, 20], seconds: 1 }] },
    { id: 'long', title: '长', steps: [{ type: 'pause', seconds: 5 }] },
  ] }; }, /long.*超过/);
  rejectsEdit(data => { data.kind = 'formation'; data.timeline.duration = 0; });
  const formation = lesson();
  formation.kind = 'formation'; formation.timeline.duration = 0;
  formation.players[0].motion = { type: 'unspecified', note: '未说明' };
  assert.equal(validateLesson(formation).lesson, formation);
});

test('IDs are unique within correct scope, while independent players may share choice option IDs', () => {
  rejectsEdit(data => { data.players.push(clone(data.players[0])); }, /编号 X 重复/);
  const choice = { type: 'choice', startAt: 0, prompt: '选择', options: [
    { id: 'left', title: '左', steps: [{ type: 'line', to: [10, 10], seconds: 1 }] },
    { id: 'right', title: '右', steps: [{ type: 'line', to: [30, 10], seconds: 1 }] },
  ] };
  const data = lesson();
  data.players[0].motion = choice;
  data.players.push({ ...clone(data.players[0]), id: 'Y' });
  assert.equal(validateLesson(data).lesson, data);
  data.players[0].motion.options[1].id = 'left';
  assert.throws(() => validateLesson(data), /编号 left 重复/);
});

test('assignment references and guide geometry are separate from motion', () => {
  const data = lesson();
  data.zones = [{ id: 'short', type: 'ellipse', label: '短区', center: [20, 20], radiusX: 10, radiusY: 10 }];
  data.assignments = [{ id: 'cover', type: 'coverage', player: 'X', zone: 'short' }];
  validateLesson(data);
  data.assignments[0].zone = 'missing';
  assert.throws(() => validateLesson(data), /区域 missing 不存在/);
  data.assignments = [{ id: 'match', type: 'matchup', player: 'X', target: 'missing' }];
  assert.throws(() => validateLesson(data), /目标球员 missing 不存在/);
  data.assignments = [{ id: 'rush', type: 'rush', player: 'X', guide: { from: [20, 35], segments: [{ type: 'line', to: [101, 35] }] } }];
  assert.throws(() => validateLesson(data), /guide.*画布/);
  data.assignments[0].guide.segments[0] = { type: 'line', to: [20, 10], seconds: 1 };
  assert.throws(() => validateLesson(data), /seconds.*不认识/);
});

test('keyframes start at zero, strictly increase and reference real teaching layers', () => {
  rejectsEdit(data => { data.keyframes[0].at = 1; }, /第一帧.*0 秒/);
  rejectsEdit(data => { data.keyframes.push({ ...data.keyframes[0], id: 'again' }); }, /严格递增/);
  rejectsEdit(data => { data.keyframes.push({ ...data.keyframes[0], id: 'late', at: 5 }); }, /超过/);
  rejectsEdit(data => { data.keyframes[0].view = { zoneIds: [] }; }, /assignmentIds/);
  rejectsEdit(data => { data.keyframes[0].view = { zoneIds: ['missing'], assignmentIds: [] }; }, /区域 missing/);
  const data = lesson(); data.keyframes[0].view = { zoneIds: [], assignmentIds: [] };
  validateLesson(data);
});

test('pack enforces a bijection between lessons and directory entries', () => {
  const data = pack(lesson('first'), lesson('second'));
  data.sections[0].lessonIds.pop(); assert.throws(() => validatePack(data), /未出现在目录/);
  data.sections[0].lessonIds.push('missing'); assert.throws(() => validatePack(data), /战术 missing 不存在/);
  data.sections[0].lessonIds = ['first', 'second'];
  data.sections.push({ id: 'extra', title: '重复', lessonIds: ['first'] });
  assert.throws(() => validatePack(data), /出现多次/);
  data.sections.pop(); data.lessons[1].id = 'first';
  assert.throws(() => validatePack(data), /编号 first 重复/);
});

test('missing reference image is a warning, while invalid supplied image data is rejected', () => {
  const data = pack(lesson()); data.lessons[0].source = { title: '原图', referenceAsset: 'page-1' };
  assert.equal(validatePack(data).warnings.length, 1);
  data.assets = [{ id: 'page-1', mime: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' }];
  assert.equal(validatePack(data).warnings.length, 0);
  data.assets[0].mime = 'image/jpeg';
  assert.throws(() => validatePack(data), /PNG\/JPEG/);
});

test('catalog checks path safety, uniqueness, file presence and matching lesson IDs', () => {
  const catalog = { format: 'flag-catalog', version: 1, title: '目录', sections: [{ id: 's', title: '章', entries: [{ id: 'custom', file: '示例/custom.yaml' }] }] };
  validateCatalog(catalog, new Map([['示例/custom.yaml', lesson()]]));
  assert.throws(() => validateCatalog(catalog, {}), /找不到/);
  assert.throws(() => validateCatalog(catalog, { '示例/custom.yaml': lesson('different') }), /ID 应为/);
  for (const path of ['../x.yaml', '/x.yaml', 'a/../x.yaml', 'https://example.com/x.yaml', 'C:\\x.yaml']) {
    const changed = clone(catalog); changed.sections[0].entries[0].file = path;
    assert.throws(() => validateCatalog(changed), /格式不正确/);
  }
});

test('optional groups preserve old packs and catalogs, including empty groups', () => {
  const current = pack(lesson());
  assert.equal(validatePack(current).pack, current);
  validateCatalog(catalogFor(current));
  assert.equal(Object.hasOwn(current.sections[0], 'groups'), false);
  current.sections[0].groups = [];
  validatePack(current);
  validateCatalog(catalogFor(current));
});

test('grouped content round trips with ordered slices, ungrouped lessons and section-scoped group IDs', () => {
  const current = groupedPack();
  const before = clone(current);
  const catalog = catalogFor(current);
  validateCatalog(catalog, new Map(current.lessons.map(item => [`lessons/${item.id}.yaml`, item])));
  const result = prepareImport(pack(), [{ name: 'grouped.flagbook.json', text: JSON.stringify(current) }]);
  assert.equal(result.mode, 'pack');
  assert.deepEqual(result.pack, before);
  assert.deepEqual(current, before);
  assert.deepEqual(result.pack.sections[0].lessonIds, ['first', 'second', 'third', 'fourth', 'fifth', 'sixth']);
});

for (const [name, edit, message] of [
  ['unknown member', groups => { groups[0].lessonIds = ['missing']; }, /战术 missing 不在本章节/],
  ['member from another section', groups => { groups[0].lessonIds = ['other']; }, /战术 other 不在本章节/],
  ['overlapping membership', groups => { groups[1].lessonIds = ['third', 'fourth']; }, /不能属于多个分组/],
  ['duplicate group ID', groups => { groups[1].id = groups[0].id; }, /编号 formation-a 重复/],
  ['reversed members', groups => { groups[0].lessonIds = ['third', 'second']; }, /按章节目录顺序连续排列/],
  ['noncontiguous members', groups => { groups[0].lessonIds = ['second', 'fourth']; }, /按章节目录顺序连续排列/],
]) {
  test(`pack and catalog groups reject ${name}`, () => {
    const data = groupedPack();
    edit(data.sections[0].groups);
    for (const validate of [() => validatePack(data, '分组.flagbook.json'),
      () => validateCatalog(catalogFor(data), undefined, '分组目录.yaml')]) {
      assert.throws(validate, error => {
        assert.ok(error instanceof ContentError);
        assert.match(error.field, /章节 book\.groups/);
        assert.match(error.message, message);
        return true;
      });
    }
  });
}

test('both group schemas require known fields, valid IDs, titles and nonempty unique members', () => {
  for (const [edit, pattern] of [
    [group => { group.lessonIds = []; }, /至少需要 1 项/],
    [group => { group.lessonIds = ['second', 'second']; }, /重复值/],
    [group => { group.id = '1-invalid'; }, /格式不正确/],
    [group => { group.lessonIds = ['1-invalid']; }, /格式不正确/],
    [group => { group.title = ''; }, /请填写文字/],
    [group => { delete group.title; }, /缺少必填字段/],
    [group => { group.unknown = 'extra'; }, /不认识的字段/],
  ]) {
    const data = groupedPack();
    edit(data.sections[0].groups[0]);
    assert.throws(() => validatePack(data), pattern);
    assert.throws(() => validateCatalog(catalogFor(data)), pattern);
  }
});

test('YAML updates preserve groups and canonical positions while new lessons remain ungrouped', () => {
  const current = groupedPack();
  current.sections[0].title = '我的战术';
  const before = clone(current);
  const result = prepareImport(current, [file({ ...lesson('second'), title: { zh: '更新组内战术' } }), file(lesson('new-one'))]);
  assert.deepEqual(result.updated, ['second']);
  assert.deepEqual(result.added, ['new-one']);
  assert.deepEqual(result.pack.sections[0].groups, before.sections[0].groups);
  assert.deepEqual(result.pack.sections[0].lessonIds, [...before.sections[0].lessonIds, 'new-one']);
  assert.equal(result.pack.lessons.find(item => item.id === 'second').title.zh, '更新组内战术');
  assert.deepEqual(current, before);
  assert.deepEqual(prepareImport(pack(), [{ name: 'updated.flagbook.json', text: JSON.stringify(result.pack) }]).pack, result.pack);
});

test('YAML batch preview is atomic and never mutates the current pack', () => {
  const current = pack(lesson('original'));
  const before = clone(current);
  assert.throws(() => prepareImport(current, [file(lesson('valid-new')), { name: 'broken.yaml', text: 'not a lesson' }]), ContentError);
  assert.deepEqual(current, before);
  assert.throws(() => prepareImport(current, [file(lesson('same')), file(lesson('same'))]), /编号 same 重复/);
  assert.deepEqual(current, before);
});

test('updates replace the whole lesson without moving it; new entries append after built-in chapters', () => {
  const first = lesson('first'); first.source = { title: '旧来源' }; first.notes = ['旧说明'];
  const current = pack(first, lesson('second'));
  const result = prepareImport(current, [file({ ...lesson('first'), title: { zh: '新标题' } }), file(lesson('new-one'))]);
  assert.deepEqual(result.added, ['new-one']); assert.deepEqual(result.updated, ['first']);
  assert.equal(result.mode, 'lessons');
  assert.deepEqual(result.pack.sections[0].lessonIds, ['first', 'second']);
  assert.deepEqual(result.pack.sections[1], { id: 'my-plays', title: '我的战术', lessonIds: ['new-one'] });
  assert.equal(result.pack.lessons[0].source, undefined); assert.equal(result.pack.lessons[0].notes, undefined);
  assert.equal(current.lessons[0].source.title, '旧来源');
});

test('my-plays section identity collisions do not overwrite existing chapters', () => {
  const current = pack(lesson()); current.sections[0].id = 'my-plays';
  const result = prepareImport(current, [file(lesson('added'))]);
  assert.equal(result.pack.sections[0].title, '内置手册');
  assert.equal(result.pack.sections[1].id, 'my-plays-2');
});

test('one JSON package replaces the activity library exactly; mixed packages and duplicate JSON keys fail', () => {
  const current = pack(lesson('old'));
  const replacement = pack(lesson('new'));
  replacement.sections[0].title = '自定次序';
  const item = { name: 'my.flagbook.json', text: JSON.stringify(replacement) };
  const result = prepareImport(current, [item]);
  assert.equal(result.mode, 'pack'); assert.deepEqual(result.pack, replacement);
  assert.deepEqual(current.lessons.map(item => item.id), ['old']);
  assert.throws(() => prepareImport(current, [item, file(lesson())]), /不能.*混合/);
  assert.throws(() => prepareImport(current, [{ name: 'bad.flagbook.json', text: item.text.replace('"title":"战术包"', '"title":"战术包","title":"重复"') }]), /无法读取 YAML/);
});

test('exported JSON round trips all content and options without changing semantics', () => {
  const current = JSON.parse(readFileSync(new URL('../content-format/examples.flagbook.json', import.meta.url), 'utf8'));
  const result = prepareImport(pack(), [{ name: 'roundtrip.flagbook.json', text: JSON.stringify(current) }]);
  assert.deepEqual(result.pack, current);
});
