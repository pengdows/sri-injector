/**
 * Real standalone Rolldown builds, run in a child process (Rolldown is ESM-only). Rolldown, the
 * bundler behind Vite 8, has a Rollup-compatible plugin API, so the generic Rollup plugin is
 * expected to work unchanged; these tests pin that.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { integrity } = require('./helpers/html');

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sri-rolldown-'));
  fs.writeFileSync(path.join(dir, 'main.js'), 'import("./lazy.js").then(m => m.run()); console.log("main");');
  fs.writeFileSync(path.join(dir, 'lazy.js'), 'export const run = () => console.log("lazy");');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const build = (options = {}, prefix = '/') =>
  spawnSync('node', [path.join(__dirname, 'helpers', 'rolldown-build.mjs'), dir, JSON.stringify(options), prefix], { encoding: 'utf8' });

test('hashes the entry chunk and adds an import map for the lazy chunk', () => {
  const r = build();
  expect(r.status).toBe(0);
  const { files, html } = JSON.parse(r.stdout);
  const lazyName = Object.keys(files).find(n => n.startsWith('lazy'));

  expect(html).toContain(`integrity="${integrity('sha384', files['main.js'])}"`);
  expect(html).toContain('crossorigin="anonymous"');
  const map = JSON.parse(/<script type="importmap">([^<]*)<\/script>/.exec(html)[1]);
  expect(map.integrity).toEqual({ [`/${lazyName}`]: integrity('sha384', files[lazyName]) });
  expect(html.indexOf('importmap')).toBeLessThan(html.indexOf('main.js'));
});

test('honours options: algorithm', () => {
  const { html } = JSON.parse(build({ algorithm: 'sha512' }).stdout);
  expect(html).toMatch(/integrity="sha512-/);
});

test('a missing asset fails the build', () => {
  const r = build({}, '/nope/');
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/sri-injector/);
});
