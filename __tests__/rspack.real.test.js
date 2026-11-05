/**
 * Real Rspack + html-rspack-plugin builds, run in a child process (Rspack 2 is ESM-only). Rspack
 * implements webpack's plugin API, so the webpack adapter is expected to work unchanged.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { integrity, scriptTags, attr } = require('./helpers/html');

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sri-rspack-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'index.js'), 'import("./lazy.js"); console.log("main");');
  fs.writeFileSync(path.join(dir, 'src', 'lazy.js'), 'export default 1;');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function build(options = {}) {
  const out = execFileSync('node', [path.join(__dirname, 'helpers', 'rspack-build.mjs'), dir, JSON.stringify(options)], { encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

test('every emitted script tag carries the hash of the emitted bytes', () => {
  const result = build();
  expect(result.errors).toEqual([]);
  const html = fs.readFileSync(path.join(dir, 'dist', 'index.html'), 'utf8');
  const tags = scriptTags(html);
  expect(tags.length).toBeGreaterThan(0);
  for (const tag of tags) {
    const file = fs.readFileSync(path.join(dir, 'dist', attr(tag, 'src').replace(/^\//, '')));
    expect(attr(tag, 'integrity')).toBe(integrity('sha384', file));
    expect(attr(tag, 'crossorigin')).toBe('anonymous');
  }
});

test('honours options: algorithm', () => {
  build({ algorithm: 'sha512' });
  const html = fs.readFileSync(path.join(dir, 'dist', 'index.html'), 'utf8');
  expect(html).toMatch(/integrity="sha512-/);
});

test('an enforcing Integrity-Policy fails the build because the lazy chunk would be blocked', () => {
  const result = build({ integrityPolicy: true });
  expect(result.errors.join('\n')).toMatch(/chunk\(s\) are loaded at runtime without integrity/);
});
