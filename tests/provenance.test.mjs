import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {dump} from 'js-yaml';
import {getProvenance,resolveRelatedLesson,checkBuiltInProvenance} from '../app/provenance.js';
import {validateLesson,validatePack,parseLesson} from '../app/validation.js';
import {localizeLesson} from '../app/localization.js';
const pack=JSON.parse(fs.readFileSync('content/default.flagbook.json'));
const fresh=()=>structuredClone(pack.lessons.find(l=>l.id==='concept-flood'));
const cleanTranslations=l=>{delete l.translations;return l;};

test('all 71 built-ins have classified, located primary sources and explicit adaptation records',()=>{
 assert.equal(pack.lessons.length,71);
 assert.deepEqual(checkBuiltInProvenance(pack),[]);
 for(const l of pack.lessons){
  const p=getProvenance(l);assert.equal(p.pending,false,l.id);assert.ok(p.adaptation,l.id);
  assert.equal(p.unclassified.length,0,l.id);
  for(const r of p.primary){assert.ok(r.publisher&&r.locator&&r.scope,l.id);assert.ok(['diagram','explanation','concept'].includes(r.kind));}
 }
 // These were the gaps in the old library; general training links cannot fill them.
 for(const l of pack.lessons.filter(l=>['formation','run','defense'].includes(l.kind))){
  assert.ok(getProvenance(l).primary.some(r=>r.kind==='diagram'&&r.url.endsWith(`#page=${l.source.page}`)),l.id);
 }
});

test('legacy unknown sources, explicit self-authorship and adaptation are independent',()=>{
 const l=cleanTranslations(fresh());delete l.source;delete l.relatedLessons;validateLesson(l);
 assert.equal(getProvenance(l).pending,true);assert.equal(getProvenance(l).authored,false);
 l.source={title:'Legacy note',references:[{title:'Old reference',url:'https://example.org/old'}]};validateLesson(l);
 assert.equal(getProvenance(l).unclassified.length,1);assert.equal(getProvenance(l).pending,true);
 l.source.authorship='self-authored';l.source.adaptation='My teaching choices';validateLesson(l);
 assert.equal(getProvenance(l).pending,false);assert.equal(getProvenance(l).authored,true);assert.ok(getProvenance(l).adaptation);
 l.source.references=fresh().source.references;validateLesson(l);
 assert.equal(getProvenance(l).primary.length,1);assert.equal(getProvenance(l).authored,true);
});

test('primary metadata is required without breaking legacy references; known unavailable remains playable',()=>{
 for(const key of ['publisher','locator','scope','kind']){
  const l=cleanTranslations(fresh());delete l.source.references[0][key];assert.throws(()=>validateLesson(l),undefined,key);
 }
 const l=cleanTranslations(fresh());l.source.references[0].kind='rules';assert.throws(()=>validateLesson(l));
 l.source.references[0].kind='concept';l.source.references[0].availability='unavailable';validateLesson(l);
 assert.equal(getProvenance(l).primary.length,1);
 assert.ok(checkBuiltInProvenance({lessons:[l]}).some(e=>e.includes('原始出处')));
 l.source.references[0].url='javascript:alert(1)';assert.throws(()=>validateLesson(l));
});

test('related plays resolve only in the current pack with the expected primary source',()=>{
 const l=fresh(),r=l.relatedLessons[0];assert.equal(resolveRelatedLesson(pack,r).id,'single-set-play-2');
 assert.equal(resolveRelatedLesson({lessons:[l]},r),undefined);
 const unrelated=structuredClone(pack.lessons.find(x=>x.id===r.id));unrelated.source.references=[];
 assert.equal(resolveRelatedLesson({lessons:[unrelated]},r),undefined);
 unrelated.source.references=[{url:r.sourceUrl,role:'supporting'}];assert.equal(resolveRelatedLesson({lessons:[unrelated]},r),undefined);
 const invalid=cleanTranslations(l);invalid.relatedLessons[0].sourceUrl='data:text/html,unsafe';assert.throws(()=>validateLesson(invalid));
 invalid.relatedLessons[0].sourceUrl=r.sourceUrl;invalid.relatedLessons[0].id=l.id;assert.throws(()=>validateLesson(invalid));
});

test('YAML, JSON and English preserve all citation identities and related-play links',()=>{
 for(const l of pack.lessons){
  assert.deepEqual(parseLesson(dump(l),'roundtrip.yaml'),l);
  const en=localizeLesson(l,'en');
  assert.deepEqual(en.source.references.map(r=>[r.url,r.role,r.kind,r.availability]),l.source.references.map(r=>[r.url,r.role,r.kind,r.availability]));
  assert.deepEqual(en.relatedLessons?.map(r=>[r.id,r.sourceUrl]),l.relatedLessons?.map(r=>[r.id,r.sourceUrl]));
 }
 const roundtrip=JSON.parse(JSON.stringify(pack));validatePack(roundtrip);assert.deepEqual(roundtrip,pack);
});
