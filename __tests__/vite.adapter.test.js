/**
 * The Vite wrapper around the generic Rollup plugin: it learns `base` and `publicDir` from Vite's
 * resolved config, runs last, and sets the Integrity-Policy header on the preview server.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const sriVite = require('../adapters/vite');
const sriRollup = require('../adapters/rollup');

const { integrity } = require('./helpers/html');

const sha = (c) => integrity('sha256', c);
const self = (warnings = []) => ({ error: (m) => { throw new Error(m); }, warn: (m) => warnings.push(m), info: () => {}, emitFile: () => {} });
const generate = (plugin, bundle) => plugin.generateBundle.handler.call(self(), {}, bundle);

test('runs after other plugins', () => {
  expect(sriVite().enforce).toBe('post');
});

test('is a different entry from the generic Rollup plugin: only the Vite one has Vite hooks', () => {
  expect(sriVite().configResolved).toBeInstanceOf(Function);
  expect(sriRollup().configResolved).toBeUndefined();
  expect(sriRollup().config).toBeUndefined();
  expect(sriRollup().enforce).toBeUndefined();
});

test('takes base from Vite\'s resolved config', async () => {
  const plugin = sriVite({ algorithm: 'sha256', strict: true });
  plugin.configResolved({ base: '/app/' });
  const bundle = {
    'index.html': { type: 'asset', source: '<html><head><script src="/app/assets/a.js"></script></head></html>' },
    'assets/a.js': { type: 'chunk', code: 'x' },
  };
  await generate(plugin, bundle);
  expect(bundle['index.html'].source).toContain(`integrity="${sha('x')}"`);
});

test('takes a CDN base from Vite\'s resolved config', async () => {
  const plugin = sriVite({ algorithm: 'sha256', strict: true });
  plugin.configResolved({ base: 'https://cdn.example.com/' });
  const bundle = {
    'index.html': { type: 'asset', source: '<html><head><script src="https://cdn.example.com/assets/a.js"></script></head></html>' },
    'assets/a.js': { type: 'chunk', code: 'x' },
  };
  await generate(plugin, bundle);
  expect(bundle['index.html'].source).toContain('integrity="sha256-');
});

test('an explicit base option wins over Vite\'s', async () => {
  const plugin = sriVite({ algorithm: 'sha256', base: '/mine/' });
  plugin.configResolved({ base: '/vite/' });
  const bundle = {
    'index.html': { type: 'asset', source: '<html><head><script src="/mine/a.js"></script></head></html>' },
    'a.js': { type: 'chunk', code: 'x' },
  };
  await generate(plugin, bundle);
  expect(bundle['index.html'].source).toContain('integrity="sha256-');
});

test('takes publicDir from Vite\'s resolved config', async () => {
  const publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sri-vpub-'));
  try {
    fs.writeFileSync(path.join(publicDir, 'legacy.js'), 'pub');
    const plugin = sriVite({ algorithm: 'sha256', strict: true });
    plugin.configResolved({ base: '/', publicDir });
    const bundle = { 'index.html': { type: 'asset', source: '<html><head><script src="/legacy.js"></script></head></html>' } };
    await generate(plugin, bundle);
    expect(bundle['index.html'].source).toContain(`integrity="${sha('pub')}"`);
  } finally {
    fs.rmSync(publicDir, { recursive: true, force: true });
  }
});

describe('Integrity-Policy on the preview server', () => {
  test('is set on the preview server only (dev serves unhashed source modules)', () => {
    expect(sriVite({ integrityPolicy: true }).config({})).toEqual({
      preview: { headers: { 'Integrity-Policy': 'blocked-destinations=(script), sources=(inline)' } },
    });
  });

  test('report-only uses the report-only header name', () => {
    expect(Object.keys(sriVite({ integrityPolicy: 'report-only' }).config({}).preview.headers)).toEqual(['Integrity-Policy-Report-Only']);
  });

  test('no config hook output when the policy is off', () => {
    expect(sriVite().config({})).toBeUndefined();
  });
});

test('the same option rules apply: unknown options are rejected', () => {
  expect(() => sriVite({ strcit: true })).toThrow(/Unknown option "strcit"/);
});
