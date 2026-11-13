/**
 * Regression tests for the external review (review-results.txt), written before the fixes.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const SubresourceIntegrityInjector = require('../SubresourceIntegrityInjector');
const { injectSri } = require('../core');
const { validateAlgorithm, verifyIntegrity, calculateBase64Hash } = require('../lib/integrity');
const { createExternalResolver } = require('../external');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const runCli = (dir, ...args) => {
  const r = spawnSync(process.execPath, [CLI, dir, ...args], { encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, out: r.stdout + r.stderr };
};

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sri-review-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const write = (name, content) => fs.writeFileSync(path.join(dir, name), content);
const read = (name) => fs.readFileSync(path.join(dir, name), 'utf8');
const page = (...tags) => `<html><head>${tags.join('')}</head><body></body></html>`;
const ok = (code) => Buffer.from(code);

describe('P1: the CLI must not write an enforcing header over uncovered dynamic imports', () => {
  beforeEach(() => {
    write('index.html', page('<script src="main.js"></script>'));
    write('main.js', 'button.onclick = () => import("./lazy.js")');
    write('lazy.js', 'export default 1');
  });

  test('enforcing: exit 1 and no headers file', () => {
    const r = runCli(dir, '--integrity-policy', '--headers-file', '_headers');
    expect(r.code).toBe(1);
    expect(r.stdout).not.toMatch(/✅/);
    expect(r.stderr).toMatch(/main\.js/);
    expect(fs.existsSync(path.join(dir, '_headers'))).toBe(false);
  });

  test('report-only: a warning, the header is still written', () => {
    const r = runCli(dir, '--integrity-policy-report-only', '--headers-file', '_headers');
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/Warning:.*main\.js/);
    expect(read('_headers')).toMatch(/Integrity-Policy-Report-Only/);
  });

  test('the library reports it as an error when enforcing, a warning when report-only', async () => {
    const enforce = await new SubresourceIntegrityInjector().insertSRIInHTML(dir, 'sha384', { integrityPolicy: true });
    expect(enforce.errors).toEqual([expect.stringMatching(/main\.js.*import\(\)/)]);
    const report = await new SubresourceIntegrityInjector().insertSRIInHTML(dir, 'sha384', { integrityPolicy: 'report-only' });
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([expect.stringMatching(/main\.js.*import\(\)/)]);
  });

  test('a chunk the page import map already covers is not reported', async () => {
    const map = `<script type="importmap">{"integrity":{"/lazy.js":"sha384-${calculateBase64Hash(Buffer.from('export default 1'), 'sha384')}"}}</script>`;
    write('index.html', page(map, '<script src="main.js"></script>'));
    const r = await new SubresourceIntegrityInjector().insertSRIInHTML(dir, 'sha384', { integrityPolicy: true });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  test('a non-literal import() is never considered covered', async () => {
    write('main.js', 'import(name)');
    const r = await new SubresourceIntegrityInjector().insertSRIInHTML(dir, 'sha384', { integrityPolicy: true });
    expect(r.errors).toEqual([expect.stringMatching(/main\.js/)]);
  });

  test('the CLI says loudly that it cannot prove coverage when it emits an enforcing header', () => {
    write('main.js', 'var a=1');
    const r = runCli(dir, '--integrity-policy');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/cannot (prove|verify|detect)/i);
  });

  test('the library does not write to the console', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      write('index.html', page('<script src="missing.js"></script>'));
      await new SubresourceIntegrityInjector().insertSRIInHTML(dir, 'sha384', { integrityPolicy: 'report-only' });
      expect(err).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally { err.mockRestore(); warn.mockRestore(); }
  });

  test('the CLI prints the library diagnostics', () => {
    write('index.html', page('<script src="missing.js"></script>'));
    const r = runCli(dir);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/Error:.*missing\.js/);
  });
});

describe('P1: use-credentials with external', () => {
  const external = jest.fn(async () => ok('x'));
  beforeEach(() => external.mockClear());

  test('an external tag with crossorigin="use-credentials" is skipped with a warning, not fetched', async () => {
    const html = page('<script src="https://cdn.example.com/a.js" crossorigin="use-credentials"></script>');
    const r = await injectSri(html, () => ok('x'), { resolveExternal: external });
    expect(external).not.toHaveBeenCalled();
    expect(r.html).toBe(html);
    expect(r.warnings).toEqual([expect.stringMatching(/use-credentials/)]);
  });

  test('the same when use-credentials is the configured default', async () => {
    const html = page('<script src="https://cdn.example.com/a.js"></script>');
    const r = await injectSri(html, () => ok('x'), { crossorigin: 'use-credentials', resolveExternal: external });
    expect(external).not.toHaveBeenCalled();
    expect(r.html).toBe(html);
  });

  test('local tags still get use-credentials', async () => {
    const r = await injectSri(page('<script src="/a.js"></script>'), () => ok('x'), { crossorigin: 'use-credentials', resolveExternal: external });
    expect(r.html).toContain('crossorigin="use-credentials"');
  });

  test('an anonymous external tag is still fetched', async () => {
    await injectSri(page('<script src="https://cdn.example.com/a.js"></script>'), () => ok('x'), { resolveExternal: external });
    expect(external).toHaveBeenCalled();
  });
});

describe('P2: validateAlgorithm', () => {
  test.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])('rejects %s up front', (name) => {
    expect(() => validateAlgorithm(name)).toThrow(/Unsupported hash algorithm "[^"]*"\. Use one of: sha256, sha384, sha512/);
    expect(() => validateAlgorithm(name)).not.toThrow(/native code/);
  });
  test('accepts the three real ones', () => {
    expect(['sha256', 'sha384', 'sha512'].map(validateAlgorithm)).toEqual(['sha256', 'sha384', 'sha512']);
  });
});

describe('P2: URL handling follows the URL parser', () => {
  const asset = jest.fn(async () => ok('x'));
  beforeEach(() => asset.mockClear());

  test('leading and trailing whitespace in src is ignored, as browsers do', async () => {
    const r = await injectSri(page('<script src=" /assets/a.js\n"></script>'), asset);
    expect(r.errors).toEqual([]);
    expect(r.html).toContain('integrity="sha384-');
    expect(asset).toHaveBeenCalledWith('/assets/a.js');
  });

  test('tabs and newlines inside the URL are removed', async () => {
    await injectSri(page('<script src="/assets/a\n.js"></script>'), asset);
    expect(asset).toHaveBeenCalledWith('/assets/a.js');
  });

  test('"/\\host/a.js" is protocol-relative, so external', async () => {
    const r = await injectSri(page('<script src="/\\evil.example/a.js"></script>'), asset);
    expect(asset).not.toHaveBeenCalled();
    expect(r.errors).toEqual([]);
  });

  test('backslashes in a local path are slashes', async () => {
    await injectSri(page('<script src="assets\\a.js"></script>'), asset);
    expect(asset).toHaveBeenCalledWith('assets/a.js');
  });
});

describe('P2: verifyIntegrity', () => {
  const content = Buffer.from('hello');
  const good = calculateBase64Hash(content, 'sha384');
  const other = calculateBase64Hash(Buffer.from('other'), 'sha384');

  test('alternatives within one algorithm are valid if any matches', () => {
    expect(verifyIntegrity(`sha384-${good} sha384-${other}`, content)).toBe(true);
    expect(verifyIntegrity(`sha384-${other} sha384-${good}`, content)).toBe(true);
  });
  test('none matching is invalid', () => {
    expect(verifyIntegrity(`sha384-${other}`, content)).toBe(false);
  });
  test('a stale token of a different algorithm is still invalid', () => {
    expect(verifyIntegrity(`sha256-${calculateBase64Hash(Buffer.from('old'), 'sha256')} sha384-${good}`, content)).toBe(false);
  });
  test('base64url digests are accepted', () => {
    const url = good.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(verifyIntegrity(`sha384-${url}`, content)).toBe(true);
  });
  test('a multi-hash value is kept untouched by injectSri', async () => {
    const value = `sha384-${good} sha384-${other}`;
    const html = page(`<script src="/a.js" integrity="${value}" crossorigin="anonymous"></script>`);
    const r = await injectSri(html, () => content);
    expect(r.html).toBe(html);
    expect(r.warnings).toEqual([]);
  });
});

describe('P2: non-executable scripts are not subresources', () => {
  const asset = jest.fn(async () => null);
  beforeEach(() => asset.mockClear());

  test.each(['application/ld+json', 'text/template', 'text/x-handlebars', 'importmap', 'speculationrules'])('type=%s is ignored', async (type) => {
    const html = page(`<script type="${type}" src="/missing.json"></script>`);
    const r = await injectSri(html, asset);
    expect(asset).not.toHaveBeenCalled();
    expect(r.errors).toEqual([]);
    expect(r.unprotectedScripts).toEqual([]);
    expect(r.html).toBe(html);
  });

  test.each(['', ' type="module"', ' type="text/javascript"', ' type="Application/JavaScript; charset=utf-8"', ' type=""'])('executable script%s is still hashed', async (t) => {
    const r = await injectSri(page(`<script${t.includes('type') ? t : ''} src="/a.js"></script>`), () => ok('x'));
    expect(r.html).toContain('integrity="sha384-');
  });
});

describe('P2: CLI flag conflicts are errors', () => {
  beforeEach(() => write('index.html', page('<script src="a.js"></script>')) || write('a.js', 'x'));

  test('both policy flags together', () => {
    const r = runCli(dir, '--integrity-policy', '--integrity-policy-report-only');
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/cannot be used with|conflict/i);
    expect(read('index.html')).not.toContain('integrity=');
  });

  test('--headers-file without a policy flag', () => {
    const r = runCli(dir, '--headers-file', '_headers');
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/--headers-file.*--integrity-policy/);
    expect(fs.existsSync(path.join(dir, '_headers'))).toBe(false);
  });
});

describe('P2: external servers that vary on User-Agent', () => {
  let server, origin;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Access-Control-Allow-Origin': '*', Vary: req.url === '/ua.css' ? 'Accept-Encoding, User-Agent' : 'Accept-Encoding' });
      res.end('body{}');
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => new Promise(r => server.close(r)));

  test('is skipped with a warning', async () => {
    const r = await injectSri(page(`<link rel="stylesheet" href="${origin}/ua.css">`), () => null, { resolveExternal: createExternalResolver() });
    expect(r.html).not.toContain('integrity=');
    expect(r.warnings).toEqual([expect.stringMatching(/User-Agent/)]);
    expect(r.errors).toEqual([]);
  });

  test('without it, it is pinned', async () => {
    const r = await injectSri(page(`<link rel="stylesheet" href="${origin}/plain.css">`), () => null, { resolveExternal: createExternalResolver() });
    expect(r.html).toContain('integrity="sha384-');
  });

  test('the README no longer uses Google Fonts as an example', () => {
    expect(fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8')).not.toMatch(/fonts\.googleapis\.com/);
  });
});

describe('second review', () => {
  const lib = (name, code) => { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); write(name, code); };
  const entry = (u) => `sha384-${calculateBase64Hash(Buffer.from('export default 1'), 'sha384')}`;

  test('a root-relative import() target is resolved from the output root, not the importing file', async () => {
    lib('assets/main.js', 'go = () => import("/assets/lazy.js")');
    lib('assets/lazy.js', 'export default 1');
    write('index.html', page(`<script type="importmap">{"integrity":{"/assets/lazy.js":"${entry()}"}}</script>`, '<script src="/assets/main.js"></script>'));
    const r = await new SubresourceIntegrityInjector().insertSRIInHTML(dir, 'sha384', { integrityPolicy: true });
    expect(r.errors).toEqual([]);
  });

  test('...and under a non-root base the base prefix is stripped', async () => {
    lib('assets/main.js', 'go = () => import("/app/assets/lazy.js")');
    lib('assets/lazy.js', 'export default 1');
    write('index.html', page(`<script type="importmap">{"integrity":{"/app/assets/lazy.js":"${entry()}"}}</script>`, '<script src="/app/assets/main.js"></script>'));
    const r = await new SubresourceIntegrityInjector().insertSRIInHTML(dir, 'sha384', { integrityPolicy: true, base: '/app/' });
    expect(r.errors).toEqual([]);
  });

  test.each([
    ['a method call', 'obj.import("x"); lib.import(name)'],
    ['a line comment', 'var a = 1; // we used to import(name) here\nvar b = 2'],
    ['a block comment', '/* import(name) */ var a = 1'],
  ])('import( inside %s is not a dynamic import', async (_, code) => {
    write('index.html', page('<script src="main.js"></script>'));
    write('main.js', code);
    const r = await new SubresourceIntegrityInjector().insertSRIInHTML(dir, 'sha384', { integrityPolicy: true });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  test('a real import() after a URL string containing // is still found', async () => {
    write('index.html', page('<script src="main.js"></script>'));
    write('main.js', 'var u = "http://x.test/"; import(name)');
    const r = await new SubresourceIntegrityInjector().insertSRIInHTML(dir, 'sha384', { integrityPolicy: true });
    expect(r.errors).toEqual([expect.stringMatching(/main\.js/)]);
  });

  test('--check agrees with a real run on an external use-credentials tag', async () => {
    write('index.html', page('<script src="https://cdn.example.com/a.js" crossorigin="use-credentials"></script>'));
    const { checkDirectory } = require('../lib/directory');
    const fetcher = jest.fn();
    const r = await checkDirectory(dir, { external: true });
    expect(r.results).toEqual([expect.objectContaining({ status: 'unchecked', message: expect.stringMatching(/use-credentials/) })]);
    expect(r.passed).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  test('a whitespace-only src is not an unprotected script', async () => {
    const r = await injectSri(page('<script src=" "></script>'), () => ok('x'));
    expect(r.unprotectedScripts).toEqual([]);
  });

  test('with --strict the warnings of a failing run are still printed', () => {
    write('a.js', 'x');
    write('index.html', page('<script src="a.js" integrity="sha384-AAAA"></script>', '<script src="missing.js"></script>'));
    const r = runCli(dir, '--strict');
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/Warning:.*a\.js/);
  });
});
