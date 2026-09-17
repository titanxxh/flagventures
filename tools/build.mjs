import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { validatePack } from '../app/validation.js';

const source = process.argv[2] || 'content/default.flagbook.json';
const destination = process.argv[3] || 'dist';
const pack = JSON.parse(await readFile(source, 'utf8'));
const result = validatePack(pack, source);
if (result.warnings.length) console.warn(result.warnings.join('\n'));
const bundle = await build({ entryPoints: ['app/main.js'], bundle: true, write: false, format: 'iife', target: ['safari16', 'chrome110'], minify: true, legalComments: 'inline' });
const html = await readFile('app/index.html', 'utf8');
const css = await readFile('app/style.css', 'utf8');
const template = await readFile('content-format/templates/new-play.yaml', 'utf8');
const runtimePackages = ['js-yaml', 'ajv', 'fast-uri', 'fast-deep-equal', 'json-schema-traverse'];
const licenses = [];
for (const name of runtimePackages) {
  const metadata = JSON.parse(await readFile(`node_modules/${name}/package.json`, 'utf8'));
  const license = await readFile(`node_modules/${name}/LICENSE`, 'utf8');
  licenses.push(`${name} ${metadata.version}\n${license}`);
}
const licenseText = licenses.join('\n\n----------------\n\n');
const scriptSafe = value => JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
const output = html.replace('/*__APP_CSS__*/', () => css)
  .replace('__BUILT_IN_DATA__', () => scriptSafe(pack))
  .replace('__TEMPLATE_DATA__', () => scriptSafe(template))
  .replace('/*__APP_JS__*/', () => `/*!\n${licenseText.replaceAll('*/', '* /')}\n*/\n` + bundle.outputFiles[0].text.replaceAll('</script', '<\\/script'));
await mkdir(destination, { recursive: true });
await writeFile(`${destination}/Flagventures.html`, output);
await writeFile(`${destination}/index.html`, output);
await writeFile(`${destination}/NFL-FLAG完整战术.flagbook.json`, JSON.stringify(pack, null, 2));
await writeFile(`${destination}/第三方开源许可.txt`, licenseText);
console.log(`已构建 ${pack.lessons.length} 个条目；HTML ${(Buffer.byteLength(output) / 1024 / 1024).toFixed(2)} MB → ${destination}`);
