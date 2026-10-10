import {readFile, writeFile, mkdir, rm, copyFile} from 'node:fs/promises';
import {analyze} from '../src/analyze.js';
import {html} from '../src/render.js';
import {copyScript} from '../src/copy.js';

const output = new URL('../.site-dist/', import.meta.url);
await rm(output, {recursive: true, force: true});
await mkdir(output, {recursive: true});
for (const name of ['index.html', 'style.css']) await copyFile(new URL('../site/' + name, import.meta.url), new URL(name, output));
await copyFile(new URL('../docs/pr-check-demo.jpg', import.meta.url), new URL('demo.jpg', output));
const snapshot = JSON.parse(await readFile(new URL('../examples/path-filter.json', import.meta.url), 'utf8'));
await writeFile(new URL('sample-report.html', output), html(analyze(snapshot), {example: true}));
await writeFile(new URL('copy.js', output), copyScript);
await writeFile(new URL('.nojekyll', output), '');
await writeFile(new URL('sitemap.xml', output), '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://builtbysharath.github.io/gh-pr-check-explainer/</loc></url></urlset>\n');
console.log('Static project site: .site-dist/');
