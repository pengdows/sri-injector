const http = require('http');
const zlib = require('zlib');
const { createExternalResolver } = require('../external');
const { SkipResource } = require('../core');

// A tiny third-party "CDN" with the response shapes that matter for SRI.
let server, origin;
const requests = [];
beforeAll(async () => {
  server = http.createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    switch (req.url) {
      case '/lib.js':
        res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/javascript' });
        return res.end('window.lib = 1;');
      case '/echo-origin.js':
        res.writeHead(200, { 'Access-Control-Allow-Origin': req.headers.origin, 'Vary': 'Origin' });
        return res.end('echo');
      case '/no-cors.js':
        res.writeHead(200, { 'Content-Type': 'text/javascript' });
        return res.end('window.noCors = 1;');
      case '/gzipped.js':
        res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Encoding': 'gzip' });
        return res.end(zlib.gzipSync('window.gz = 1;'));
      case '/redirect.js':
        res.writeHead(302, { Location: '/lib.js' });
        return res.end();
      case '/slow.js':
        return; // never responds
      case '/error.js':
        res.writeHead(500);
        return res.end('boom');
      default:
        res.writeHead(404);
        return res.end();
    }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise(r => server.close(r)));
beforeEach(() => { requests.length = 0; });

test('returns the response body for a CORS-enabled resource', async () => {
  const resolve = createExternalResolver();
  expect(Buffer.from(await resolve(`${origin}/lib.js`)).toString()).toBe('window.lib = 1;');
});

test('sends an Origin header so servers with dynamic CORS answer, and accepts an echoed origin', async () => {
  const resolve = createExternalResolver();
  expect(Buffer.from(await resolve(`${origin}/echo-origin.js`)).toString()).toBe('echo');
  expect(requests[0].headers.origin).toMatch(/^https?:\/\//);
});

test('throws SkipResource when the server sends no Access-Control-Allow-Origin (browser could not verify)', async () => {
  const resolve = createExternalResolver();
  await expect(resolve(`${origin}/no-cors.js`)).rejects.toThrow(SkipResource);
  await expect(resolve(`${origin}/no-cors.js`)).rejects.toThrow(/Access-Control-Allow-Origin/);
});

test('hashes the decoded body of a compressed response (what the browser verifies)', async () => {
  const resolve = createExternalResolver();
  expect(Buffer.from(await resolve(`${origin}/gzipped.js`)).toString()).toBe('window.gz = 1;');
});

test('follows redirects', async () => {
  const resolve = createExternalResolver();
  expect(Buffer.from(await resolve(`${origin}/redirect.js`)).toString()).toBe('window.lib = 1;');
});

test('returns null for a 404', async () => {
  const resolve = createExternalResolver();
  expect(await resolve(`${origin}/missing.js`)).toBeNull();
});

test('throws (an error, not a skip) on a 5xx', async () => {
  const resolve = createExternalResolver();
  await expect(resolve(`${origin}/error.js`)).rejects.toThrow(/500/);
});

test('times out', async () => {
  const resolve = createExternalResolver({ timeout: 200 });
  await expect(resolve(`${origin}/slow.js`)).rejects.toThrow(/timed out/i);
});

test('fetches each URL once per resolver, even when requested concurrently', async () => {
  const resolve = createExternalResolver();
  await Promise.all([resolve(`${origin}/lib.js`), resolve(`${origin}/lib.js`), resolve(`${origin}/lib.js`)]);
  expect(requests.filter(r => r.url === '/lib.js')).toHaveLength(1);
});

describe('URL handling (injected fetch)', () => {
  const fakeFetch = (seen) => async (url) => {
    seen.push(String(url));
    return new Response('x', { status: 200, headers: { 'Access-Control-Allow-Origin': '*' } });
  };

  test('protocol-relative URLs are fetched over https', async () => {
    const seen = [];
    await createExternalResolver({ fetch: fakeFetch(seen) })('//cdn.example.com/x.js');
    expect(seen).toEqual(['https://cdn.example.com/x.js']);
  });

  test('surfaces the underlying network cause instead of Node\'s bare "fetch failed"', async () => {
    const failing = async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND cdn.example.com'), { code: 'ENOTFOUND' }) }); };
    await expect(createExternalResolver({ fetch: failing })('https://cdn.example.com/x.js')).rejects.toThrow(/ENOTFOUND cdn\.example\.com/);
  });

  test('non-http(s) schemes are skipped with a warning, not fetched', async () => {
    const seen = [];
    const resolve = createExternalResolver({ fetch: fakeFetch(seen) });
    await expect(resolve('data:text/javascript,alert(1)')).rejects.toThrow(SkipResource);
    await expect(resolve('ftp://example.com/x.js')).rejects.toThrow(SkipResource);
    expect(seen).toEqual([]);
  });
});
