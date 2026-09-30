/** Provenance is authored data, never inferred from a domain or network response. */
export function getProvenance(lesson) {
  const source = lesson?.source;
  const references = source?.references || [];
  const primary = references.filter(reference => reference.role === 'primary');
  return {
    primary,
    supporting: references.filter(reference => reference.role === 'supporting'),
    unclassified: references.filter(reference => !reference.role),
    authored: source?.authorship === 'self-authored',
    pending: source?.authorship !== 'self-authored' && primary.length === 0,
    adaptation: source?.adaptation,
  };
}

/** Resolve only within the current pack and only against the expected source.
 * An imported, unrelated lesson may reuse a built-in ID. Never jump to it.
 */
export function resolveRelatedLesson(pack, reference) {
  return pack.lessons.find(lesson => lesson.id === reference.id
    && lesson.source?.references?.some(source => source.role === 'primary'
      && source.url === reference.sourceUrl));
}

/** Release gate for our maintained library. Older and self-authored imports
 * remain valid under the general format validator.
 * This checks the record, not whether its source is factually correct or live.
 */
export function checkBuiltInProvenance(pack) {
  const errors = [];
  for (const lesson of pack.lessons) {
    const {primary, adaptation} = getProvenance(lesson);
    if (!primary.some(source => source.availability !== 'unavailable')) {
      errors.push(`${lesson.id}: 缺少可用的原始出处记录`);
    }
    if ((lesson.timeline.basis === 'illustration' || lesson.ball?.scenarios.some(s => s.basis === 'illustration')) && !adaptation) {
      errors.push(`${lesson.id}: 缺少教学改编说明`);
    }
    for (const reference of lesson.relatedLessons || []) {
      if (!resolveRelatedLesson(pack, reference)) errors.push(`${lesson.id}: 相近配合 ${reference.id} 的出处不匹配`);
    }
  }
  return errors;
}
