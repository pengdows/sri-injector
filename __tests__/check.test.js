/**
 * --check: validates the integrity metadata already in a build's output, without changing anything.
 * Spec: every examined tag (and import map entry) gets exactly one result; missing, wrong and
 * not-found fail the check, skipped (data-skip-sri) and unchecked (third-party without --external) do not.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkPage } = require('../core');
const { checkDirectory } = require('../index');

const sha = (alg, content) => `${alg}-${crypto.createHash(alg).update(content).digest('base64')}`;
const FILES = { '/a.js': 'var a=1', '/s.css': 'b{}', '/lazy.js': 'export const x=1' };
const resolve = (url) => (url in FILES ? FILES[url] : null);
const check = (head, options = {}) => checkPage(`<html><head>${head}</head><body></body></html>`, resolve, options);
const statuses = (r) => r.results.map(x => [x.url, x.status]);

describe('checkPage: one result per examined tag', () => {
  test('ok: integrity present and every token matches the bytes, whatever the algorithm', async () => {
    const r = await check(`<script src="/a.js" integrity="${sha('sha384', FILES['/a.js'])}"></script>` +
      `<link rel="stylesheet" href="/s.css" integrity="${sha('sha256', FILES['/s.css'])} ${sha('sha512', FILES['/s.css'])}">`);
    expect(statuses(r)).toEqual([['/a.js', 'ok'], ['/s.css', 'ok']]);
  });

  test('missing: no integrity attribute, or an empty one', async () => {
    const r = await check('<script src="/a.js"></script><link rel="stylesheet" href="/s.css" integrity=" ">');
    expect(statuses(r)).toEqual([['/a.js', 'missing'], ['/s.css', 'missing']]);
  });

  test('wrong: a value that does not match the file says what the file hashes to', async () => {
    const r = await check('<script src="/a.js" integrity="sha384-AAAA"></script>');
    expect(r.results).toEqual([expect.objectContaining({ url: '/a.js', status: 'wrong' })]);
    expect(r.results[0].message).toContain('sha384-AAAA');
    expect(r.results[0].message).toContain(sha('sha384', FILES['/a.js']));
  });

  test('wrong: one stale token among several is enough, as in a real run', async () => {
    const r = await check(`<script src="/a.js" integrity="${sha('sha256', FILES['/a.js'])} sha512-WRONG"></script>`);
    expect(statuses(r)).toEqual([['/a.js', 'wrong']]);
  });

  test.each(['md5-AAAA', 'not-an-sri-value'])('wrong: a malformed or unsupported value (%s)', async (value) => {
    const r = await check(`<script src="/a.js" integrity="${value}"></script>`);
    expect(r.results).toEqual([expect.objectContaining({ status: 'wrong', message: expect.stringContaining(value) })]);
  });

  test('not-found: the referenced file is not in the output, with or without integrity', async () => {
    const r = await check('<script src="/gone.js" integrity="sha384-AAAA"></script><script src="/gone2.js"></script>');
    expect(statuses(r)).toEqual([['/gone.js', 'not-found'], ['/gone2.js', 'not-found']]);
  });

  test('not-found: a resolver error (e.g. path traversal) is reported with its reason', async () => {
    const r = await checkPage('<script src="../x.js"></script>', () => { throw new Error('potential path traversal, skipping'); });
    expect(r.results).toEqual([expect.objectContaining({ status: 'not-found', message: expect.stringMatching(/path traversal/) })]);
  });

  test('skipped: data-skip-sri is honoured, with or without integrity, and the file is not even looked up', async () => {
    const seen = [];
    const r = await checkPage('<script src="/rt.js" data-skip-sri></script><link rel="stylesheet" href="/s.css" data-skip-sri integrity="sha384-X">',
      (url) => { seen.push(url); return null; });
    expect(statuses(r)).toEqual([['/rt.js', 'skipped'], ['/s.css', 'skipped']]);
    expect(seen).toEqual([]);
  });

  test('a bare skip-sri attribute is not an opt-out: the tag is examined like any other', async () => {
    const r = await check('<script src="/a.js" skip-sri></script>');
    expect(statuses(r)).toEqual([['/a.js', 'missing']]);
  });

  test('unchecked: a third-party tag without resolveExternal is listed, not verified', async () => {
    const r = await check('<script src="https://cdn.example.net/x.js"></script><script src="//cdn.example.net/y.js" integrity="sha384-X"></script>');
    expect(statuses(r)).toEqual([['https://cdn.example.net/x.js', 'unchecked'], ['//cdn.example.net/y.js', 'unchecked']]);
  });

  test('examines exactly the tags the injector handles', async () => {
    const r = await check(
      '<link rel="modulepreload" href="/a.js"><link rel="preload" as="style" href="/s.css">' +
      '<link rel="preload" as="font" href="/f.woff2"><link rel="icon" href="/i.png"><img src="/i.png"><script>inline()</script><script src=""></script>');
    expect(statuses(r)).toEqual([['/a.js', 'missing'], ['/s.css', 'missing']]);
  });

  test('resolves relative URLs against <base href>, as the browser and the injector do', async () => {
    const r = await checkPage('<base href="/app/"><script src="a.js"></script>', (url) => (url === '/app/a.js' ? 'x' : null));
    expect(statuses(r)).toEqual([['/app/a.js', 'missing']]);
  });

  test('with a full-URL base, assets under it are local (a CDN build), others are third-party', async () => {
    const seen = [];
    const r = await checkPage('<script src="https://cdn.me/a.js"></script><script src="https://other.net/b.js"></script>',
      (url) => { seen.push(url); return 'x'; }, { base: 'https://cdn.me/' });
    expect(statuses(r)).toEqual([['https://cdn.me/a.js', 'missing'], ['https://other.net/b.js', 'unchecked']]);
    expect(seen).toEqual(['https://cdn.me/a.js']);
  });

  test('crossorigin is not part of pass/fail', async () => {
    const r = await check(`<script src="/a.js" integrity="${sha('sha384', FILES['/a.js'])}"></script>`);
    expect(statuses(r)).toEqual([['/a.js', 'ok']]);
  });

  test('reports whether each result carried integrity (the "was the tool run?" signal)', async () => {
    const r = await check(`<script src="/a.js" integrity="${sha('sha384', FILES['/a.js'])}"></script><script src="/gone.js" integrity="sha384-A"></script><link rel="stylesheet" href="/s.css">`);
    expect(r.results.map(x => x.hasIntegrity)).toEqual([true, true, false]);
  });
});

describe('checkPage: third-party resources with resolveExternal (--external)', () => {
  const { SkipResource } = require('../core');
  const EXT = 'https://cdn.example.net/lib.js';

  test('are fetched and verified like local ones', async () => {
    const resolveExternal = () => 'lib';
    const ok = await check(`<script src="${EXT}" integrity="${sha('sha384', 'lib')}"></script>`, { resolveExternal });
    expect(statuses(ok)).toEqual([[EXT, 'ok']]);
    const missing = await check(`<script src="${EXT}"></script>`, { resolveExternal });
    expect(statuses(missing)).toEqual([[EXT, 'missing']]);
  });

  test('a 404 or a network error is not-found; a server without CORS is unchecked, as a real run leaves it', async () => {
    expect(statuses(await check(`<script src="${EXT}"></script>`, { resolveExternal: () => null }))).toEqual([[EXT, 'not-found']]);
    expect(statuses(await check(`<script src="${EXT}"></script>`, { resolveExternal: () => { throw new Error('timed out'); } }))).toEqual([[EXT, 'not-found']]);
    const noCors = await check(`<script src="${EXT}"></script>`, { resolveExternal: () => { throw new SkipResource('no CORS'); } });
    expect(noCors.results).toEqual([expect.objectContaining({ status: 'unchecked', message: expect.stringMatching(/no CORS/) })]);
  });
});

describe('checkPage: import map integrity entries (Vite/Rollup/Rolldown lazy chunks)', () => {
  const map = (integrity) => `<script type="importmap">${JSON.stringify({ imports: {}, integrity })}</script>`;

  test('each entry is verified against its file', async () => {
    const r = await check(map({ '/lazy.js': sha('sha384', FILES['/lazy.js']), '/a.js': 'sha384-WRONG', '/gone.js': 'sha384-X' }));
    expect(r.results.map(x => [x.target, x.url, x.status])).toEqual([
      ['import-map', '/lazy.js', 'ok'],
      ['import-map', '/a.js', 'wrong'],
      ['import-map', '/gone.js', 'not-found'],
    ]);
  });

  test('third-party entries follow the same rule as third-party tags', async () => {
    const r = await check(map({ 'https://cdn.example.net/x.js': 'sha384-X' }));
    expect(statuses(r)).toEqual([['https://cdn.example.net/x.js', 'unchecked']]);
  });

  test('an import map that is not valid JSON is a page problem', async () => {
    const r = await check('<script type="importmap">{not json</script>');
    expect(r.results).toEqual([]);
    expect(r.problems).toEqual([expect.stringMatching(/import map.*JSON/i)]);
  });

  test('a page without an import map, or a map without integrity, has no entries to check', async () => {
    expect((await check('<script type="importmap">{"imports":{}}</script>')).results).toEqual([]);
    expect((await check('<p>hi</p>')).results).toEqual([]);
  });
});

describe('checkPage: with an Integrity-Policy (parity with a real run)', () => {
  const policy = { reportOnly: false, endpoints: [] };

  test('a <script> the header would block fails as blocked, even if skipped or third-party', async () => {
    const r = await check('<script src="/rt.js" data-skip-sri></script><script src="https://t.example/a.js"></script>', { policy });
    expect(statuses(r)).toEqual([['/rt.js', 'blocked'], ['https://t.example/a.js', 'blocked']]);
  });

  test('stylesheets are not blocked by the header, so they keep their result', async () => {
    const r = await check('<link rel="stylesheet" href="/s.css" data-skip-sri><link rel="stylesheet" href="https://t.example/s.css">', { policy });
    expect(statuses(r)).toEqual([['/s.css', 'skipped'], ['https://t.example/s.css', 'unchecked']]);
  });
});

describe('checkDirectory', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sri-check-'));
    fs.writeFileSync(path.join(dir, 'a.js'), 'var a=1');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const put = (name, content) => {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  };
  // Every file with its bytes and modification time: "nothing written" must hold for both.
  const snapshot = () => {
    const out = {};
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
      const full = path.join(d, e.name);
      if (e.isDirectory()) return walk(full);
      out[path.relative(dir, full)] = [fs.readFileSync(full).toString('base64'), fs.statSync(full).mtimeMs];
    });
    walk(dir);
    return out;
  };

  test('passes when every examined tag is ok; results carry the page they came from', async () => {
    put('index.html', `<script src="/a.js" integrity="${sha('sha384', 'var a=1')}"></script>`);
    put('sub/page.html', `<script src="../a.js" integrity="${sha('sha512', 'var a=1')}"></script>`);
    const r = await checkDirectory(dir);
    expect(r.passed).toBe(true);
    expect(r.files).toBe(2);
    expect(r.results.map(x => [x.file, x.status]).sort()).toEqual([['index.html', 'ok'], ['sub/page.html', 'ok']]);
    expect(r.counts).toMatchObject({ ok: 2, missing: 0, wrong: 0, 'not-found': 0, skipped: 0, unchecked: 0, blocked: 0 });
  });

  test('fails on missing, wrong and not-found, and counts each result', async () => {
    put('index.html', '<script src="/a.js"></script><script src="/a.js" integrity="sha384-X"></script><script src="/gone.js"></script><script src="/rt.js" data-skip-sri></script><script src="https://t.example/x.js"></script>');
    const r = await checkDirectory(dir);
    expect(r.passed).toBe(false);
    expect(r.counts).toMatchObject({ ok: 0, missing: 1, wrong: 1, 'not-found': 1, skipped: 1, unchecked: 1 });
  });

  test('skipped and unchecked results alone do not fail the check', async () => {
    put('index.html', '<script src="/rt.js" data-skip-sri></script><script src="https://t.example/x.js"></script>');
    expect((await checkDirectory(dir)).passed).toBe(true);
  });

  test('integrityFound is false when no examined tag anywhere carries integrity (the tool was not run)', async () => {
    put('index.html', '<script src="/a.js"></script>');
    put('other.html', '<link rel="stylesheet" href="/a.js">');
    const r = await checkDirectory(dir);
    expect(r.integrityFound).toBe(false);
    put('other.html', '<link rel="stylesheet" href="/a.js" integrity="sha384-STALE">');
    expect((await checkDirectory(dir)).integrityFound).toBe(true);
  });

  test('--base and external resolution behave as in a real run', async () => {
    put('index.html', `<script src="https://cdn.me/a.js" integrity="${sha('sha384', 'var a=1')}"></script>`);
    expect((await checkDirectory(dir)).counts).toMatchObject({ unchecked: 1 });
    expect((await checkDirectory(dir, { base: 'https://cdn.me/' })).counts).toMatchObject({ ok: 1 });
  });

  test('a page that cannot be read (UTF-16) or has an invalid import map fails, as a diagnostic', async () => {
    put('utf16.html', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<script src="/a.js"></script>', 'utf16le')]));
    put('map.html', '<script type="importmap">{bad</script>');
    const r = await checkDirectory(dir);
    expect(r.passed).toBe(false);
    expect(r.diagnostics.map(d => d.file).sort()).toEqual(['map.html', 'utf16.html']);
  });

  test('no HTML: passes unless strict, like a real run', async () => {
    expect((await checkDirectory(dir)).passed).toBe(true);
    const strict = await checkDirectory(dir, { strict: true });
    expect(strict.passed).toBe(false);
    expect(strict.diagnostics).toEqual([expect.objectContaining({ code: 'NO_HTML' })]);
  });

  test('writes nothing: every byte and modification time is unchanged, including with a headers file configured', async () => {
    put('index.html', '<script src="/a.js" integrity="sha384-STALE"></script><script src="/rt.js" data-skip-sri></script><script src="/b.js"></script>');
    put('_headers', '/*\n  X-Test: 1\n');
    const before = snapshot();
    await checkDirectory(dir, { integrityPolicy: { headersFile: '_headers' } });
    expect(snapshot()).toEqual(before);
  });

  test('rejects a nonexistent directory and unknown options', async () => {
    await expect(checkDirectory(path.join(dir, 'nope'))).rejects.toThrow(/Output directory not found/);
    await expect(checkDirectory(dir, { dryRun: true })).rejects.toThrow(/Unknown option "dryRun"/);
  });
});
