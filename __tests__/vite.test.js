/**
 * Real Vite builds (Vite 8), including @vitejs/plugin-legacy, which builds its legacy chunks in a
 * separate output pass before the HTML pass. Run in a child process because Vite is ESM-only.
 */
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HELPER = path.join(__dirname, 'helpers', 'vite-build.mjs');
const sha384 = (bytes) => 'sha384-' + crypto.createHash('sha384').update(bytes).digest('base64');

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sri-vite-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><html><head><script type="module" src="/src/main.js"></script></head><body></body></html>');
  fs.writeFileSync(path.join(root, 'src', 'main.js'), 'import("./lazy.js").then(m => m.run()); console.log("main");');
  fs.writeFileSync(path.join(root, 'src', 'lazy.js'), 'export const run = () => console.log("lazy");');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const build = (mode) => {
  const r = spawnSync(process.execPath, [HELPER, root, mode], { encoding: 'utf8', timeout: 90000 });
  return { code: r.status, out: r.stdout + r.stderr };
};
const dist = (...p) => path.join(root, 'dist', ...p);
const tags = (html) => [...html.matchAll(/<script[^>]*>/g)].map(m => m[0]);
const attr = (tag, name) => (new RegExp(`${name}="?([^" >]*)"?`).exec(tag) || [])[1];

jest.setTimeout(120000);

test('plain build: entry script is hashed from the emitted file and lazy chunk is in the import map', () => {
  const r = build('plain');
  expect(r.code).toBe(0);
  const html = fs.readFileSync(dist('index.html'), 'utf8');
  const entry = tags(html).find(t => /src=/.test(t));
  expect(attr(entry, 'integrity')).toBe(sha384(fs.readFileSync(dist(attr(entry, 'src').replace(/^\//, '')))));
  expect(html).toMatch(/<script type="importmap">\{"integrity":\{"\/assets\/lazy-[^"]+\.js":"sha384-/);
});

test('with @vitejs/plugin-legacy and strict: the build succeeds and the legacy polyfill script is hashed', () => {
  const r = build('legacy');
  expect(r.out).not.toMatch(/No HTML files/);
  expect(r.out).not.toMatch(/could not be found/);
  expect(r.code).toBe(0);

  const html = fs.readFileSync(dist('index.html'), 'utf8');
  const polyfill = tags(html).find(t => /vite-legacy-polyfill/.test(t));
  expect(polyfill).toBeDefined();
  const file = attr(polyfill, 'src').replace(/^\//, '');
  expect(attr(polyfill, 'integrity')).toBe(sha384(fs.readFileSync(dist(file))));
  // the modern entry is still hashed too
  const modern = tags(html).find(t => /type="?module"?/.test(t) && /src=/.test(t));
  expect(attr(modern, 'integrity')).toMatch(/^sha384-/);
});

test('a build with no HTML at all (library mode) fails under strict', () => {
  fs.rmSync(path.join(root, 'index.html'));
  const r = build('lib');
  expect(r.code).toBe(1);
  expect(r.out).toMatch(/No HTML files/);
});
