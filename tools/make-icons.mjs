// Renders the app icons (PNG) from the flag mark used by the favicon. Run by hand after
// changing the mark: `node tools/make-icons.mjs`. The PNGs are committed under app/icons.
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const flag = '<path d="M12 30V9l18 6-18 6" fill="#ebc575" stroke="#ebc575" stroke-width="3" stroke-linejoin="round"/>';
// Rounded tile for browsers; full-bleed square (content in the safe zone) for maskable and iOS icons.
const rounded = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="9" fill="#193d32"/>${flag}</svg>`;
const fullBleed = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="#193d32"/><g transform="translate(20 20) scale(.72) translate(-20 -19.5)">${flag}</g></svg>`;
const icons = [['icon-192.png', 192, rounded], ['icon-512.png', 512, rounded], ['icon-maskable-512.png', 512, fullBleed], ['apple-touch-icon.png', 180, fullBleed]];

await mkdir('app/icons', { recursive: true });
const browser = await chromium.launch(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : { channel: 'chrome' });
for (const [name, size, markup] of icons) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${markup}`);
  await page.screenshot({ path: `app/icons/${name}`, omitBackground: true });
  await page.close();
}
await browser.close();
console.log(`Wrote ${icons.length} icons to app/icons`);
