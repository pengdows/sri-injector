const crypto = require('crypto');
const sriPlugin = require('../adapters/rollup');

const sha = (c) => 'sha256-' + crypto.createHash('sha256').update(c).digest('base64');

async function run(bundle, opts = {}, ctx = {}) {
  const plugin = sriPlugin({ algorithm: 'sha256', ...opts });
  const warnings = [];
  const emitted = ctx.emitted || [];
  const infos = ctx.infos || [];
  const self = {
    error: (m) => { throw new Error(m); },
    warn: (m) => warnings.push(m),
    info: (m) => infos.push(m),
    emitFile: (f) => { emitted.push(f); bundle[f.fileName] = { type: 'asset', fileName: f.fileName, source: f.source }; },
  };
  if (plugin.configResolved && ctx.config) plugin.configResolved(ctx.config);
  await plugin.generateBundle.handler.call(self, {}, bundle);
  if (plugin.closeBundle) await plugin.closeBundle.call(self);
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

describe('bundle with no HTML', () => {
  const noHtmlBundle = () => ({
    'assets/app-abc.js': { type: 'chunk', fileName: 'assets/app-abc.js', code: 'console.log(1)' },
  });

  test('strict fails the build', async () => {
    await expect(run(noHtmlBundle(), { strict: true })).rejects.toThrow(/No HTML/i);
  });

  test('default warns and leaves the bundle untouched', async () => {
    const b = noHtmlBundle();
    const warnings = await run(b);
    expect(warnings.join()).toMatch(/No HTML/i);
    expect(b['assets/app-abc.js'].code).toBe('console.log(1)');
  });

  test('a bundle that has HTML does not trigger the warning', async () => {
    const warnings = await run(makeBundle('<html><head><script src="/assets/app-abc.js"></script></head></html>'));
    expect(warnings).toEqual([]);
  });
});

test('does not mistake a bundle file named "..foo.js" for path traversal', async () => {
  const b = makeBundle('<html><head><script src="/..foo.js"></script><script src="..foo.js"></script></head></html>');
  b['..foo.js'] = { type: 'chunk', fileName: '..foo.js', code: 'var f=1' };
  const warnings = await run(b, { strict: true });
  expect(warnings).toEqual([]);
  expect(b['index.html'].source).toContain(`integrity="${sha('var f=1')}"`);
  expect(b['index.html'].source.match(/integrity="/g)).toHaveLength(2);
});

test('still rejects real traversal out of the bundle root', async () => {
  const b = makeBundle('<html><head><script src="../outside.js"></script></head></html>');
  await expect(run(b, { strict: true })).rejects.toThrow(/path traversal/);
});

describe('publicDir fallback', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  let publicDir;

  beforeEach(() => {
    publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sri-public-'));
    fs.writeFileSync(path.join(publicDir, '..pub.js'), 'pub');
  });
  afterEach(() => {
    fs.rmSync(publicDir, { recursive: true, force: true });
  });

  test('hashes a publicDir file named "..pub.js"', async () => {
    const b = makeBundle('<html><head><script src="/..pub.js"></script></head></html>');
    await run(b, { strict: true, publicDir });
    expect(b['index.html'].source).toContain(`integrity="${sha('pub')}"`);
  });

  test('never asks the filesystem for a path outside publicDir', async () => {
    const outside = path.join(path.dirname(publicDir), 'sri-outside.txt');
    fs.writeFileSync(outside, 'outside');
    const reads = [];
    const spy = jest.spyOn(fs, 'readFileSync').mockImplementation((p) => { reads.push(String(p)); return Buffer.from('x'); });
    try {
      const urls = [
        '/../sri-outside.txt',
        '/assets/../../sri-outside.txt',
        '../sri-outside.txt',
        '/%2e%2e/sri-outside.txt',
        '/..%2fsri-outside.txt',
        '/..pub.js', // control: legitimately inside, must be read
      ];
      const b = makeBundle(`<html><head>${urls.map(u => `<script src="${u}"></script>`).join('')}</head></html>`);
      await run(b, { publicDir });

      expect(reads.length).toBeGreaterThan(0);
      for (const p of reads) {
        const rel = path.relative(publicDir, p);
        expect(rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)).toBe(false);
      }
      expect(reads).toContain(path.join(publicDir, '..pub.js'));
    } finally {
      spy.mockRestore();
      fs.rmSync(outside, { force: true });
    }
  });
});

describe('absolute-URL base (CDN deployments)', () => {
  const CDN = 'https://cdn.example.com/';
  const cdnHtml = `<html><head><script type="module" crossorigin src="${CDN}assets/app-abc.js"></script><link rel="stylesheet" href="${CDN}assets/app-abc.css"></head></html>`;

  test('hashes bundle assets referenced by their CDN URL when base is passed as an option', async () => {
    const b = makeBundle(cdnHtml);
    const warnings = await run(b, { strict: true, base: CDN });
    expect(warnings).toEqual([]);
    expect(b['index.html'].source).toContain(`integrity="${sha('console.log(1)')}"`);
    expect(b['index.html'].source).toContain(`integrity="${sha('a{b:c}')}"`);
  });

  test('picks the URL base up from Vite\'s resolved config', async () => {
    const b = makeBundle(cdnHtml);
    await run(b, { strict: true }, { config: { base: CDN } });
    expect(b['index.html'].source.match(/integrity="/g)).toHaveLength(2);
  });

  test('keeps an existing crossorigin attribute (Vite emits crossorigin on module scripts)', async () => {
    const b = makeBundle(cdnHtml);
    await run(b, { base: CDN });
    expect(b['index.html'].source).toMatch(/<script[^>]* crossorigin[^>]*>/);
    expect(b['index.html'].source).not.toMatch(/<script[^>]*crossorigin="anonymous"/);
  });

  test('strict fails when a CDN-URL asset is not in the bundle, instead of skipping it as external', async () => {
    const b = makeBundle(`<html><head><script src="${CDN}assets/missing.js"></script></head></html>`);
    await expect(run(b, { strict: true, base: CDN })).rejects.toThrow(/missing\.js/);
  });

  test('assets on a different host are still left alone', async () => {
    const b = makeBundle('<html><head><script src="https://other.example.net/x.js"></script></head></html>');
    const warnings = await run(b, { strict: true, base: CDN });
    expect(warnings).toEqual([]);
    expect(b['index.html'].source).not.toContain('integrity=');
  });
});

describe('existing integrity attributes', () => {
  test('a stale value is replaced and reported as a warning even under strict', async () => {
    const b = makeBundle('<html><head><script src="/assets/app-abc.js" integrity="sha256-STALE"></script></head></html>');
    const warnings = await run(b, { strict: true });
    expect(b['index.html'].source).toContain(`integrity="${sha('console.log(1)')}"`);
    expect(warnings.join('\n')).toMatch(/app-abc\.js.*sha256-STALE/);
  });

  test('a valid value is kept without a warning', async () => {
    const b = makeBundle(`<html><head><script src="/assets/app-abc.js" integrity="${sha('console.log(1)')}" crossorigin="anonymous"></script></head></html>`);
    const warnings = await run(b, { strict: true });
    expect(warnings).toEqual([]);
    expect(b['index.html'].source.match(/integrity=/g)).toHaveLength(1);
  });
});

describe('external resources', () => {
  const http = require('http');
  let server, origin;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/lib.js') { res.writeHead(200, { 'Access-Control-Allow-Origin': '*' }); return res.end('lib'); }
      if (req.url === '/no-cors.js') { res.writeHead(200); return res.end('nc'); }
      res.writeHead(404); res.end();
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => new Promise(r => server.close(r)));

  test('default: third-party scripts are left alone', async () => {
    const b = makeBundle(`<html><head><script src="${origin}/lib.js"></script></head></html>`);
    await run(b, { strict: true });
    expect(b['index.html'].source).not.toContain('integrity=');
  });

  test('external: true pins CORS-enabled third-party scripts', async () => {
    const b = makeBundle(`<html><head><script src="${origin}/lib.js"></script></head></html>`);
    const warnings = await run(b, { strict: true, external: true });
    expect(warnings).toEqual([]);
    expect(b['index.html'].source).toContain(`integrity="${sha('lib')}"`);
  });

  test('external: true warns (does not fail) on a non-CORS resource', async () => {
    const b = makeBundle(`<html><head><script src="${origin}/no-cors.js"></script></head></html>`);
    const warnings = await run(b, { strict: true, external: true });
    expect(warnings.join()).toMatch(/no-cors\.js.*Access-Control-Allow-Origin/);
    expect(b['index.html'].source).not.toContain('integrity=');
  });

  test('external: true + strict fails the build on an unreachable resource', async () => {
    const b = makeBundle(`<html><head><script src="${origin}/gone.js"></script></head></html>`);
    await expect(run(b, { strict: true, external: true })).rejects.toThrow(/gone\.js/);
  });
});

describe('import map integrity for code-split chunks', () => {
  const chunk = (fileName, code, { imports = [], dynamicImports = [] } = {}) =>
    ({ type: 'chunk', fileName, code, imports, dynamicImports });
  // entry -> (dynamic) lazy -> (static) shared ; orphan is in the bundle but unreachable from index.html
  const splitBundle = (html, htmlName = 'index.html') => ({
    [htmlName]: { type: 'asset', fileName: htmlName, source: html },
    'assets/entry-111.js': chunk('assets/entry-111.js', 'entry', { dynamicImports: ['assets/lazy-222.js'] }),
    'assets/lazy-222.js': chunk('assets/lazy-222.js', 'lazy', { imports: ['assets/shared-333.js'] }),
    'assets/shared-333.js': chunk('assets/shared-333.js', 'shared'),
    'assets/orphan-444.js': chunk('assets/orphan-444.js', 'orphan'),
  });
  const parseMap = (html) => JSON.parse(/<script type="importmap">([\s\S]*?)<\/script>/.exec(html)[1]);

  test('adds hashes for every chunk reachable through static and dynamic imports that the HTML itself does not reference', async () => {
    const b = splitBundle('<html><head><script type="module" src="/assets/entry-111.js"></script></head></html>');
    const warnings = await run(b, { strict: true });
    expect(warnings).toEqual([]);
    expect(parseMap(b['index.html'].source)).toEqual({
      integrity: {
        '/assets/lazy-222.js': sha('lazy'),
        '/assets/shared-333.js': sha('shared'),
      },
    });
    // the entry is covered by its own tag
    expect(b['index.html'].source).toMatch(new RegExp(`entry-111\\.js"[^>]*integrity="${sha('entry').replace(/\+/g, '\\+')}"`));
  });

  test('a modulepreloaded chunk is covered by its tag, its own imports by the map', async () => {
    const b = splitBundle('<html><head><link rel="modulepreload" href="/assets/lazy-222.js"><script type="module" src="/assets/entry-111.js"></script></head></html>');
    await run(b);
    expect(parseMap(b['index.html'].source)).toEqual({ integrity: { '/assets/shared-333.js': sha('shared') } });
  });

  test('the import map precedes the module script', async () => {
    const b = splitBundle('<html><head><script type="module" src="/assets/entry-111.js"></script></head></html>');
    await run(b);
    const html = b['index.html'].source;
    expect(html.indexOf('importmap')).toBeGreaterThan(-1);
    expect(html.indexOf('importmap')).toBeLessThan(html.indexOf('type="module"'));
  });

  test('keys are full URLs when base is a CDN URL', async () => {
    const b = splitBundle('<html><head><script type="module" src="https://cdn.example.com/assets/entry-111.js"></script></head></html>');
    await run(b, { base: 'https://cdn.example.com/' });
    expect(Object.keys(parseMap(b['index.html'].source).integrity)).toEqual([
      'https://cdn.example.com/assets/lazy-222.js', 'https://cdn.example.com/assets/shared-333.js',
    ]);
  });

  test('keys include a path base', async () => {
    const b = splitBundle('<html><head><script type="module" src="/app/assets/entry-111.js"></script></head></html>');
    await run(b, { base: '/app/' });
    expect(parseMap(b['index.html'].source).integrity).toHaveProperty(['/app/assets/lazy-222.js'], sha('lazy'));
  });

  test('keys are document-relative for a relative base, from a nested HTML file', async () => {
    const b = splitBundle('<html><head><script type="module" src="../assets/entry-111.js"></script></head></html>', 'pages/about.html');
    await run(b, { base: './' });
    expect(Object.keys(parseMap(b['pages/about.html'].source).integrity)).toEqual([
      '../assets/lazy-222.js', '../assets/shared-333.js',
    ]);
  });

  test('a page with no module graph gets no import map', async () => {
    const b = makeBundle('<html><head><script src="/assets/app-abc.js"></script></head></html>');
    b['assets/app-abc.js'].imports = []; b['assets/app-abc.js'].dynamicImports = [];
    await run(b);
    expect(b['index.html'].source).not.toContain('importmap');
  });

  test('importMap: false disables it', async () => {
    const b = splitBundle('<html><head><script type="module" src="/assets/entry-111.js"></script></head></html>');
    await run(b, { importMap: false });
    expect(b['index.html'].source).not.toContain('importmap');
    expect(b['index.html'].source).toContain('integrity=');
  });
});

describe('Integrity-Policy', () => {
  const HEADER = 'Integrity-Policy: blocked-destinations=(script), sources=(inline)';

  test('off by default: nothing emitted, no preview header, externals merely skipped', async () => {
    const plugin = sriPlugin({});
    expect(plugin.config ? plugin.config({}) : undefined).toBeUndefined();
    const emitted = [];
    await run(makeBundle('<html><head><script src="https://third.example.net/a.js"></script></head></html>'), { strict: true }, { emitted });
    expect(emitted).toEqual([]);
  });

  test('integrityPolicy: true fails the build when any script would be blocked by the header', async () => {
    const b = makeBundle('<html><head><script src="https://third.example.net/a.js"></script><script src="/assets/app-abc.js"></script></head></html>');
    await expect(run(b, { integrityPolicy: true })).rejects.toThrow(/Integrity-Policy[\s\S]*third\.example\.net\/a\.js/);
  });

  test('integrityPolicy: true passes when every script is covered, and logs the header as info (not a warning)', async () => {
    const b = makeBundle('<html><head><script src="/assets/app-abc.js"></script></head></html>');
    const infos = [];
    await expect(run(b, { integrityPolicy: true, strict: true }, { infos })).resolves.toEqual([]);
    expect(infos.join('\n')).toContain(HEADER);
  });

  test('headersFile emits a _headers asset with the header', async () => {
    const emitted = [];
    await run(makeBundle('<html><head><script src="/assets/app-abc.js"></script></head></html>'), { integrityPolicy: { headersFile: '_headers' } }, { emitted });
    expect(emitted).toEqual([{ type: 'asset', fileName: '_headers', source: `/*\n  ${HEADER}\n` }]);
  });

  test('headersFile merges into a _headers asset already in the bundle', async () => {
    const b = makeBundle('<html><head><script src="/assets/app-abc.js"></script></head></html>');
    b['_headers'] = { type: 'asset', fileName: '_headers', source: '/assets/*\n  Cache-Control: immutable\n' };
    await run(b, { integrityPolicy: { headersFile: '_headers' } });
    expect(String(b['_headers'].source)).toBe(`/assets/*\n  Cache-Control: immutable\n\n/*\n  ${HEADER}\n`);
  });

  test('headersFile merges the user\'s publicDir copy in, since Vite copies publicDir and the emitted asset would otherwise clobber it', async () => {
    const fs = require('fs'), os = require('os'), path = require('path');
    const publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sri-public-'));
    fs.writeFileSync(path.join(publicDir, '_headers'), '/assets/*\n  Cache-Control: immutable\n');
    try {
      const emitted = [];
      const warnings = await run(makeBundle('<html><head><script src="/assets/app-abc.js"></script></head></html>'), { integrityPolicy: { headersFile: '_headers' }, publicDir }, { emitted });
      expect(emitted[0].source).toBe(`/assets/*\n  Cache-Control: immutable\n\n/*\n  ${HEADER}\n`);
      expect(warnings.join()).not.toMatch(/overwrite/);
    } finally {
      fs.rmSync(publicDir, { recursive: true, force: true });
    }
  });

  test('report-only mode uses the report-only header', async () => {
    const emitted = [];
    await run(makeBundle('<html><head><script src="/assets/app-abc.js"></script></head></html>'), { integrityPolicy: { reportOnly: true, headersFile: '_headers', endpoints: ['integrity'] } }, { emitted });
    expect(emitted[0].source).toContain('Integrity-Policy-Report-Only: blocked-destinations=(script), sources=(inline), endpoints=(integrity)');
  });

  test('Vite: sets the header on the preview server only (dev serves unhashed source modules)', () => {
    const cfg = sriPlugin({ integrityPolicy: true }).config({});
    expect(cfg).toEqual({ preview: { headers: { 'Integrity-Policy': 'blocked-destinations=(script), sources=(inline)' } } });
    expect(sriPlugin({ integrityPolicy: 'report-only' }).config({}).preview.headers).toHaveProperty('Integrity-Policy-Report-Only');
  });
});

describe('Uint8Array asset sources', () => {
  const decode = (s) => (typeof s === 'string' ? s : Buffer.from(s).toString('utf8'));

  test('HTML emitted as a Uint8Array is decoded, not stringified as comma-separated bytes', async () => {
    const b = makeBundle('');
    b['index.html'].source = new Uint8Array(Buffer.from('<html><head><script src="/assets/app-abc.js"></script></head></html>'));
    await run(b);
    const out = decode(b['index.html'].source);
    expect(out).toContain(`integrity="${sha('console.log(1)')}"`);
    expect(out).not.toMatch(/^\d+,\d+/);
  });

  test('an existing _headers asset emitted as a Uint8Array is merged, not corrupted', async () => {
    const b = makeBundle('<html><head><script src="/assets/app-abc.js"></script></head></html>');
    b['_headers'] = { type: 'asset', fileName: '_headers', source: new Uint8Array(Buffer.from('/assets/*\n  Cache-Control: max-age=31536000\n')) };
    await run(b, { integrityPolicy: { headersFile: '_headers' } });
    const out = decode(b['_headers'].source);
    expect(out).toContain('Cache-Control: max-age=31536000');
    expect(out).toContain('Integrity-Policy: ');
    expect(out).not.toMatch(/\d+,\d+,\d+/);
  });
});

test('a headersFile that escapes the output directory is rejected', () => {
  expect(() => require('../adapters/rollup')({ integrityPolicy: { headersFile: '../_headers' } })).toThrow(/headers file/i);
});

describe('multi-output builds (e.g. @vitejs/plugin-legacy builds legacy chunks in a separate output)', () => {
  const setup = (opts = {}) => {
    const plugin = sriPlugin({ algorithm: 'sha256', ...opts });
    const warnings = [];
    const self = { error: (m) => { throw new Error(m); }, warn: (m) => warnings.push(m), info: () => {}, emitFile: () => {} };
    return {
      warnings,
      pass: (bundle) => plugin.generateBundle.handler.call(self, {}, bundle),
      close: async () => plugin.closeBundle.call(self),
    };
  };
  const legacyOutput = () => ({ 'assets/polyfills-legacy.js': { type: 'chunk', fileName: 'assets/polyfills-legacy.js', code: 'poly()' } });
  const htmlOutput = () => ({
    'index.html': { type: 'asset', fileName: 'index.html', source: '<html><head><script nomodule src="/assets/polyfills-legacy.js"></script></head></html>' },
  });

  test('a chunk emitted by an earlier output is hashed when a later output references it', async () => {
    const t = setup();
    await t.pass(legacyOutput());
    const html = htmlOutput();
    await t.pass(html);
    await t.close();
    expect(html['index.html'].source).toContain(`integrity="${sha('poly()')}"`);
    expect(t.warnings).toEqual([]);
  });

  test('an output without HTML does not fail strict while another output has HTML', async () => {
    const t = setup({ strict: true });
    await t.pass(legacyOutput());
    await t.pass(htmlOutput());
    await expect(t.close()).resolves.toBeUndefined();
  });

  test('strict still fails at close when no output contained HTML', async () => {
    const t = setup({ strict: true });
    await t.pass(legacyOutput());
    await expect(t.close()).rejects.toThrow(/No HTML/i);
  });

  test('a file in the current output wins over a same-named file from an earlier output', async () => {
    const t = setup();
    await t.pass(legacyOutput());
    const html = {
      ...htmlOutput(),
      'assets/polyfills-legacy.js': { type: 'chunk', fileName: 'assets/polyfills-legacy.js', code: 'newer()' },
    };
    await t.pass(html);
    expect(html['index.html'].source).toContain(sha('newer()'));
    expect(html['index.html'].source).not.toContain(sha('poly()'));
  });

  test('earlier outputs are forgotten at close, so the next build cannot resolve stale files', async () => {
    const t = setup();
    await t.pass(legacyOutput());
    await t.pass(htmlOutput());
    await t.close();
    const html = htmlOutput();
    await t.pass(html);
    expect(html['index.html'].source).not.toContain('integrity=');
    expect(t.warnings.join('\n')).toMatch(/polyfills-legacy\.js/);
  });
});

describe('enabled option', () => {
  test('enabled: false leaves HTML untouched and stays silent, even with strict', async () => {
    const b = makeBundle('<html><head><script src="/assets/app-abc.js"></script></head></html>');
    const before = b['index.html'].source;
    const warnings = await run(b, { enabled: false, strict: true });
    expect(b['index.html'].source).toBe(before);
    expect(warnings).toEqual([]);
  });

  test('enabled: false with no HTML does not complain', async () => {
    await expect(run({ 'a.js': { type: 'chunk', fileName: 'a.js', code: '1' } }, { enabled: false, strict: true })).resolves.toEqual([]);
  });
});

describe('crossorigin option', () => {
  test('is applied to tags that have no crossorigin', async () => {
    const b = makeBundle('<html><head><script src="/assets/app-abc.js"></script></head></html>');
    await run(b, { crossorigin: 'use-credentials' });
    expect(b['index.html'].source).toContain('crossorigin="use-credentials"');
  });

  test('does not override an existing crossorigin attribute', async () => {
    const b = makeBundle('<html><head><script src="/assets/app-abc.js" crossorigin="anonymous"></script></head></html>');
    await run(b, { crossorigin: 'use-credentials' });
    expect(b['index.html'].source).toContain('crossorigin="anonymous"');
  });

  test('rejects values other than anonymous and use-credentials at configuration time', () => {
    expect(() => sriPlugin({ crossorigin: 'yes' })).toThrow(/crossorigin/);
  });
});
