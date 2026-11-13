const path = require('path');
const { isInsideDir, injectSri } = require('../core');

const ROOT = path.resolve('/srv/dist');
const inRoot = (...p) => path.resolve(ROOT, ...p);

describe('isInsideDir', () => {
  test('accepts files and nested files inside the root', () => {
    expect(isInsideDir(ROOT, inRoot('app.js'))).toBe(true);
    expect(isInsideDir(ROOT, inRoot('assets', 'app.js'))).toBe(true);
  });

  test('accepts names that merely start with ".."', () => {
    expect(isInsideDir(ROOT, inRoot('..foo.js'))).toBe(true);
    expect(isInsideDir(ROOT, inRoot('...'))).toBe(true);
    expect(isInsideDir(ROOT, inRoot('assets', '..bar.css'))).toBe(true);
  });

  test('rejects the root itself and its parent', () => {
    expect(isInsideDir(ROOT, ROOT)).toBe(false);
    expect(isInsideDir(ROOT, path.dirname(ROOT))).toBe(false);
  });

  test('rejects paths that escape the root', () => {
    expect(isInsideDir(ROOT, inRoot('..', 'secret.txt'))).toBe(false);
    expect(isInsideDir(ROOT, inRoot('assets', '..', '..', 'secret.txt'))).toBe(false);
  });

  test('rejects sibling directories sharing the root as a prefix', () => {
    expect(isInsideDir(ROOT, path.resolve(ROOT + '-evil', 'x.js'))).toBe(false);
  });
});

describe('injectSri: rel/as token matching', () => {
  // Every local URL resolves, so whether a tag gets `integrity` depends only on tag selection.
  const resolve = () => Buffer.from('x');
  const inject = (tag) => injectSri(`<html><head>${tag}</head><body></body></html>`, resolve, { algorithm: 'sha256' });

  test.each([
    ['multi-token rel',             '<link rel="stylesheet alternate" href="a.css">'],
    ['multi-token rel, other order', '<link rel="alternate stylesheet" href="a.css">'],
    ['capitalised rel',             '<link rel="Stylesheet" href="a.css">'],
    ['upper-case rel',              '<link rel="STYLESHEET" href="a.css">'],
    ['extra/odd whitespace in rel', '<link rel="  stylesheet\t\nalternate " href="a.css">'],
    ['preload with mixed-case rel and as', '<link rel="Preload" as="Script" href="a.js">'],
    ['preload style with extra token',     '<link rel="preload prefetch" as="style" href="a.css">'],
    ['modulepreload with extra token',     '<link rel="modulepreload prefetch" href="a.js">'],
    ['capitalised modulepreload',          '<link rel="ModulePreload" href="a.js">'],
  ])('hashes %s', async (_name, tag) => {
    const { html, errors } = await inject(tag);
    expect(errors).toEqual([]);
    expect(html).toContain('integrity="sha256-');
  });

  test.each([
    ['icon link',                '<link rel="icon" href="favicon.ico">'],
    ['prefetch (no SRI support)', '<link rel="prefetch" href="next.js">'],
    ['dns-prefetch',             '<link rel="dns-prefetch" href="//cdn.example.com">'],
    ['rel containing stylesheet as a substring', '<link rel="stylesheets" href="a.css">'],
    ['rel containing preload as a substring',    '<link rel="preloader" href="a.js">'],
    ['alternate only',           '<link rel="alternate" href="a.css">'],
    // Browsers enforce integrity on preloads only for script and style, and the consumers of other
    // destinations (CSS @font-face, <img>, fetch()) carry none, so a hash would only stop the preload
    // from being reused.
    ['preload of a font',        '<link rel="preload" as="font" type="font/woff2" crossorigin href="a.woff2">'],
    ['preload of an image',      '<link rel="preload" as="image" href="a.png">'],
    ['preload of a fetch target', '<link rel="preload" as="fetch" href="data.json">'],
    ['preload with no as',       '<link rel="preload" href="a.js">'],
    ['no rel',                   '<link href="a.css">'],
  ])('does not touch %s', async (_name, tag) => {
    const { html, modified } = await inject(tag);
    expect(modified).toBe(false);
    expect(html).not.toContain('integrity=');
  });

  test('a font preload with an existing integrity value is left exactly as written', async () => {
    const tag = '<link rel="preload" as="font" href="a.woff2" integrity="sha256-STALE">';
    const { html, modified, warnings } = await inject(tag);
    expect(modified).toBe(false);
    expect(html).toContain(tag);
    expect(warnings).toEqual([]);
  });

  test('a link matching more than one rule is resolved only once', async () => {
    const seen = [];
    const { html } = await injectSri(
      '<html><head><link rel="stylesheet preload" as="style" href="a.css"></head><body></body></html>',
      (url) => { seen.push(url); return Buffer.from('x'); },
      { algorithm: 'sha256' }
    );
    expect(seen).toEqual(['a.css']);
    expect(html.match(/integrity=/g)).toHaveLength(1);
  });
});

describe('injectSri: absolute-URL base (CDN deployments)', () => {
  const CDN = 'https://cdn.example.com/';
  const page = (src) => `<html><head><script src="${src}"></script></head><body></body></html>`;
  const tracking = () => { const seen = []; return { seen, resolve: (u) => { seen.push(u); return Buffer.from('x'); } }; };

  test('treats URLs under the base as local and passes them to resolveAsset as written', async () => {
    const { seen, resolve } = tracking();
    const { html, errors } = await injectSri(page(CDN + 'assets/app.js'), resolve, { algorithm: 'sha256', base: CDN });
    expect(errors).toEqual([]);
    expect(seen).toEqual([CDN + 'assets/app.js']);
    expect(html).toContain('integrity="sha256-');
  });

  test('still skips URLs on other origins', async () => {
    const { seen, resolve } = tracking();
    const { html } = await injectSri(page('https://other.example.net/app.js'), resolve, { algorithm: 'sha256', base: CDN });
    expect(seen).toEqual([]);
    expect(html).not.toContain('integrity=');
  });

  test('matches on a path boundary: a base without trailing slash cannot match a look-alike host', async () => {
    const { seen, resolve } = tracking();
    const { html } = await injectSri(page('https://cdn.example.com.evil.io/app.js'), resolve, { algorithm: 'sha256', base: 'https://cdn.example.com' });
    expect(seen).toEqual([]);
    expect(html).not.toContain('integrity=');
  });

  test('a base without trailing slash still matches its own assets', async () => {
    const { seen, resolve } = tracking();
    await injectSri(page(CDN + 'app.js'), resolve, { algorithm: 'sha256', base: 'https://cdn.example.com' });
    expect(seen).toEqual([CDN + 'app.js']);
  });

  test('supports a protocol-relative base', async () => {
    const { seen, resolve } = tracking();
    await injectSri(page('//cdn.example.com/app.js'), resolve, { algorithm: 'sha256', base: '//cdn.example.com/' });
    expect(seen).toEqual(['//cdn.example.com/app.js']);
  });

  test('a path base does not change what counts as external', async () => {
    const { seen, resolve } = tracking();
    const { html } = await injectSri(page('https://cdn.example.com/app.js'), resolve, { algorithm: 'sha256', base: '/app/' });
    expect(seen).toEqual([]);
    expect(html).not.toContain('integrity=');
  });

  test('an unresolvable asset under the base is reported, not silently skipped', async () => {
    const { errors } = await injectSri(page(CDN + 'assets/missing.js'), () => null, { algorithm: 'sha256', base: CDN });
    expect(errors).toEqual([expect.stringMatching(/missing\.js.*could not be found/)]);
  });
});

describe('injectSri: existing integrity attributes', () => {
  const crypto = require('crypto');
  const CONTENT = Buffer.from('console.log("v2")');
  const digest = (alg) => `${alg}-${crypto.createHash(alg).update(CONTENT).digest('base64')}`;
  const resolve = () => CONTENT;
  const page = (attrs) => `<html><head><script src="app.js" ${attrs}></script></head><body></body></html>`;
  const inject = (attrs, algorithm = 'sha384') => injectSri(page(attrs), resolve, { algorithm });

  test('returns an empty warnings list when nothing needed correcting', async () => {
    const { warnings } = await inject('');
    expect(warnings).toEqual([]);
  });

  test('a valid existing value is verified and left untouched', async () => {
    const { html, warnings } = await inject(`integrity="${digest('sha384')}" crossorigin="anonymous"`);
    expect(html).toContain(`integrity="${digest('sha384')}"`);
    expect(warnings).toEqual([]);
  });

  test('a valid value using a different algorithm than configured is kept, not downgraded or upgraded', async () => {
    const { html, warnings } = await inject(`integrity="${digest('sha256')}" crossorigin="anonymous"`, 'sha512');
    expect(html).toContain(`integrity="${digest('sha256')}"`);
    expect(html).not.toContain('sha512-');
    expect(warnings).toEqual([]);
  });

  test('a valid multi-algorithm value is kept', async () => {
    const value = `${digest('sha256')} ${digest('sha512')}`;
    const { html, warnings } = await inject(`integrity="${value}" crossorigin="anonymous"`);
    expect(html).toContain(`integrity="${value}"`);
    expect(warnings).toEqual([]);
  });

  test('a stale value is replaced and reported with the URL and the old value', async () => {
    const { html, warnings, modified } = await inject('integrity="sha384-STALESTALESTALE" crossorigin="anonymous"');
    expect(modified).toBe(true);
    expect(html).toContain(`integrity="${digest('sha384')}"`);
    expect(html).not.toContain('STALE');
    expect(warnings).toEqual([expect.stringMatching(/app\.js.*sha384-STALESTALESTALE/)]);
  });

  test('a value where one of several tokens is stale is replaced', async () => {
    const { html, warnings } = await inject(`integrity="${digest('sha256')} sha512-WRONG" crossorigin="anonymous"`);
    expect(html).toContain(`integrity="${digest('sha384')}"`);
    expect(warnings).toHaveLength(1);
  });

  test.each([
    ['an unsupported algorithm', 'md5-AAAA'],
    ['a malformed token', 'not-an-sri-value'],
  ])('%s is replaced and reported', async (_name, value) => {
    const { html, warnings } = await inject(`integrity="${value}" crossorigin="anonymous"`);
    expect(html).toContain(`integrity="${digest('sha384')}"`);
    expect(warnings).toEqual([expect.stringMatching(new RegExp(value))]);
  });

  test('an empty integrity attribute is simply filled in, without a warning', async () => {
    const { html, warnings } = await inject('integrity="" crossorigin="anonymous"');
    expect(html).toContain(`integrity="${digest('sha384')}"`);
    expect(warnings).toEqual([]);
  });

  test('a valid value with a missing crossorigin still gets crossorigin added', async () => {
    const { html, modified } = await inject(`integrity="${digest('sha384')}"`);
    expect(modified).toBe(true);
    expect(html).toContain(`integrity="${digest('sha384')}"`);
    expect(html).toContain('crossorigin="anonymous"');
  });

  test('is idempotent: a second pass over its own output changes nothing', async () => {
    const first = await inject('');
    expect(first.modified).toBe(true);
    const second = await injectSri(first.html, resolve, { algorithm: 'sha384' });
    expect(second.modified).toBe(false);
    expect(second.html).toBe(first.html);
    expect(second.warnings).toEqual([]);
  });
});

describe('injectSri: changes (what a dry run or --check reports)', () => {
  const crypto = require('crypto');
  const CONTENT = Buffer.from('var a=1');
  const HASH = `sha384-${crypto.createHash('sha384').update(CONTENT).digest('base64')}`;
  const resolve = () => CONTENT;
  const run = (head, options = {}) => injectSri(`<html><head>${head}</head><body></body></html>`, resolve, { algorithm: 'sha384', ...options });

  test('a fresh tag reports added integrity and crossorigin, in that order', async () => {
    const { changes } = await run('<script src="a.js"></script>');
    expect(changes).toEqual([{ kind: 'add-integrity', url: 'a.js' }, { kind: 'add-crossorigin', url: 'a.js' }]);
  });

  test('a stale value is reported as replaced; an empty one as added', async () => {
    const stale = await run('<script src="a.js" integrity="sha384-STALE" crossorigin="anonymous"></script>');
    expect(stale.changes).toEqual([{ kind: 'replace-integrity', url: 'a.js' }]);
    const empty = await run('<script src="a.js" integrity="" crossorigin="anonymous"></script>');
    expect(empty.changes).toEqual([{ kind: 'add-integrity', url: 'a.js' }]);
  });

  test('a valid value with no crossorigin reports only the crossorigin', async () => {
    const { changes } = await run(`<script src="a.js" integrity="${HASH}"></script>`);
    expect(changes).toEqual([{ kind: 'add-crossorigin', url: 'a.js' }]);
  });

  test('the URL is the one resolved against <base href>, i.e. the file that was hashed', async () => {
    const { changes } = await run('<base href="/app/"><link rel="stylesheet" href="s.css">');
    expect(changes.map(c => c.url)).toEqual(['/app/s.css', '/app/s.css']);
  });

  test('a data-skip-sri tag gets no integrity and is not listed as a change; the marker is removed', async () => {
    const { html, changes, warnings } = await run('<script src="/rt.js" data-skip-sri></script>');
    expect(changes).toEqual([]);
    expect(html).toBe('<html><head><script src="/rt.js"></script></head><body></body></html>');
    expect(warnings).toEqual([]);
  });

  test('a bare skip-sri attribute is not an opt-out: the tag gets SRI like any other', async () => {
    const { html, changes } = await run('<script src="/rt.js" skip-sri></script>');
    expect(changes).toEqual([{ kind: 'add-integrity', url: '/rt.js' }, { kind: 'add-crossorigin', url: '/rt.js' }]);
    expect(html).toContain(`integrity="${HASH}"`);
  });

  test('adding or merging import map entries is a change; an up-to-date map is not', async () => {
    const importMapIntegrity = () => ({ '/lazy.js': 'sha384-LAZY' });
    const first = await run(`<script type="module" src="a.js" integrity="${HASH}" crossorigin></script>`, { importMapIntegrity });
    expect(first.changes).toEqual([{ kind: 'update-import-map' }]);
    const second = await injectSri(first.html, resolve, { algorithm: 'sha384', importMapIntegrity });
    expect(second.changes).toEqual([]);
  });

  test('problems are diagnostics, not changes: a missing or skipped resource changes nothing', async () => {
    const missing = await injectSri('<script src="gone.js"></script>', () => null);
    expect(missing.changes).toEqual([]);
    expect(missing.errors).toHaveLength(1);
    const { SkipResource } = require('../core');
    const skipped = await injectSri('<script src="https://x.example/a.js"></script>', resolve, { resolveExternal: () => { throw new SkipResource('no CORS'); } });
    expect(skipped.changes).toEqual([]);
  });

  test.each([
    ['an up-to-date tag', `<script src="a.js" integrity="${HASH}" crossorigin="anonymous"></script>`],
    ['a fresh tag', '<script src="a.js"></script>'],
    ['a stale tag', '<link rel="stylesheet" href="s.css" integrity="sha256-OLD">'],
    ['an external tag (skipped)', '<script src="https://cdn.example/x.js"></script>'],
    ['no tags at all', '<p>hi</p>'],
  ])('changes is empty exactly when no SRI edit was made: %s', async (_name, head) => {
    const { changes, modified } = await run(head);
    expect(changes.length > 0).toBe(modified);
  });
});

describe('injectSri: external resources via resolveExternal', () => {
  const { SkipResource } = require('../core');
  const EXT = 'https://www.example.com/some.js';
  const LOCAL = 'app.js';
  const page = (attrs = '') => `<html><head><script src="${EXT}" ${attrs}></script><script src="${LOCAL}"></script></head><body></body></html>`;
  const local = () => Buffer.from('local');

  test('without resolveExternal, external URLs are skipped (unchanged default)', async () => {
    const { html } = await injectSri(page(), local, { algorithm: 'sha256' });
    expect(html).toMatch(new RegExp(`<script src="${EXT}"\\s*></script>`));
    expect(html.match(/integrity=/g)).toHaveLength(1);
  });

  test('external URLs go to resolveExternal, local ones to resolveAsset', async () => {
    const seenExt = [], seenLocal = [];
    const { html, errors } = await injectSri(page(),
      (u) => { seenLocal.push(u); return local(); },
      { algorithm: 'sha256', resolveExternal: (u) => { seenExt.push(u); return Buffer.from('ext'); } });
    expect(seenExt).toEqual([EXT]);
    expect(seenLocal).toEqual([LOCAL]);
    expect(errors).toEqual([]);
    expect(html.match(/integrity=/g)).toHaveLength(2);
    expect(html).toMatch(new RegExp(`src="${EXT}"[^>]*crossorigin="anonymous"`));
  });

  test('null from resolveExternal is an error (could not protect)', async () => {
    const { errors } = await injectSri(page(), local, { algorithm: 'sha256', resolveExternal: () => null });
    expect(errors).toEqual([expect.stringMatching(/example\.com\/some\.js.*could not be found/)]);
  });

  test('a thrown error from resolveExternal is an error', async () => {
    const { errors } = await injectSri(page(), local, { algorithm: 'sha256', resolveExternal: () => { throw new Error('ECONNRESET'); } });
    expect(errors).toEqual([expect.stringMatching(/some\.js.*ECONNRESET/)]);
  });

  test('SkipResource from resolveExternal leaves the tag untouched and records a warning, not an error', async () => {
    const { html, errors, warnings } = await injectSri(page(), local, {
      algorithm: 'sha256', resolveExternal: () => { throw new SkipResource('server sends no Access-Control-Allow-Origin header'); },
    });
    expect(errors).toEqual([]);
    expect(warnings).toEqual([expect.stringMatching(/some\.js.*Access-Control-Allow-Origin/)]);
    expect(html).toMatch(new RegExp(`<script src="${EXT}"\\s*></script>`));
  });

  test('an existing hash on an external resource is verified against the fetched bytes', async () => {
    const crypto = require('crypto');
    const good = 'sha256-' + crypto.createHash('sha256').update('ext').digest('base64');
    const kept = await injectSri(page(`integrity="${good}" crossorigin="anonymous"`), local, { algorithm: 'sha384', resolveExternal: () => Buffer.from('ext') });
    expect(kept.warnings).toEqual([]);
    expect(kept.html).toContain(`integrity="${good}"`);

    const changed = await injectSri(page(`integrity="${good}" crossorigin="anonymous"`), local, { algorithm: 'sha384', resolveExternal: () => Buffer.from('ext-v2') });
    expect(changed.warnings).toEqual([expect.stringMatching(/some\.js.*did not match/)]);
    expect(changed.html).not.toContain(good);
  });

  test('protocol-relative URLs count as external', async () => {
    const seen = [];
    await injectSri('<html><head><script src="//cdn.example.com/x.js"></script></head><body></body></html>', local,
      { algorithm: 'sha256', resolveExternal: (u) => { seen.push(u); return Buffer.from('x'); } });
    expect(seen).toEqual(['//cdn.example.com/x.js']);
  });
});

describe('injectSri: import map integrity for module graphs', () => {
  const resolve = () => Buffer.from('x');
  const ENTRIES = { '/assets/lazy-abc.js': 'sha384-LAZY', '/assets/shared-def.js': 'sha384-SHARED' };
  const parseMap = (html) => JSON.parse(/<script type="importmap">([\s\S]*?)<\/script>/.exec(html)[1]);

  test('asks for integrity entries with the page\'s local script and modulepreload URLs (not externals, not styles)', async () => {
    let received;
    await injectSri(
      '<html><head><link rel="modulepreload" href="/assets/dep.js"><link rel="stylesheet" href="/a.css"><script type="module" src="/assets/entry.js"></script><script src="/legacy.js"></script><script src="https://other.example.net/x.js"></script></head><body></body></html>',
      resolve, { algorithm: 'sha256', importMapIntegrity: (urls) => { received = urls; return null; } });
    expect(received).toEqual(['/assets/dep.js', '/assets/entry.js', '/legacy.js']); // document order
  });

  test('adds an import map with the returned entries before the first module script', async () => {
    const { html, modified } = await injectSri(
      '<html><head><meta charset="utf-8"><script type="module" src="/assets/entry.js"></script></head><body></body></html>',
      resolve, { algorithm: 'sha256', importMapIntegrity: () => ENTRIES });
    expect(modified).toBe(true);
    expect(parseMap(html)).toEqual({ integrity: ENTRIES });
    expect(html.indexOf('type="importmap"')).toBeLessThan(html.indexOf('type="module"'));
    expect(html.indexOf('<meta')).toBeLessThan(html.indexOf('type="importmap"'));
  });

  test('places the import map before a modulepreload that precedes the module script', async () => {
    const { html } = await injectSri(
      '<html><head><link rel="modulepreload" href="/assets/dep.js"><script type="module" src="/assets/entry.js"></script></head><body></body></html>',
      resolve, { algorithm: 'sha256', importMapIntegrity: () => ENTRIES });
    const at = html.indexOf('type="importmap"');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(html.indexOf('modulepreload'));
  });

  test('merges into an existing import map instead of adding a second one', async () => {
    const { html } = await injectSri(
      '<html><head><script type="importmap">{"imports":{"vue":"/vendor/vue.js"},"integrity":{"/vendor/vue.js":"sha384-VUE"}}</script><script type="module" src="/assets/entry.js"></script></head><body></body></html>',
      resolve, { algorithm: 'sha256', importMapIntegrity: () => ENTRIES });
    expect(html.match(/type="importmap"/g)).toHaveLength(1);
    expect(parseMap(html)).toEqual({ imports: { vue: '/vendor/vue.js' }, integrity: { '/vendor/vue.js': 'sha384-VUE', ...ENTRIES } });
  });

  test('an existing import map with invalid JSON is an error and is left alone', async () => {
    const src = '<html><head><script type="importmap">{not json</script><script type="module" src="/assets/entry.js"></script></head><body></body></html>';
    const { html, errors } = await injectSri(src, resolve, { algorithm: 'sha256', importMapIntegrity: () => ENTRIES });
    expect(errors).toEqual([expect.stringMatching(/import map.*JSON/i)]);
    expect(html).toContain('{not json');
  });

  test('null or empty entries add nothing', async () => {
    const src = '<html><head><script type="module" src="/assets/entry.js" integrity="sha256-x" crossorigin="anonymous"></script></head><body></body></html>';
    for (const ret of [null, {}]) {
      const { html } = await injectSri(src, resolve, { algorithm: 'sha256', importMapIntegrity: () => ret });
      expect(html).not.toContain('importmap');
    }
  });

  test('is idempotent: a second pass leaves an up-to-date import map unchanged', async () => {
    const first = await injectSri('<html><head><script type="module" src="/assets/entry.js"></script></head><body></body></html>',
      resolve, { algorithm: 'sha256', importMapIntegrity: () => ENTRIES });
    expect(parseMap(first.html)).toEqual({ integrity: ENTRIES });
    const second = await injectSri(first.html, resolve, { algorithm: 'sha256', importMapIntegrity: () => ENTRIES });
    expect(second.modified).toBe(false);
    expect(second.html).toBe(first.html);
  });

  test('without the option, no import map is touched or added', async () => {
    const src = '<html><head><script type="importmap">{"imports":{}}</script><script type="module" src="/assets/entry.js"></script></head><body></body></html>';
    const { html } = await injectSri(src, resolve, { algorithm: 'sha256' });
    expect(html).toContain('<script type="importmap">{"imports":{}}</script>');
  });
});

describe('Integrity-Policy header', () => {
  const { buildIntegrityPolicyHeader, mergeHeadersFile, SkipResource } = require('../core');

  test('default header enforces integrity on scripts from inline metadata', () => {
    expect(buildIntegrityPolicyHeader()).toEqual({ name: 'Integrity-Policy', value: 'blocked-destinations=(script), sources=(inline)' });
  });

  test('report-only variant uses the report-only header name', () => {
    expect(buildIntegrityPolicyHeader({ reportOnly: true }).name).toBe('Integrity-Policy-Report-Only');
  });

  test('reporting endpoints are appended as an inner list of tokens', () => {
    expect(buildIntegrityPolicyHeader({ endpoints: ['integrity', 'csp-endpoint'] }).value)
      .toBe('blocked-destinations=(script), sources=(inline), endpoints=(integrity csp-endpoint)');
  });

  test('rejects endpoint names that are not structured-field tokens', () => {
    expect(() => buildIntegrityPolicyHeader({ endpoints: ['has space'] })).toThrow(/endpoint/i);
    expect(() => buildIntegrityPolicyHeader({ endpoints: ['"quoted"'] })).toThrow(/endpoint/i);
  });

  describe('injectSri reports scripts left without integrity', () => {
    const ok = () => Buffer.from('x');
    test('external scripts skipped by default, missing local files and CORS-less externals are listed; protected ones are not', async () => {
      const { unprotectedScripts } = await injectSri(
        '<html><head><script src="https://third.example.net/a.js"></script><script src="ok.js"></script><script src="missing.js"></script><script>inline()</script><link rel="stylesheet" href="a.css"></head><body></body></html>',
        (u) => (u === 'missing.js' ? null : ok()), { algorithm: 'sha256' });
      expect(unprotectedScripts).toEqual(['https://third.example.net/a.js', 'missing.js']);
    });
    test('an external skipped for lack of CORS is listed', async () => {
      const { unprotectedScripts } = await injectSri('<html><head><script src="https://third.example.net/a.js"></script></head><body></body></html>',
        ok, { algorithm: 'sha256', resolveExternal: () => { throw new SkipResource('no CORS'); } });
      expect(unprotectedScripts).toEqual(['https://third.example.net/a.js']);
    });
    test('is empty when every script is covered', async () => {
      const { unprotectedScripts } = await injectSri('<html><head><script src="a.js"></script><script type="module" src="b.js"></script></head><body></body></html>', ok, { algorithm: 'sha256' });
      expect(unprotectedScripts).toEqual([]);
    });
  });

  describe('mergeHeadersFile (Netlify / Cloudflare Pages _headers format)', () => {
    const header = { name: 'Integrity-Policy', value: 'blocked-destinations=(script), sources=(inline)' };
    test('creates a catch-all rule when there is no existing file', () => {
      expect(mergeHeadersFile('', header)).toBe('/*\n  Integrity-Policy: blocked-destinations=(script), sources=(inline)\n');
    });
    test('appends to existing content without disturbing it', () => {
      const existing = '/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n';
      const out = mergeHeadersFile(existing, header);
      expect(out.startsWith(existing)).toBe(true);
      expect(out).toMatch(/\n\/\*\n  Integrity-Policy: /);
    });
    test('is idempotent when the same header is already present', () => {
      const once = mergeHeadersFile('', header);
      expect(mergeHeadersFile(once, header)).toBe(once);
    });
    test('replaces a previous value of the same header rather than adding a second', () => {
      const stale = '/*\n  Integrity-Policy: blocked-destinations=(script), sources=(inline), endpoints=(old)\n';
      const out = mergeHeadersFile(stale, header);
      expect(out.match(/Integrity-Policy:/g)).toHaveLength(1);
      expect(out).not.toContain('endpoints=(old)');
    });
  });
});

describe('toFilePath', () => {
  const { toFilePath } = require('../core');
  test('strips query and fragment and decodes percent-escapes', () => {
    expect(toFilePath('/a%20b.js?v=1#x')).toBe('/a b.js');
  });
  test('returns malformed percent-encoding untouched instead of throwing', () => {
    expect(toFilePath('/bad%E0%A4%A.js?v=1')).toBe('/bad%E0%A4%A.js');
  });
});

test('normalizeIntegrityPolicy rejects values that are neither boolean, mode string nor object', () => {
  const { normalizeIntegrityPolicy } = require('../core');
  expect(() => normalizeIntegrityPolicy('block-everything')).toThrow(/Invalid integrityPolicy option/);
  expect(() => normalizeIntegrityPolicy(42)).toThrow(/Invalid integrityPolicy option/);
});

describe('import map placement when the page has no module script', () => {
  const { injectSri } = require('../core');
  const entries = { '/lazy.js': 'sha384-abc' };
  const run = (html) => injectSri(html, () => 'x', { importMapIntegrity: () => entries });

  test('appends to <head> when there is a head but no module script or modulepreload', async () => {
    const r = await run('<!doctype html><html><head><title>t</title></head><body><script src="/a.js"></script></body></html>');
    expect(r.html).toMatch(/<title>t<\/title><script type="importmap">/);
  });

  test('prepends to a bare fragment', async () => {
    const r = await run('<script src="/a.js"></script>');
    expect(r.html.startsWith('<script type="importmap">')).toBe(true);
  });
});

describe('crossorigin option', () => {
  const { injectSri, validateCrossorigin } = require('../core');
  const html = '<script src="/a.js"></script>';
  test('defaults to anonymous', async () => {
    expect((await injectSri(html, () => 'x')).html).toContain('crossorigin="anonymous"');
  });
  test('use-credentials is applied when requested', async () => {
    expect((await injectSri(html, () => 'x', { crossorigin: 'use-credentials' })).html).toContain('crossorigin="use-credentials"');
  });
  test('an unsupported value is rejected', async () => {
    await expect(injectSri(html, () => 'x', { crossorigin: 'sometimes' })).rejects.toThrow(/crossorigin/);
    expect(() => validateCrossorigin('')).toThrow(/crossorigin/);
  });
  test('validateCrossorigin returns supported values unchanged', () => {
    expect(validateCrossorigin('anonymous')).toBe('anonymous');
    expect(validateCrossorigin(undefined)).toBe('anonymous');
  });
});

describe('<base href>', () => {
  // Browsers resolve relative URLs against the first <base href>, so that is the file that gets fetched
  // (and must be the one that is hashed).
  const seen = async (html, options = {}) => {
    const urls = [];
    const r = await injectSri(html, (url) => { urls.push(url); return Buffer.from('x'); }, { algorithm: 'sha256', ...options });
    return { urls, ...r };
  };

  test('a relative URL resolves against a root-relative base', async () => {
    const { urls } = await seen('<html><head><base href="/sub/"><script src="app.js"></script></head></html>');
    expect(urls).toEqual(['/sub/app.js']);
  });

  test('a relative URL resolves against a relative base, from the HTML file\'s directory', async () => {
    const { urls } = await seen('<html><head><base href="sub/"><script src="app.js"></script></head></html>');
    expect(urls).toEqual(['sub/app.js']);
  });

  test('only the directory part of the base counts', async () => {
    const { urls } = await seen('<html><head><base href="/sub/index.html"><script src="../app.js"></script></head></html>');
    expect(urls).toEqual(['/app.js']);
  });

  test('query string and fragment on the tag survive resolution', async () => {
    const { urls } = await seen('<html><head><base href="/sub/"><script src="app.js?v=2#x"></script></head></html>');
    expect(urls).toEqual(['/sub/app.js?v=2#x']);
  });

  test('root-relative and absolute URLs ignore the base', async () => {
    const { urls } = await seen('<html><head><base href="/sub/"><script src="/app.js"></script><script src="https://cdn.example.net/x.js"></script></head></html>');
    expect(urls).toEqual(['/app.js']);
  });

  test('an absolute base that matches options.base makes relative URLs local', async () => {
    const { urls, html } = await seen(
      '<html><head><base href="https://cdn.example.com/app/"><script src="a.js"></script></head></html>',
      { base: 'https://cdn.example.com/' }
    );
    expect(urls).toEqual(['https://cdn.example.com/app/a.js']);
    expect(html).toContain('integrity="sha256-');
  });

  test('an absolute base on another host makes relative URLs external, so they are left alone', async () => {
    const { urls, modified } = await seen('<html><head><base href="https://other.example.net/"><script src="a.js"></script></head></html>');
    expect(urls).toEqual([]);
    expect(modified).toBe(false);
  });

  test('only the first <base> with an href counts', async () => {
    const { urls } = await seen('<html><head><base target="_blank"><base href="/one/"><base href="/two/"><script src="a.js"></script></head></html>');
    expect(urls).toEqual(['/one/a.js']);
  });

  test('the import-map root list uses the resolved URLs', async () => {
    let roots;
    await injectSri('<html><head><base href="/sub/"><script type="module" src="a.js"></script></head></html>',
      () => Buffer.from('x'), { algorithm: 'sha256', importMapIntegrity: (urls) => { roots = urls; return null; } });
    expect(roots).toEqual(['/sub/a.js']);
  });

  test('without a <base>, nothing changes', async () => {
    const { urls } = await seen('<html><head><script src="a.js"></script></head></html>');
    expect(urls).toEqual(['a.js']);
  });
});
