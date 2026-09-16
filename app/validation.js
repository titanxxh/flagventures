import { load, JSON_SCHEMA } from 'js-yaml';
import Ajv2020 from 'ajv/dist/2020.js';
import lessonSchema from '../content-format/lesson.schema.json' with { type: 'json' };
import packSchema from '../content-format/pack.schema.json' with { type: 'json' };
import catalogSchema from '../content-format/catalog.schema.json' with { type: 'json' };

export const LIMITS = Object.freeze({ lessonBytes: 1024 * 1024, packBytes: 50 * 1024 * 1024 });
const encoder = new TextEncoder();

export class ContentError extends Error {
  constructor(filename, field, message) {
    super(`${filename} · ${field || '内容'}：${message}`);
    this.name = 'ContentError';
    this.filename = filename;
    this.field = field || '内容';
  }
}

function fail(filename, field, message) {
  throw new ContentError(filename, field, message);
}

// Only our bundled schemas are compiled. Import files never supply schemas or code.
function discriminated(schema) {
  const copy = JSON.parse(JSON.stringify(schema));
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.oneOf?.every(branch => typeof branch.properties?.type?.const === 'string')) {
      node.type = 'object';
      node.discriminator = { propertyName: 'type' };
    }
    for (const value of Object.values(node)) visit(value);
  }
  visit(copy);
  return copy;
}

const ajv = new Ajv2020({ strict: true, allErrors: true, discriminator: true, ownProperties: true });
for (const schema of [lessonSchema, packSchema, catalogSchema]) ajv.addSchema(discriminated(schema));
const validators = {
  lesson: ajv.getSchema('lesson.schema.json'),
  pack: ajv.getSchema('pack.schema.json'),
  catalog: ajv.getSchema('catalog.schema.json'),
};

function safeData(data, filename) {
  const active = new WeakSet();
  let count = 0;
  function visit(value, path, depth) {
    if (++count > 200000 || depth > 64) fail(filename, path, '数据层级或条目数量过多');
    if (typeof value === 'number' && !Number.isFinite(value)) fail(filename, path, '数值必须有限');
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return;
    if (!value || typeof value !== 'object') fail(filename, path, '只能填写普通数据');
    if (active.has(value)) fail(filename, path, '不支持循环引用');
    if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      fail(filename, path, '只能填写普通对象');
    }
    active.add(value);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (Array.isArray(value) && key === 'length') continue;
      const next = path ? `${path}.${key}` : key;
      if (['__proto__', 'prototype', 'constructor', '<<'].includes(key)) fail(filename, next, '不支持这个字段或合并键');
      if (!Object.hasOwn(descriptor, 'value')) fail(filename, next, '不能包含可执行属性');
      visit(descriptor.value, next, depth + 1);
    }
    active.delete(value);
  }
  visit(data, '', 0);
}

function checkedText(text, filename, limit) {
  if (typeof text !== 'string') fail(filename, '文件', '必须是 UTF-8 文本');
  if (encoder.encode(text).length > limit) fail(filename, '文件大小', `超过 ${limit / 1024 / 1024} MB，未导入任何内容`);
}

// js-yaml's node listener sees the start of every real YAML node, so strings and
// block-scalar descriptions containing !, &, or * remain ordinary text.
function readYaml(text, filename) {
  let depth = 0;
  let nodes = 0;
  try {
    return load(text, {
      filename,
      schema: JSON_SCHEMA,
      json: false,
      listener(event, state) {
        if (event === 'close') { depth--; return; }
        if (++depth > 64 || ++nodes > 200000) fail(filename, 'YAML', '数据层级或条目数量过多');
        if (Object.keys(state.tagMap || {}).length) fail(filename, 'YAML', '不支持标签声明');
        let i = state.position;
        while (i < state.input.length) {
          if (/\s/.test(state.input[i])) { i++; continue; }
          if (state.input[i] === '#') {
            while (i < state.input.length && !/[\r\n]/.test(state.input[i])) i++;
            continue;
          }
          break;
        }
        if ('!&*'.includes(state.input[i] || '\0')) {
          fail(filename, `YAML 第 ${state.input.slice(0, i).split('\n').length} 行`, '不支持标签、锚点或别名');
        }
      },
    });
  } catch (error) {
    if (error instanceof ContentError) throw error;
    const line = error.mark ? `第 ${error.mark.line + 1} 行，第 ${error.mark.column + 1} 列` : 'YAML';
    fail(filename, line, `无法读取 YAML：${error.reason || error.message}`);
  }
}

function fieldName(pointer, data) {
  const parts = pointer.split('/').slice(1).map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  let node = data;
  const labels = [];
  for (const part of parts) {
    if (Array.isArray(node)) {
      const entry = node[Number(part)];
      labels.push(`[${Number(part) + 1}${entry?.id ? `，${entry.id}` : ''}]`);
      node = entry;
    } else {
      labels.push(part);
      node = node?.[part];
    }
  }
  return labels.join('.');
}

function structure(kind, data, filename) {
  safeData(data, filename);
  if (data && typeof data === 'object' && data.version !== 1) fail(filename, 'version', '只支持格式版本 1');
  const validate = validators[kind];
  if (validate(data)) return;
  const errors = validate.errors || [];
  const error = errors.find(item => item.keyword === 'additionalProperties') ||
    errors.find(item => !['if', 'oneOf', 'anyOf'].includes(item.keyword)) || errors[0];
  let path = fieldName(error.instancePath, data);
  let message;
  switch (error.keyword) {
    case 'required': path += `${path ? '.' : ''}${error.params.missingProperty}`; message = '缺少必填字段'; break;
    case 'additionalProperties': path += `${path ? '.' : ''}${error.params.additionalProperty}`; message = '不认识的字段'; break;
    case 'exclusiveMinimum': message = `必须大于 ${error.params.limit}`; break;
    case 'minimum': message = `不得小于 ${error.params.limit}`; break;
    case 'minItems': message = `至少需要 ${error.params.limit} 项`; break;
    case 'maxItems': message = `最多允许 ${error.params.limit} 项`; break;
    case 'minLength': message = '请填写文字'; break;
    case 'maxLength': message = `长度不能超过 ${error.params.limit}`; break;
    case 'type': message = `类型不正确，应为 ${error.params.type}`; break;
    case 'const': message = `必须是 ${JSON.stringify(error.params.allowedValue)}`; break;
    case 'enum': message = `只能选 ${error.params.allowedValues.join('、')}`; break;
    case 'uniqueItems': message = '不能包含重复值'; break;
    case 'discriminator': message = '动作或图形 type 不受支持'; break;
    case 'pattern': message = '格式不正确，请核对编号、颜色、路径或编码'; break;
    default: message = '不符合格式约定';
  }
  fail(filename, path, message);
}

function unique(items, filename, field) {
  const ids = new Set();
  for (const item of items) {
    if (ids.has(item.id)) fail(filename, field, `编号 ${item.id} 重复`);
    ids.add(item.id);
  }
  return ids;
}

function requireRef(ids, id, filename, field, noun) {
  if (!ids.has(id)) fail(filename, field, `${noun} ${id} 不存在`);
}

function lessonSemantics(lesson, filename) {
  const { width, height, lineOfScrimmageY } = lesson.field;
  const point = (value, field) => {
    if (value[0] < 0 || value[0] > width || value[1] < 0 || value[1] > height) {
      fail(filename, field, `坐标必须位于画布内（x: 0–${width}，y: 0–${height}）`);
    }
  };
  const geometry = (segment, field) => {
    for (const key of ['to', 'control', 'control1', 'control2']) if (segment[key]) point(segment[key], `${field}.${key}`);
  };
  if (lineOfScrimmageY !== undefined && lineOfScrimmageY > height) fail(filename, 'field.lineOfScrimmageY', '开球线必须位于画布内');
  const players = unique(lesson.players, filename, 'players');
  const zones = unique(lesson.zones || [], filename, 'zones');
  const assignments = unique(lesson.assignments || [], filename, 'assignments');
  unique(lesson.keyframes, filename, 'keyframes');
  if (lesson.source && !lesson.source.title.trim()) fail(filename, 'source.title', '请填写可识别的来源');

  for (const player of lesson.players) {
    const field = `球员 ${player.id}`;
    point(player.at, `${field}.at`);
    if (player.label.basis === 'shape-match' && !player.label.note.trim()) fail(filename, `${field}.label.note`, '请说明形状对照依据');
    const motion = player.motion;
    const paths = motion.type === 'choice' ? motion.options : motion.type === 'path' ? [{ id: '路线', steps: motion.steps }] : [];
    if (motion.type === 'choice') unique(motion.options, filename, `${field}.motion.options`);
    for (const option of paths) {
      let end = motion.startAt;
      option.steps.forEach((step, index) => {
        geometry(step, `${field}.${option.id}.第 ${index + 1} 段`);
        end += step.seconds;
      });
      const tolerance = Number.EPSILON * Math.max(Math.abs(end), Math.abs(lesson.timeline.duration)) * Math.max(4, option.steps.length);
      if (!Number.isFinite(end) || end - lesson.timeline.duration > tolerance) fail(filename, `${field}.${option.id}`, `路线到 ${Number(end.toPrecision(12))} 秒，超过 timeline.duration ${lesson.timeline.duration} 秒`);
    }
  }
  for (const zone of lesson.zones || []) {
    const field = `区域 ${zone.id}`;
    if (zone.type === 'polygon') zone.points.forEach((value, index) => point(value, `${field}.points[${index + 1}]`));
    else {
      point(zone.center, `${field}.center`);
      point([zone.center[0] - zone.radiusX, zone.center[1] - zone.radiusY], `${field}.边界`);
      point([zone.center[0] + zone.radiusX, zone.center[1] + zone.radiusY], `${field}.边界`);
    }
  }
  for (const assignment of lesson.assignments || []) {
    const field = `职责 ${assignment.id}`;
    requireRef(players, assignment.player, filename, `${field}.player`, '球员');
    if (assignment.type === 'coverage') requireRef(zones, assignment.zone, filename, `${field}.zone`, '区域');
    if (assignment.type === 'matchup') requireRef(players, assignment.target, filename, `${field}.target`, '目标球员');
    if (assignment.guide) {
      point(assignment.guide.from, `${field}.guide.from`);
      assignment.guide.segments.forEach((segment, index) => geometry(segment, `${field}.guide.segments[${index + 1}]`));
    }
  }
  let previous = -1;
  for (const [index, frame] of lesson.keyframes.entries()) {
    const field = `关键帧 ${frame.id}`;
    if (index === 0 && frame.at !== 0) fail(filename, `${field}.at`, '第一帧必须在 0 秒');
    if (frame.at <= previous) fail(filename, `${field}.at`, '关键帧时间必须严格递增');
    if (frame.at > lesson.timeline.duration) fail(filename, `${field}.at`, '超过 timeline.duration');
    previous = frame.at;
    for (const id of frame.view?.zoneIds || []) requireRef(zones, id, filename, `${field}.view.zoneIds`, '区域');
    for (const id of frame.view?.assignmentIds || []) requireRef(assignments, id, filename, `${field}.view.assignmentIds`, '职责');
  }
}

export function validateLesson(lesson, filename = '教学条目') {
  structure('lesson', lesson, filename);
  lessonSemantics(lesson, filename);
  return { lesson, warnings: [] };
}

export function parseLesson(text, filename = '教学条目.yaml') {
  checkedText(text, filename, LIMITS.lessonBytes);
  const lesson = readYaml(text, filename);
  validateLesson(lesson, filename);
  return lesson;
}

function validateAsset(asset, filename) {
  let bytes;
  try { bytes = atob(asset.base64); } catch { fail(filename, `图片 ${asset.id}.base64`, '不是有效的 Base64'); }
  if (btoa(bytes) !== asset.base64) fail(filename, `图片 ${asset.id}.base64`, '不是标准 Base64 编码');
  const signature = asset.mime === 'image/png' ? [137, 80, 78, 71, 13, 10, 26, 10] : [255, 216, 255];
  if (!signature.every((byte, i) => bytes.charCodeAt(i) === byte)) fail(filename, `图片 ${asset.id}.mime`, '图片内容与 PNG/JPEG 格式不一致');
}

export function validatePack(pack, filename = '战术包') {
  structure('pack', pack, filename);
  const lessons = unique(pack.lessons, filename, 'lessons');
  unique(pack.sections, filename, 'sections');
  const assets = unique(pack.assets || [], filename, 'assets');
  for (const asset of pack.assets || []) validateAsset(asset, filename);
  const listed = new Set();
  for (const section of pack.sections) {
    for (const id of section.lessonIds) {
      requireRef(lessons, id, filename, `章节 ${section.id}.lessonIds`, '战术');
      if (listed.has(id)) fail(filename, 'sections', `战术 ${id} 在目录出现多次`);
      listed.add(id);
    }
  }
  const warnings = [];
  for (const lesson of pack.lessons) {
    if (!listed.has(lesson.id)) fail(filename, 'sections', `战术 ${lesson.id} 未出现在目录中`);
    lessonSemantics(lesson, `${filename} / ${lesson.title.zh}（${lesson.id}）`);
    const reference = lesson.source?.referenceAsset;
    if (reference && !assets.has(reference)) warnings.push(`${lesson.title.zh}：原页图片 ${reference} 不在包内，对照不可用；站位和路线仍可使用。`);
  }
  return { pack, warnings };
}

export function validateCatalog(catalog, lessonsByFile, filename = '目录') {
  structure('catalog', catalog, filename);
  unique(catalog.sections, filename, 'sections');
  const entries = catalog.sections.flatMap(section => section.entries);
  unique(entries, filename, 'entries');
  const paths = new Set();
  for (const entry of entries) {
    if (paths.has(entry.file)) fail(filename, 'entries.file', `文件 ${entry.file} 被重复引用`);
    paths.add(entry.file);
    if (lessonsByFile !== undefined) {
      const lesson = lessonsByFile instanceof Map ? lessonsByFile.get(entry.file) :
        Object.hasOwn(lessonsByFile, entry.file) ? lessonsByFile[entry.file] : undefined;
      if (!lesson) fail(filename, entry.file, '找不到目录引用的内容文件');
      validateLesson(lesson, entry.file);
      if (lesson.id !== entry.id) fail(filename, entry.file, `条目 ID 应为 ${entry.id}，实际为 ${lesson.id}`);
    }
  }
  return { catalog, warnings: [] };
}

function cloneData(value) { return JSON.parse(JSON.stringify(value)); }

function parsePack(text, filename) {
  checkedText(text, filename, LIMITS.packBytes);
  try { JSON.parse(text); } catch { fail(filename, 'JSON', '不是有效的 JSON 内容包'); }
  // JSON syntax was checked above; the YAML reader additionally rejects duplicate mapping keys.
  const pack = readYaml(text, filename);
  return validatePack(pack, filename);
}

/** Prepare a complete preview. The caller applies result.pack only after confirmation. */
export function prepareImport(currentPack, files) {
  if (!Array.isArray(files) || files.length === 0) fail('导入', '文件', '请选择至少一个文件');
  if (files.some(file => !file || typeof file.name !== 'string')) fail('导入', '文件名', '文件信息不完整');
  const packages = files.filter(file => /\.json$/i.test(file.name));
  if (packages.length) {
    if (files.length !== 1) fail('导入', '文件', '内容包须单独载入，不能与其他文件混合');
    const { pack, warnings } = parsePack(packages[0].text, packages[0].name);
    const previousIds = new Set(currentPack?.lessons?.map(lesson => lesson.id) || []);
    return { pack, added: pack.lessons.filter(lesson => !previousIds.has(lesson.id)).map(lesson => lesson.id),
      updated: pack.lessons.filter(lesson => previousIds.has(lesson.id)).map(lesson => lesson.id), warnings, mode: 'pack' };
  }
  for (const file of files) if (!/\.ya?ml$/i.test(file.name)) fail(file.name, '文件类型', '请选择 .yaml、.yml 或 .flagbook.json 文件');
  let totalBytes = 0;
  for (const file of files) {
    checkedText(file.text, file.name, LIMITS.lessonBytes);
    totalBytes += encoder.encode(file.text).length;
  }
  if (totalBytes > LIMITS.packBytes) fail('导入', '批次大小', '超过 50 MB，未导入任何内容');
  const incoming = files.map(file => parseLesson(file.text, file.name));
  const names = new Map();
  incoming.forEach((lesson, i) => {
    if (names.has(lesson.id)) fail(files[i].name, 'id', `与 ${names.get(lesson.id)} 的编号 ${lesson.id} 重复`);
    names.set(lesson.id, files[i].name);
  });
  validatePack(currentPack, '当前内容');
  const pack = cloneData(currentPack);
  const positions = new Map(pack.lessons.map((lesson, index) => [lesson.id, index]));
  const added = [];
  const updated = [];
  for (const lesson of incoming) {
    if (positions.has(lesson.id)) {
      pack.lessons[positions.get(lesson.id)] = lesson;
      updated.push(lesson.id);
    } else {
      pack.lessons.push(lesson);
      added.push(lesson.id);
    }
  }
  if (added.length) {
    let own = pack.sections.find(section => section.title === '我的战术');
    if (!own) {
      const ids = new Set(pack.sections.map(section => section.id));
      let id = 'my-plays';
      for (let suffix = 2; ids.has(id); suffix++) id = `my-plays-${suffix}`;
      own = { id, title: '我的战术', lessonIds: [] };
      pack.sections.push(own);
    }
    own.lessonIds.push(...added);
  }
  checkedText(JSON.stringify(pack), '导入后的内容包', LIMITS.packBytes);
  const { warnings } = validatePack(pack, '导入后的内容包');
  return { pack, added, updated, warnings, mode: 'lessons' };
}
