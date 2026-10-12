// Builds the collapsible catalog: sections, formation groups and lesson entries, filtered by search.
import { t } from './i18n.js';
import { node, text } from './dom.js';

export const kindLabels = { route: '基础路线', formation: '静态阵型', offense: '进攻战术', run: '跑球战术', defense: '防守方案' };

export function renderCatalog(container, {pack, canonicalPack, query, currentId, expandedSections, expandedGroups}) {
  const lessons = new Map(pack.lessons.map(item => [item.id, item]));
  const fragment = document.createDocumentFragment();
  const catalogNodes = new Map();
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
      const button = node('button', { class: 'catalog-entry', 'data-lesson': item.id, 'aria-current': String(item.id === currentId), title: item.title.zh });
      const prefix = subgroup ? `${subgroup.title} · ` : '';
      const title = subgroup && item.kind === 'formation' && item.title.zh === subgroup.title ? '阵型站位' : prefix && item.title.zh.startsWith(prefix) ? item.title.zh.slice(prefix.length) : item.title.zh;
      button.append(node('strong', {}, title), node('small', {}, `${item.title.en || t(kindLabels[item.kind])}${item.source?.page ? ` · p${item.source.page}` : ''}`));
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
  container.replaceChildren(fragment);
  return catalogNodes;
}

// Scroll only the catalog list, never the page, so the selected entry stays in view.
export function revealCatalogEntry(list, entry) {
  if (!entry || !list.clientHeight) return;
  const box = entry.getBoundingClientRect(), view = list.getBoundingClientRect();
  if (box.top >= view.top && box.bottom <= view.bottom) return;
  list.scrollTop += box.top - view.top - Math.max(0, (view.height - box.height) / 3);
}
