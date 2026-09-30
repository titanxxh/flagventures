// Only presentation fields may be translated. IDs, routes and timing stay shared.
export function translationFields(lesson) {
  const fields = new Map();
  const add = (path, value) => { if (typeof value === 'string') fields.set(path, value); };
  const texts = (prefix, value, keys) => keys.forEach(key => add(`${prefix}.${key}`, value?.[key]));
  add('title.zh', lesson.title.zh); add('summary', lesson.summary);
  texts('teaching', lesson.teaching, ['goal', 'cooperation', 'cue', 'question']);
  texts('source', lesson.source, ['title', 'note', 'adaptation']);
  lesson.source?.references?.forEach((ref, i) => texts(`source.references.${i}`, ref, ['title', 'locator', 'note', 'publisher', 'scope']));
  lesson.relatedLessons?.forEach(ref => texts(`relatedLessons.${ref.id}`, ref, ['title', 'note']));
  texts('timeline', lesson.timeline, ['note']);
  texts('routeGuide', lesson.routeGuide, ['note']);
  lesson.routeGuide?.marks.forEach(mark => texts(`routeGuide.marks.${mark.id}`, mark, ['label', 'note']));
  texts('ball', lesson.ball, ['note']);
  lesson.ball?.scenarios.forEach(scenario => {
    const prefix = `ball.scenarios.${scenario.id}`;
    texts(prefix, scenario, ['title', 'note']);
    scenario.events.forEach(event => texts(`${prefix}.events.${event.id}`, event, ['label', 'cue', 'endLabel', 'endCue']));
    scenario.motions?.forEach(override => {
      const motionPrefix = `${prefix}.motions.${override.player}.motion`;
      texts(motionPrefix, override.motion, ['note', 'prompt']);
      override.motion.options?.forEach(option => texts(`${motionPrefix}.options.${option.id}`, option, ['title', 'note']));
    });
  });
  lesson.notes?.forEach((note, i) => add(`notes.${i}`, note));
  for (const player of lesson.players) {
    const prefix = `players.${player.id}`;
    texts(prefix, player, ['name']);
    texts(`${prefix}.label`, player.label, ['zh', 'description', 'note']);
    texts(`${prefix}.coaching`, player.coaching, ['cooperation', 'timing']);
    texts(`${prefix}.motion`, player.motion, ['note', 'prompt']);
    player.motion.options?.forEach(option => texts(`${prefix}.motion.options.${option.id}`, option, ['title', 'note']));
  }
  lesson.keyframes.forEach(frame => texts(`keyframes.${frame.id}`, frame, ['label', 'cue']));
  lesson.zones?.forEach(zone => add(`zones.${zone.id}.label`, zone.label));
  return fields;
}

export function localizeLesson(lesson, language) {
  if (language !== 'en') return lesson;
  const translations = lesson.translations?.en || {};
  const allowed = translationFields(lesson);
  function visit(value, path = '') {
    if (typeof value === 'string') return allowed.has(path) ? translations[path] ?? value : value;
    if (Array.isArray(value)) return value.map((item, index) => visit(item,
      `${path}.${item?.id ?? (path.endsWith('.motions') ? item?.player : undefined) ?? index}`));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) =>
      [key, key === 'translations' ? child : visit(child, path ? `${path}.${key}` : key)]));
    return value;
  }
  const result = visit(lesson);
  result.title.zh = translations['title.zh'] || lesson.title.en || lesson.title.zh;
  return result;
}

export function localizePack(pack, language, translate = value => value) {
  if (language !== 'en') return pack;
  return {...pack, lessons: pack.lessons.map(lesson => localizeLesson(lesson, language)),
    sections: pack.sections.map(section => ({...section, title: section.titleEn || translate(section.title),
      ...(section.groups ? {groups: section.groups.map(group => ({...group, title: group.titleEn || translate(group.title)}))} : {})}))};
}
