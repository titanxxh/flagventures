import english from './locales/en.json' with {type: 'json'};
let language = 'zh';
export const getLanguage = () => language;
export function setLanguage(value) { language = value === 'en' ? 'en' : 'zh'; }
export function t(value, ...args) {
  const key = Array.isArray(value) ? value.reduce((result, part, i) => result + (i ? `{${i - 1}}` : '') + part, '') : String(value ?? '');
  const result = language === 'en' ? english[key] ?? key : key;
  return result.replace(/\{(\d+)\}/g, (match, index) => index < args.length ? t(args[index]) : match);
}
export function captureStaticTranslations(root) {
  const texts = [], attributes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.parentElement?.closest('script,style') && /[\u3400-\u9fff]/u.test(node.textContent)) texts.push([node, node.textContent]);
  }
  for (const node of root.querySelectorAll('[aria-label],[placeholder],[alt],meta[name="description"]')) {
    for (const key of ['aria-label','placeholder','alt','content']) if (node.hasAttribute(key)) attributes.push([node,key,node.getAttribute(key)]);
  }
  return () => {
    for (const [node, original] of texts) if (node.isConnected) node.textContent = original.replace(original.trim(), t(original.trim()));
    for (const [node, key, original] of attributes) node.setAttribute(key, t(original));
    document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN';
    document.title = t('Flagventures · 一起看懂跑位');
  };
}
