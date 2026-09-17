import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { load, JSON_SCHEMA } from 'js-yaml';
import { parseLesson, validateCatalog, validatePack } from '../app/validation.js';

const catalogPath = path.resolve(process.argv[2] || 'content/catalog.yaml');
const root = path.dirname(catalogPath);
const catalog = load(await readFile(catalogPath, 'utf8'), { schema: JSON_SCHEMA });
validateCatalog(catalog);
const byFile = {};
const lessons = [];
const sections = [];
for (const section of catalog.sections) {
  const lessonIds = [];
  for (const entry of section.entries) {
    const lesson = parseLesson(await readFile(path.join(root, entry.file), 'utf8'), entry.file);
    if (lesson.id !== entry.id) throw new Error(`${entry.file}：目录 ID ${entry.id} 与条目 ID ${lesson.id} 不一致`);
    byFile[entry.file] = lesson;
    lessons.push(lesson); lessonIds.push(lesson.id);
  }
  sections.push({ id: section.id, title: section.title, ...(section.titleEn ? {titleEn: section.titleEn} : {}), lessonIds, ...(section.groups ? { groups: section.groups } : {}) });
}
validateCatalog(catalog, byFile);
let files = [];
try { files = await readdir(path.join(root, 'assets')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const assets = [];
const references = new Set(lessons.map(lesson => lesson.source?.referenceAsset).filter(Boolean));
for (const file of files.sort()) {
  const ext = path.extname(file).toLowerCase();
  if (!['.png', '.jpg', '.jpeg'].includes(ext)) continue;
  if (!references.has(path.basename(file, ext))) continue;
  assets.push({ id: path.basename(file, ext), mime: ext === '.png' ? 'image/png' : 'image/jpeg', base64: (await readFile(path.join(root, 'assets', file))).toString('base64') });
}
const pack = { format: 'flag-playbook', version: 1, title: catalog.title, lessons, sections, assets };
const { warnings } = validatePack(pack, '默认战术包');
if (warnings.length) throw new Error(warnings.join('\n'));
const output = path.resolve(process.argv[3] || path.join(root, 'default.flagbook.json'));
await writeFile(output, JSON.stringify(pack, null, 2));
console.log(`已打包 ${lessons.length} 条内容、${sections.length} 个章节、${assets.length} 张参考图片 → ${output}`);
