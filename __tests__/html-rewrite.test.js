/**
 * injectSri edits only the tags it protects: every other byte of the page stays exactly as written
 * (case, quoting, whitespace, comments, line endings, doctype). Verified by exact output and by an
 * invariant: removing the attributes we add from the output gives back the input.
 */
const { injectSri } = require('../core');

const run = (html, resolve = () => 'x', options = { algorithm: 'sha256' }) => injectSri(html, resolve, options);
const SRI = /sha256-[A-Za-z0-9+/]+=*/.source;
// what injectSri adds to a tag
const ADDED = new RegExp(` integrity="${SRI}"| crossorigin="anonymous"`, 'g');
const without = (s) => s.replace(ADDED, '');

describe('only the protected tags change', () => {
  test('exact output: attributes are appended after the last attribute, nothing else moves', async () => {
    const r = await run('<script async src=/a.js ></script>');
    expect(r.html).toMatch(new RegExp(`^<script async src=/a\\.js integrity="${SRI}" crossorigin="anonymous" ></script>$`));
  });

  test('boolean attributes are not rewritten to async=""', async () => {
    const r = await run('<script src="/a.js" async defer></script>');
    expect(r.html).toContain(' async defer');
    expect(r.html).not.toContain('async=""');
  });

  test('case, quoting, whitespace, comments and entities elsewhere survive byte-for-byte', async () => {
    const input = [
      '<!DOCTYPE html>',
      '<HTML lang=en>',
      '<HEAD>',
      "\t<META charset='utf-8'>",
      '  <!-- keep   this   comment -->',
      '<TITLE>Caf&eacute; &amp; &#169; é</TITLE>',
      '<SCRIPT   SRC = "/a.js"\n   TYPE="module"  ></SCRIPT>',
      '<link REL=Stylesheet HREF=/s.css>',
      '</HEAD>',
      '<BODY><p>x</p><br/><img src="x.png" alt=\'a "q"\'></BODY>',
      '</HTML>',
    ].join('\n');
    const r = await run(input);
    expect(r.modified).toBe(true);
    expect(r.html).toMatch(/<SCRIPT {3}SRC = "\/a\.js"\n {3}TYPE="module" integrity="/);
    expect(without(r.html)).toBe(input);
  });

  test('a page with nothing to protect is returned as the same string', async () => {
    const input = '<p>hello</p>\r\n<script>inline()</script>';
    const r = await run(input);
    expect(r.modified).toBe(false);
    expect(r.html).toBe(input);
  });

  test('CRLF line endings and non-BMP characters before the tag do not shift the edit', async () => {
    const input = '<!doctype html>\r\n<html>\r\n<head>\r\n<title>\u{1F600}\u{1F4A9} café</title>\r\n<script src="/a.js"></script>\r\n</head>\r\n</html>\r\n';
    const r = await run(input);
    expect(r.html).toMatch(new RegExp(`<script src="/a\\.js" integrity="${SRI}" crossorigin="anonymous"></script>\\r\\n</head>`));
    expect(without(r.html)).toBe(input);
  });

  test('a self-closing slash stays where it was', async () => {
    const r = await run('<link rel="stylesheet" href="/s.css"/>');
    expect(r.html).toMatch(new RegExp(`^<link rel="stylesheet" href="/s\\.css" integrity="${SRI}" crossorigin="anonymous"/>$`));
  });

  test('upper-case tag and attribute names are recognised', async () => {
    const r = await run('<SCRIPT SRC="/a.js"></SCRIPT>');
    expect(r.html).toMatch(/<SCRIPT SRC="\/a\.js" integrity="sha256-/);
  });

  test('a stale integrity is replaced in place, keeping its position and quoting style', async () => {
    const r = await run('<script src="/a.js" integrity=\'sha256-STALE\' crossorigin></script>');
    expect(r.html).toMatch(new RegExp(`^<script src="/a\\.js" integrity="${SRI}" crossorigin></script>$`));
    expect(r.warnings).toHaveLength(1);
  });

  test('links inside <noscript> are protected too', async () => {
    const r = await run('<head><noscript><link rel="stylesheet" href="/n.css"></noscript></head>');
    expect(r.html).toMatch(/<noscript><link rel="stylesheet" href="\/n\.css" integrity="sha256-/);
  });

  test('skip-sri is removed along with its leading whitespace, leaving the rest of the tag alone', async () => {
    const r = await run('<script src="/runtime-config.js"   skip-sri  defer></script>');
    expect(r.html).toBe('<script src="/runtime-config.js"  defer></script>');
  });

  test('script bodies and style text containing tag-like strings are not touched', async () => {
    const input = '<script>var s = "<script src=\'/fake.js\'></script>";</script><style>a::after{content:"<link href=x>"}</style><script src="/a.js"></script>';
    const r = await run(input);
    expect(r.html.match(/integrity=/g)).toHaveLength(1);
    expect(without(r.html)).toBe(input);
  });
});

describe('import map insertion keeps the page intact too', () => {
  const entries = () => ({ '/lazy.js': 'sha256-abc' });
  const withMap = (html) => injectSri(html, () => 'x', { algorithm: 'sha256', importMapIntegrity: entries });

  test('is inserted immediately before the first module script', async () => {
    const input = '<head>\n  <title>t</title>\n  <script type="module" src="/a.js"></script>\n</head>';
    const r = await withMap(input);
    expect(r.html).toContain('<title>t</title>\n  <script type="importmap">{"integrity":{"/lazy.js":"sha256-abc"}}</script><script type="module" src="/a.js"');
    expect(without(r.html).replace(/<script type="importmap">[^<]*<\/script>/, '')).toBe(input);
  });

  test('an existing import map has only its text replaced', async () => {
    const input = '<head><script  type="importmap"  >{"imports":{"a":"/a.js"}}</script><script type="module" src="/m.js"></script></head>';
    const r = await withMap(input);
    expect(r.html).toContain('<script  type="importmap"  >{"imports":{"a":"/a.js"},"integrity":{"/lazy.js":"sha256-abc"}}</script>');
  });

  test('with no module script it goes at the end of <head>', async () => {
    const r = await withMap('<html><head><title>t</title></head><body><script src="/a.js"></script></body></html>');
    expect(r.html).toContain('<title>t</title><script type="importmap">');
    expect(r.html).toMatch(/importmap">[^<]*<\/script><\/head><body>/);
  });

  test('with no head element at all it goes first, after the doctype if there is one', async () => {
    expect((await withMap('<script src="/a.js"></script>')).html.startsWith('<script type="importmap">')).toBe(true);
    const r = await withMap('<!doctype html>\n<script src="/a.js"></script>');
    expect(r.html.startsWith('<!doctype html>\n<script type="importmap">')).toBe(true);
  });

  test('invalid JSON in an existing import map is reported, and the map is left alone', async () => {
    const input = '<script type="importmap">{not json</script><script src="/a.js"></script>';
    const r = await withMap(input);
    expect(r.errors.join()).toMatch(/not valid JSON/);
    expect(r.html).toContain('{not json</script>');
  });
});

describe('invariant over a set of awkward pages', () => {
  const pages = [
    '<!doctype html><html><head><meta charset=utf-8><script src=a.js></script><link rel=stylesheet href=b.css></head><body></body></html>',
    '<html><body><script src="a.js"></script></body></html>',
    '<script src="a.js"></script><script src="b.js"></script>',
    '<head><link rel="preload" as="script" href="a.js"><link rel="modulepreload" href="b.js"></head>',
    '<table><tr><td><script src="a.js"></script></td></tr></table>',
    '<template><script src="a.js"></script></template>',
    '<p>unclosed <b>bold <script src="a.js"></script>',
    '<svg><script href="a.js"></script></svg><script src="b.js"></script>',
  ];
  test.each(pages.map((p, i) => [i, p]))('page %i: removing what we added gives back the input', async (_i, input) => {
    const r = await run(input);
    expect(without(r.html)).toBe(input);
  });
});
