import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {localizeLesson, localizePack, translationFields} from '../app/localization.js';
import {setLanguage,t} from '../app/i18n.js';
import {validateLesson} from '../app/validation.js';
import {getScene,getRoutes} from '../app/scene.js';
const pack=JSON.parse(readFileSync('content/default.flagbook.json','utf8'));
test('all 64 lessons translate every display field without changing routes, timing or canonical data',()=>{
 const before=JSON.stringify(pack);
 for(const lesson of pack.lessons){
  const en=localizeLesson(lesson,'en');
  for(const [path,value] of translationFields(en)){
   assert.ok(lesson.translations.en[path],`${lesson.id}: missing ${path}`);
   assert.doesNotMatch(value,/[\u3400-\u9fff]/u,`${lesson.id}: ${path}`);
  }
  const choices=Object.fromEntries(lesson.players.filter(p=>p.motion.type==='choice').map(p=>[p.id,p.motion.options[0].id]));
  assert.deepEqual(getRoutes(en,choices),getRoutes(lesson,choices));
  for(const at of [0,2,5,10]){
   const positions=l=>getScene(l,at,choices).players.map(p=>[p.id,p.position]);
   assert.deepEqual(positions(en),positions(lesson));
  }
 }
 assert.equal(JSON.stringify(pack),before);
 const en=localizePack(pack,'en',t);assert.ok(en.sections.every(s=>s.title===s.titleEn));
});
test('custom lessons can omit English; only presentation fields accept translation',()=>{
 const lesson=structuredClone(pack.lessons[0]);delete lesson.translations;
 assert.equal(localizeLesson(lesson,'en').summary,lesson.summary);
 lesson.translations={en:{summary:'Custom text'}};validateLesson(lesson);
 assert.equal(localizeLesson(lesson,'en').summary,'Custom text');
 lesson.translations.en['players.X.at']='bad';assert.throws(()=>validateLesson(lesson),/展示文字/);
});
test('UI interpolation and import validation use selected language',()=>{
 setLanguage('en');
 try{assert.equal(t`${64} 个教学条目 · 本地可用`,'64 lessons · Available offline');
 const lesson=structuredClone(pack.lessons[0]);delete lesson.title;
 assert.throws(()=>validateLesson(lesson,'bad.yaml'),/Required field is missing/);
 }finally{setLanguage('zh');}
 assert.equal(t`${64} 个教学条目 · 本地可用`,'64 个教学条目 · 本地可用');
});
