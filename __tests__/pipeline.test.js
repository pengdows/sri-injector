/**
 * The host-agnostic pieces every adapter (CLI, Rollup/Vite, webpack) is built from: option resolution,
 * structured diagnostics with a single fatal-vs-warning rule, and the page pipeline.
 */
const { resolveOptions } = require('../lib/options');
const { classify, formatFatal, noHtmlDiagnostic, formatDiagnostic, CODES } = require('../lib/diagnostics');
const { processPages } = require('../lib/pipeline');

describe('resolveOptions', () => {
  test('applies defaults and returns a frozen object', () => {
    const o = resolveOptions();
    expect(o).toMatchObject({ enabled: true, strict: false, algorithm: 'sha384', crossorigin: 'anonymous', external: false, importMap: true, policy: null, policyHeader: null });
    expect(Object.isFrozen(o)).toBe(true);
  });

  test('validates algorithm, crossorigin, policy and the external timeout in one place', () => {
    expect(() => resolveOptions({ algorithm: 'md5' })).toThrow(/Unsupported hash algorithm/);
    expect(() => resolveOptions({ crossorigin: 'sometimes' })).toThrow(/crossorigin/);
    expect(() => resolveOptions({ integrityPolicy: { headersFile: '../x' } })).toThrow(/headers file/i);
    expect(() => resolveOptions({ externalTimeout: 'abc' })).toThrow(/externalTimeout/);
    expect(() => resolveOptions({ externalTimeout: 0 })).toThrow(/externalTimeout/);
  });

  test('builds the Integrity-Policy header from the policy option', () => {
    const o = resolveOptions({ integrityPolicy: 'report-only' });
    expect(o.policyHeader.name).toBe('Integrity-Policy-Report-Only');
    expect(o.policy.reportOnly).toBe(true);
  });

  test('rejects unknown options, so a typo cannot silently disable a safeguard', () => {
    expect(() => resolveOptions({ strcit: true })).toThrow(/Unknown option "strcit"/);
    expect(() => resolveOptions({ strcit: true, algoritm: 'sha256' })).toThrow(/strcit.*algoritm|algoritm.*strcit/);
  });

  test('passes through base and publicDir untouched', () => {
    const o = resolveOptions({ base: '/app/', publicDir: '/p' });
    expect(o.base).toBe('/app/');
    expect(o.publicDir).toBe('/p');
  });
});

describe('diagnostics', () => {
  const d = (severity, code, extra = {}) => ({ severity, code, message: `${code} message`, ...extra });

  test('errors are always fatal; warnings never are', () => {
    const { fatal, warnings } = classify([d('error', CODES.RESOURCE_NOT_FOUND), d('warning', CODES.INTEGRITY_REPLACED)], { strict: false });
    expect(fatal.map(x => x.code)).toEqual([CODES.RESOURCE_NOT_FOUND]);
    expect(warnings.map(x => x.code)).toEqual([CODES.INTEGRITY_REPLACED]);
  });

  test('"no HTML" is a warning unless strict', () => {
    const none = noHtmlDiagnostic('the build');
    expect(classify([none], { strict: false }).fatal).toEqual([]);
    expect(classify([none], { strict: false }).warnings).toHaveLength(1);
    expect(classify([none], { strict: true }).fatal).toHaveLength(1);
    expect(none.message).toMatch(/No HTML files found in the build/);
  });

  test('formatDiagnostic prefixes the file when there is one', () => {
    expect(formatDiagnostic({ file: 'index.html', message: 'boom' })).toBe('index.html: boom');
    expect(formatDiagnostic({ message: 'boom' })).toBe('boom');
  });

  test('formatFatal groups by kind, with one wording shared by every adapter', () => {
    const text = formatFatal([
      { severity: 'error', code: CODES.RESOURCE_NOT_FOUND, file: 'a.html', url: '/x.js', message: 'The linked resource "/x.js" could not be found.' },
      { severity: 'error', code: CODES.RESOURCE_FAILED, file: 'b.html', url: '/y.js', message: 'Could not process resource "/y.js": EISDIR' },
      { severity: 'error', code: CODES.UNPROTECTED_SCRIPT, file: 'a.html', url: 'https://t.example/a.js', message: 'x' },
      noHtmlDiagnostic('any output'),
    ]);
    expect(text).toMatch(/2 resource\(s\) could not be processed:\n {2}- a\.html: The linked resource "\/x\.js" could not be found\.\n {2}- b\.html: Could not process resource "\/y\.js": EISDIR/);
    expect(text).toMatch(/1 script\(s\) have no integrity and would be blocked by the Integrity-Policy header:\n {2}- a\.html: https:\/\/t\.example\/a\.js/);
    expect(text).toMatch(/No HTML files found in any output/);
  });

  test('formatFatal names the chunks that would be blocked', () => {
    const text = formatFatal([
      { severity: 'error', code: CODES.UNPROTECTED_CHUNK, file: '665.abc.js', message: 'x' },
      { severity: 'error', code: CODES.UNPROTECTED_CHUNK, file: 'about.def.js', message: 'x' },
    ]);
    expect(text).toMatch(/2 chunk\(s\) are loaded at runtime without integrity and would be blocked by the Integrity-Policy header:\n {2}- 665\.abc\.js\n {2}- about\.def\.js/);
    expect(text).not.toMatch(/could not be processed/);
  });
});

describe('processPages', () => {
  const page = (name, html, files = {}, extra = {}) => ({ name, html, resolveAsset: (u) => (u in files ? files[u] : null), ...extra });
  const config = (o = {}) => resolveOptions({ algorithm: 'sha256', ...o });

  test('adds integrity and reports which pages changed', async () => {
    const r = await processPages([page('index.html', '<script src="/a.js"></script>', { '/a.js': 'x' }), page('plain.html', '<p>hi</p>')], config());
    expect(r.pages.map(p => [p.name, p.modified])).toEqual([['index.html', true], ['plain.html', false]]);
    expect(r.pages[0].html).toMatch(/integrity="sha256-/);
    expect(r.diagnostics).toEqual([]);
  });

  test('tags every diagnostic with the page it came from', async () => {
    const r = await processPages([page('sub/page.html', '<script src="/missing.js"></script>')], config());
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]).toMatchObject({ severity: 'error', code: CODES.RESOURCE_NOT_FOUND, file: 'sub/page.html', url: '/missing.js' });
  });

  test('skip-sri leaves a tag alone, removes the marker attribute and raises no error', async () => {
    const r = await processPages([page('i.html', '<script src="/runtime-config.js" skip-sri></script>')], config());
    expect(r.diagnostics).toEqual([]);
    expect(r.pages[0].html).toBe('<script src="/runtime-config.js"></script>');
    expect(r.pages[0].modified).toBe(true);
  });

  test('uses a per-page import map callback when one is given', async () => {
    const r = await processPages([page('i.html', '<script type="module" src="/a.js"></script>', { '/a.js': 'x' }, { importMapIntegrity: () => ({ '/lazy.js': 'sha256-abc' }) })], config());
    expect(r.pages[0].html).toContain('"/lazy.js":"sha256-abc"');
  });

  describe('with an Integrity-Policy', () => {
    const policyConfig = () => config({ integrityPolicy: { headersFile: '_headers' } });
    const host = (existing) => {
      const written = [];
      return { written, headersFile: { read: async () => existing, write: async (content) => { written.push(content); } } };
    };

    test('an uncovered script is an error naming the script, and the headers file is not written', async () => {
      const h = host(null);
      const r = await processPages([page('i.html', '<script src="https://third.example/a.js"></script>')], policyConfig(), { headersFile: h.headersFile });
      expect(r.diagnostics.filter(x => x.code === CODES.UNPROTECTED_SCRIPT)).toEqual([
        expect.objectContaining({ severity: 'error', file: 'i.html', url: 'https://third.example/a.js' }),
      ]);
      expect(h.written).toEqual([]);
    });

    test('when every script is covered, the header is merged into the existing file and written', async () => {
      const h = host('/assets/*\n  Cache-Control: max-age=1\n');
      const r = await processPages([page('i.html', '<script src="/a.js"></script>', { '/a.js': 'x' })], policyConfig(), { headersFile: h.headersFile });
      expect(r.diagnostics).toEqual([]);
      expect(h.written).toHaveLength(1);
      expect(h.written[0]).toContain('Cache-Control: max-age=1');
      expect(h.written[0]).toContain('Integrity-Policy: blocked-destinations=(script), sources=(inline)');
    });

    test('diagnostics the host adds are reported, and an error among them keeps the headers file from being written', async () => {
      const h = host(null);
      const chunk = { severity: 'error', code: CODES.UNPROTECTED_CHUNK, file: '1.js', message: 'lazy' };
      const r = await processPages([page('i.html', '<script src="/a.js"></script>', { '/a.js': 'x' })], policyConfig(), { headersFile: h.headersFile, extraDiagnostics: [chunk] });
      expect(r.diagnostics).toEqual([chunk]);
      expect(h.written).toEqual([]);
    });

    test('a warning from the host does not keep the headers file from being written', async () => {
      const h = host(null);
      const chunk = { severity: 'warning', code: CODES.UNPROTECTED_CHUNK, file: '1.js', message: 'lazy' };
      const r = await processPages([page('i.html', '<script src="/a.js"></script>', { '/a.js': 'x' })], policyConfig(), { headersFile: h.headersFile, extraDiagnostics: [chunk] });
      expect(r.diagnostics).toEqual([chunk]);
      expect(h.written).toHaveLength(1);
    });

    test('an absent headers file starts from nothing', async () => {
      const h = host(null);
      await processPages([page('i.html', '<script src="/a.js"></script>', { '/a.js': 'x' })], policyConfig(), { headersFile: h.headersFile });
      expect(h.written[0]).toMatch(/^\/\*\n {2}Integrity-Policy:/);
    });

    test('nothing is written without HTML pages', async () => {
      const h = host(null);
      await processPages([], policyConfig(), { headersFile: h.headersFile });
      expect(h.written).toEqual([]);
    });
  });

  test('base from the runtime overrides the configured one', async () => {
    const seen = [];
    await processPages([{ name: 'i.html', html: '<script src="/app/a.js"></script>', resolveAsset: (u) => { seen.push(u); return 'x'; } }], config({ base: '/' }), { base: '/app/' });
    expect(seen).toEqual(['/app/a.js']);
  });
});
