// Small DOM helpers. Text passes through t() so static Chinese strings follow the selected language.
import { t } from './i18n.js';

const NS = 'http://www.w3.org/2000/svg';
export const $ = id => document.getElementById(id);
export function text(node, value) { value = t(value); if (node.textContent !== String(value ?? '')) node.textContent = value ?? ''; }
function create(element, attributes, value) {
  for (const [key, val] of Object.entries(attributes)) element.setAttribute(key, ['aria-label', 'title'].includes(key) ? t(val) : val);
  if (value !== undefined) element.textContent = t(value);
  return element;
}
export function node(tag, attributes = {}, value) { return create(document.createElement(tag), attributes, value); }
export function svg(tag, attributes = {}, value) { return create(document.createElementNS(NS, tag), attributes, value); }
