const crypto = require('crypto');
const sriPlugin = require('../adapters/rollup');

const sha = (c) => 'sha256-' + crypto.createHash('sha256').update(c).digest('base64');

async function run(bundle, opts = {}, ctx = {}) {
  const plugin = sriPlugin({ algorithm: 'sha256', ...opts });
  const warnings = [];
  const self = { error: (m) => { throw new Error(m); }, warn: (m) => warnings.push(m) };
  if (plugin.configResolved && ctx.config) plugin.configResolved(ctx.config);
  await plugin.generateBundle.handler.call(self, {}, bundle);
  return warnings;
}

const makeBundle = (html) => ({
  'index.html': { type: 'asset', fileName: 'index.html', source: html },
  'assets/app-abc.js': { type: 'chunk', fileName: 'assets/app-abc.js', code: 'console.log(1)' },
  'assets/app-abc.css': { type: 'asset', fileName: 'assets/app-abc.css', source: 'a{b:c}' },
});

test('hashes chunk code and asset source from the in-memory bundle', async () => {
  const b = makeBundle('<html><head><script type="module" src="/assets/app-abc.js"></script><link rel="stylesheet" href="/assets/app-abc.css"></head></html>');
  await run(b);
  expect(b['index.html'].source).toContain(`integrity="${sha('console.log(1)')}"`);
  expect(b['index.html'].source).toContain(`integrity="${sha('a{b:c}')}"`);
  expect(b['index.html'].source).toMatch(/<script [^>]*><\/script>/);
});

test('strips a non-root public base', async () => {
  const b = makeBundle('<html><head><script src="/app/assets/app-abc.js"></script></head></html>');
  await run(b, { base: '/app/' });
  expect(b['index.html'].source).toContain('integrity="sha256-');
});

test('hashes modulepreload links', async () => {
  const b = makeBundle('<html><head><link rel="modulepreload" href="/assets/app-abc.js"></head></html>');
  await run(b);
  expect(b['index.html'].source).toContain('integrity="sha256-');
});

test('strict fails the build on a missing resource; default warns', async () => {
  const html = '<html><head><script src="/assets/missing.js"></script></head></html>';
  await expect(run(makeBundle(html), { strict: true })).rejects.toThrow(/missing\.js/);
  const warnings = await run(makeBundle(html));
  expect(warnings.join()).toMatch(/missing\.js/);
});
