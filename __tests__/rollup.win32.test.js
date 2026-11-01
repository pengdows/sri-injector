/**
 * Simulates Windows path semantics for the rollup adapter's publicDir fallback.
 *
 * On POSIX, any path that survives the bundle-root check cannot escape publicDir, so the
 * publicDir guard is unreachable there. On Windows, "\" is a separator that
 * path.posix.normalize() does not understand, so a URL like "/..\secret.txt" passes the
 * bundle-root check and only the publicDir guard stands between it and a read outside the
 * directory. Mocking `path` with `path.win32` lets us exercise that guard on any platform.
 */
jest.mock('path', () => jest.requireActual('path').win32);

const fs = require('fs');
const path = require('path');
const sriPlugin = require('../adapters/rollup');

const PUBLIC_DIR = 'C:\\site\\public';

async function runWithPublicDir(html) {
  const plugin = sriPlugin({ algorithm: 'sha256', publicDir: PUBLIC_DIR });
  const warnings = [];
  const self = { error: (m) => { throw new Error(m); }, warn: (m) => warnings.push(m) };
  const bundle = { 'index.html': { type: 'asset', fileName: 'index.html', source: html } };
  await plugin.generateBundle.handler.call(self, {}, bundle);
  return { html: bundle['index.html'].source, warnings };
}

let reads;
let spy;
beforeEach(() => {
  reads = [];
  spy = jest.spyOn(fs, 'readFileSync').mockImplementation((p) => { reads.push(String(p)); return Buffer.from('content'); });
});
afterEach(() => spy.mockRestore());

test('sanity: the mock is in effect', () => {
  expect(path.sep).toBe('\\');
  expect(path.resolve(PUBLIC_DIR, '..\\x')).toBe('C:\\site\\x');
});

test('backslash traversal that passes the bundle-root check is stopped by the publicDir guard', async () => {
  const { html, warnings } = await runWithPublicDir(
    '<html><head><script src="/..\\secret.txt"></script><script src="/assets\\..\\..\\secret.txt"></script></head></html>'
  );
  expect(reads).toEqual([]);
  expect(html).not.toContain('integrity=');
  expect(warnings.join('\n')).toMatch(/secret\.txt.*could not be found/);
});

test('a publicDir file named "..foo.js" is still read under Windows separators', async () => {
  const { html } = await runWithPublicDir('<html><head><script src="/..foo.js"></script></head></html>');
  expect(reads).toEqual(['C:\\site\\public\\..foo.js']);
  expect(html).toContain('integrity="sha256-');
});
