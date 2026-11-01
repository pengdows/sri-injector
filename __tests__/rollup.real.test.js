/**
 * Real Rollup builds (not mock bundles), using the exact setup the README documents:
 * @rollup/plugin-html emits the page and this plugin is listed last.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { rollup } = require('rollup');
const html = require('@rollup/plugin-html');
const sri = require('../adapters/rollup');
const { integrity } = require('./helpers/html');

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sri-rollup-'));
  fs.writeFileSync(path.join(dir, 'main.js'), 'import("./lazy.js").then(m => m.run()); console.log("main");');
  fs.writeFileSync(path.join(dir, 'lazy.js'), 'export const run = () => console.log("lazy");');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const sha = integrity;

async function build({ sriOptions = {}, htmlOptions = {}, sriFirst = false } = {}) {
  const warnings = [];
  const plugins = sriFirst
    ? [sri({ algorithm: 'sha384', ...sriOptions }), html(htmlOptions)]
    : [html(htmlOptions), sri({ algorithm: 'sha384', ...sriOptions })];
  const bundle = await rollup({ input: path.join(dir, 'main.js'), plugins, onwarn: (w) => warnings.push(w.message) });
  const { output } = await bundle.generate({ dir: path.join(dir, 'dist'), format: 'es', entryFileNames: '[name]-[hash].js', chunkFileNames: '[name]-[hash].js' });
  await bundle.close();
  const byName = Object.fromEntries(output.map(o => [o.fileName, o]));
  const page = output.find(o => o.fileName.endsWith('.html'));
  return { output, byName, page: page && String(page.source), warnings };
}

test('hashes the entry chunk emitted into the page and adds an import map for the lazy chunk', async () => {
  const r = await build();
  const entry = r.output.find(o => o.type === 'chunk' && o.isEntry);
  const lazy = r.output.find(o => o.type === 'chunk' && !o.isEntry);

  expect(r.page).toContain(`src="${entry.fileName}"`);
  expect(r.page).toContain(`integrity="${sha('sha384', entry.code)}"`);
  expect(r.page).toContain('crossorigin="anonymous"');
  expect(r.page).toMatch(/<script [^>]*><\/script>/); // not self-closed

  const map = JSON.parse(/<script type="importmap">([^<]*)<\/script>/.exec(r.page)[1]);
  expect(Object.values(map.integrity)).toEqual([sha('sha384', lazy.code)]);
  expect(Object.keys(map.integrity)[0]).toContain(lazy.fileName);
  // the import map must precede the first module script
  expect(r.page.indexOf('importmap')).toBeLessThan(r.page.indexOf(entry.fileName));
});

test('works regardless of plugin order, because it runs in the post generateBundle phase', async () => {
  const r = await build({ sriFirst: true });
  expect(r.page).toMatch(/integrity="sha384-/);
});

test('with a publicPath, URLs and import-map keys carry it', async () => {
  const r = await build({ htmlOptions: { publicPath: '/app/' }, sriOptions: { base: '/app/' } });
  expect(r.page).toMatch(/src="\/app\/main-/);
  expect(r.page).toMatch(/"\/app\/lazy-[^"]+\.js"/);
  expect(r.warnings).toEqual([]);
});

test('a CDN publicPath is treated as local', async () => {
  const r = await build({ htmlOptions: { publicPath: 'https://cdn.example.com/' }, sriOptions: { base: 'https://cdn.example.com/' } });
  const tag = /<script [^>]*src="https:\/\/cdn\.example\.com\/main-[^"]+"[^>]*>/.exec(r.page)[0];
  expect(tag).toMatch(/integrity="sha384-/);
  expect(r.page).toMatch(/"https:\/\/cdn\.example\.com\/lazy-[^"]+\.js":"sha384-/);
});

test('strict fails the build when the bundle contains no HTML', async () => {
  const bundle = await rollup({ input: path.join(dir, 'main.js'), plugins: [sri({ strict: true })] });
  await bundle.generate({ dir: path.join(dir, 'dist'), format: 'es' });
  await expect(bundle.close()).rejects.toThrow(/No HTML files/);
});

test('importMap: false leaves lazy chunks out of the page', async () => {
  const r = await build({ sriOptions: { importMap: false } });
  expect(r.page).not.toContain('importmap');
});
