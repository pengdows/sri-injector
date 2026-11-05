/**
 * Real Rollup builds with @web/rollup-plugin-html (Modern Web), which takes an HTML file as the
 * entry point and emits rewritten HTML. The generic Rollup plugin must hash what it emits.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { rollup } = require('rollup');
const { rollupPluginHTML } = require('@web/rollup-plugin-html');
const sri = require('../adapters/rollup');
const { integrity } = require('./helpers/html');

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sri-webhtml-'));
  fs.writeFileSync(path.join(dir, 'index.html'),
    '<html><head><link rel="stylesheet" href="./a.css"></head><body><script type="module" src="./main.js"></script></body></html>');
  fs.writeFileSync(path.join(dir, 'a.css'), 'body { color: red }');
  fs.writeFileSync(path.join(dir, 'main.js'), 'import("./lazy.js").then(m => m.run());');
  fs.writeFileSync(path.join(dir, 'lazy.js'), 'export const run = () => 1;');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

async function build(sriOptions = {}) {
  const bundle = await rollup({
    input: path.join(dir, 'index.html'),
    plugins: [rollupPluginHTML({ rootDir: dir }), sri(sriOptions)],
  });
  const { output } = await bundle.generate({ dir: path.join(dir, 'dist'), format: 'es' });
  await bundle.close();
  return { output, html: String(output.find(o => o.fileName === 'index.html').source) };
}

test('hashes the module script, the stylesheet and the lazy chunk', async () => {
  const { output, html } = await build();
  const byName = Object.fromEntries(output.map(o => [o.fileName, o]));
  const css = output.find(o => o.fileName.endsWith('.css'));
  const lazy = output.find(o => o.type === 'chunk' && !o.isEntry);

  expect(html).toContain(`href="${css.fileName}" integrity="${integrity('sha384', css.source)}"`);
  expect(html).toContain(`integrity="${integrity('sha384', byName['main.js'].code)}"`);
  const map = JSON.parse(/<script type="importmap">([^<]*)<\/script>/.exec(html)[1]);
  expect(Object.values(map.integrity)).toEqual([integrity('sha384', lazy.code)]);
});

test('is idempotent: running the plugin twice gives the same page', async () => {
  const once = await build();
  const bundle = await rollup({
    input: path.join(dir, 'index.html'),
    plugins: [rollupPluginHTML({ rootDir: dir }), sri(), sri()],
  });
  const { output } = await bundle.generate({ dir: path.join(dir, 'dist'), format: 'es' });
  await bundle.close();
  expect(String(output.find(o => o.fileName === 'index.html').source)).toBe(once.html);
});
