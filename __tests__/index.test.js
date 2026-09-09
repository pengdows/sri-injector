const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { execFileSync } = require('child_process');
const SubresourceIntegrityInjector = require('../SubresourceIntegrityInjector');

const TEST_ROOT = path.join(__dirname, 'test_dist');

function freshDir(name) {
  const dir = path.join(TEST_ROOT, name);
  fs.removeSync(dir);
  fs.ensureDirSync(dir);
  return dir;
}

function hashOf(algorithm, content) {
  return `${algorithm}-${crypto.createHash(algorithm).update(content).digest('base64')}`;
}

// Stands in for a CDN: serves fixed content over plain HTTP on localhost so
// external-resource tests are deterministic and need no real network access.
function startTestServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function stopTestServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

afterAll(() => {
  fs.removeSync(TEST_ROOT);
});

test('constructor rejects an unsupported algorithm', () => {
  expect(() => new SubresourceIntegrityInjector({ algorithm: 'md5' })).toThrow(/Unsupported SRI hash algorithm/);
});

test.each(['sha256', 'sha384', 'sha512'])('computes a correct %s integrity value', async (algorithm) => {
  const dir = freshDir(`algo-${algorithm}`);
  const jsContent = 'console.log("hello world");';
  fs.writeFileSync(path.join(dir, 'app.js'), jsContent);
  fs.writeFileSync(path.join(dir, 'index.html'), '<html><head><script src="app.js"></script></head><body></body></html>');

  const injector = new SubresourceIntegrityInjector({ algorithm });
  await injector.insertSRIInFile(path.join(dir, 'index.html'), dir);

  const updated = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const expected = hashOf(algorithm, jsContent);
  expect(updated).toContain(`integrity="${expected}"`);
  expect(updated).toContain('crossorigin="anonymous"');
});

test('preserves existing attributes regardless of their position relative to src/href', async () => {
  const dir = freshDir('attr-order');
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(1);');
  fs.writeFileSync(path.join(dir, 'style.css'), 'body{color:red;}');
  fs.writeFileSync(
    path.join(dir, 'index.html'),
    '<html><head>' +
      '<script defer type="module" src="app.js" data-foo="bar"></script>' +
      '<link rel="stylesheet" media="screen" href="style.css">' +
      '</head><body></body></html>'
  );

  const injector = new SubresourceIntegrityInjector();
  const report = await injector.insertSRIInFile(path.join(dir, 'index.html'), dir);

  const updated = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  expect(report.processed).toHaveLength(2);
  expect(updated).toMatch(/<script[^>]*defer[^>]*>/);
  expect(updated).toMatch(/<script[^>]*type="module"[^>]*>/);
  expect(updated).toMatch(/<script[^>]*data-foo="bar"[^>]*>/);
  expect(updated).toMatch(/<script[^>]*integrity="sha384-[^"]+"[^>]*>/);
  expect(updated).toMatch(/<link[^>]*media="screen"[^>]*>/);
  expect(updated).toMatch(/<link[^>]*integrity="sha384-[^"]+"[^>]*>/);
});

test('only injects into link tags whose rel is SRI-relevant', async () => {
  const dir = freshDir('link-rel-filter');
  fs.writeFileSync(path.join(dir, 'style.css'), 'body{color:red;}');
  fs.writeFileSync(
    path.join(dir, 'index.html'),
    '<html><head>' +
      '<link rel="canonical" href="https://example.com/page">' +
      '<link rel="icon" href="favicon.ico">' +
      '<link rel="stylesheet" href="style.css">' +
      '</head><body></body></html>'
  );

  const injector = new SubresourceIntegrityInjector();
  const report = await injector.insertSRIInFile(path.join(dir, 'index.html'), dir);

  const updated = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  expect(report.processed).toHaveLength(1);
  expect(report.processed[0].src).toBe('style.css');
  expect(updated).toMatch(/<link rel="canonical" href="https:\/\/example\.com\/page"\s*\/?>/);
  expect(updated).not.toMatch(/rel="canonical"[^>]*integrity/);
  expect(updated).not.toMatch(/rel="icon"[^>]*integrity/);
});

test('skips data: URIs without any fetch or filesystem access', async () => {
  const dir = freshDir('data-uri');
  fs.writeFileSync(
    path.join(dir, 'index.html'),
    '<html><head><script src="data:text/javascript,console.log(1)"></script></head><body></body></html>'
  );

  const injector = new SubresourceIntegrityInjector();
  const report = await injector.insertSRIInFile(path.join(dir, 'index.html'), dir);

  expect(report.errors).toHaveLength(0);
  expect(report.skipped).toEqual([{ src: 'data:text/javascript,console.log(1)', reason: 'data-uri' }]);
  const updated = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  expect(updated).not.toContain('integrity=');
});

describe('external (CDN) resources', () => {
  let server;
  let baseUrl;
  let requestLog;
  let flakyShouldFail;

  beforeAll(async () => {
    requestLog = [];
    flakyShouldFail = false;
    server = await startTestServer((req, res) => {
      requestLog.push(req.url);
      if (req.url === '/lib.js') {
        res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/javascript' });
        res.end('console.log("from cdn");');
        return;
      }
      if (req.url === '/no-cors.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end('console.log("no cors headers");');
        return;
      }
      if (req.url === '/missing.js') {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      if (req.url === '/flaky.js') {
        if (flakyShouldFail) {
          res.writeHead(503);
          res.end('temporarily unavailable');
          return;
        }
        res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/javascript' });
        res.end('console.log("flaky");');
        return;
      }
      res.writeHead(500);
      res.end('unexpected');
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(() => stopTestServer(server));

  beforeEach(() => {
    requestLog.length = 0;
    flakyShouldFail = false;
  });

  test('fetches an external resource and computes its integrity value', async () => {
    const dir = freshDir('external-fetch');
    fs.writeFileSync(
      path.join(dir, 'index.html'),
      `<html><head><script src="${baseUrl}/lib.js"></script></head><body></body></html>`
    );

    const injector = new SubresourceIntegrityInjector();
    const report = await injector.insertSRIInFile(path.join(dir, 'index.html'), dir);

    expect(report.errors).toHaveLength(0);
    expect(report.processed).toHaveLength(1);
    expect(report.processed[0].external).toBe(true);
    expect(report.processed[0].integrity).toBe(hashOf('sha384', 'console.log("from cdn");'));
    const updated = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    expect(updated).toContain(`integrity="${hashOf('sha384', 'console.log("from cdn");')}"`);
    expect(updated).toContain('crossorigin="anonymous"');
  });

  test('resolves protocol-relative URLs using defaultProtocol', async () => {
    const dir = freshDir('external-protocol-relative');
    const port = server.address().port;
    fs.writeFileSync(
      path.join(dir, 'index.html'),
      `<html><head><script src="//127.0.0.1:${port}/lib.js"></script></head><body></body></html>`
    );

    const injector = new SubresourceIntegrityInjector({ defaultProtocol: 'http:' });
    const report = await injector.insertSRIInFile(path.join(dir, 'index.html'), dir);

    expect(report.errors).toHaveLength(0);
    expect(report.processed).toHaveLength(1);
    expect(report.processed[0].url).toBe(`http://127.0.0.1:${port}/lib.js`);
  });

  test('warns when the external response lacks CORS headers', async () => {
    const dir = freshDir('external-no-cors');
    fs.writeFileSync(
      path.join(dir, 'index.html'),
      `<html><head><script src="${baseUrl}/no-cors.js"></script></head><body></body></html>`
    );

    const injector = new SubresourceIntegrityInjector();
    const report = await injector.insertSRIInFile(path.join(dir, 'index.html'), dir);

    expect(report.processed).toHaveLength(1);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0].warning).toMatch(/Access-Control-Allow-Origin/);
  });

  test('collects an HTTP error response as an error, not a crash', async () => {
    const dir = freshDir('external-404');
    fs.writeFileSync(
      path.join(dir, 'index.html'),
      `<html><head><script src="${baseUrl}/missing.js"></script></head><body></body></html>`
    );

    const injector = new SubresourceIntegrityInjector();
    const report = await injector.insertSRIInFile(path.join(dir, 'index.html'), dir);

    expect(report.processed).toHaveLength(0);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0].error).toMatch(/404/);
  });

  test('fetchExternal: false skips external resources without making a request', async () => {
    const dir = freshDir('external-fetch-disabled');
    fs.writeFileSync(
      path.join(dir, 'index.html'),
      `<html><head><script src="${baseUrl}/lib.js"></script></head><body></body></html>`
    );

    const injector = new SubresourceIntegrityInjector({ fetchExternal: false });
    const report = await injector.insertSRIInFile(path.join(dir, 'index.html'), dir);

    expect(report.errors).toHaveLength(0);
    expect(report.processed).toHaveLength(0);
    expect(report.skipped).toEqual([{ src: `${baseUrl}/lib.js`, reason: 'fetch-disabled' }]);
    expect(requestLog).toHaveLength(0);
  });

  test('caches repeated requests to the same external URL within one run', async () => {
    const dir = freshDir('external-cache');
    fs.writeFileSync(
      path.join(dir, 'index.html'),
      `<html><head>` +
        `<script src="${baseUrl}/lib.js"></script>` +
        `<link rel="preload" as="script" href="${baseUrl}/lib.js">` +
        `</head><body></body></html>`
    );

    const injector = new SubresourceIntegrityInjector();
    const report = await injector.insertSRIInFile(path.join(dir, 'index.html'), dir);

    expect(report.processed).toHaveLength(2);
    expect(requestLog.filter((u) => u === '/lib.js')).toHaveLength(1);
  });

  test('a successful fetch records an entry in the lock file', async () => {
    const dir = freshDir('lock-record');
    const lockFilePath = path.join(dir, 'sri-lock.json');
    fs.writeFileSync(
      path.join(dir, 'index.html'),
      `<html><head><script src="${baseUrl}/lib.js"></script></head><body></body></html>`
    );

    const injector = new SubresourceIntegrityInjector({ lockFilePath });
    await injector.insertSRIInFile(path.join(dir, 'index.html'), dir);

    expect(fs.existsSync(lockFilePath)).toBe(true);
    const lock = JSON.parse(fs.readFileSync(lockFilePath, 'utf8'));
    const key = `sha384::${baseUrl}/lib.js`;
    expect(lock.entries[key].integrity).toBe(hashOf('sha384', 'console.log("from cdn");'));
  });

  test('a later fetch failure falls back to the cached lock-file hash instead of failing', async () => {
    const dir = freshDir('lock-fallback');
    const lockFilePath = path.join(dir, 'sri-lock.json');
    fs.writeFileSync(
      path.join(dir, 'index.html'),
      `<html><head><script src="${baseUrl}/flaky.js"></script></head><body></body></html>`
    );

    const firstInjector = new SubresourceIntegrityInjector({ lockFilePath });
    const firstReport = await firstInjector.insertSRIInFile(path.join(dir, 'index.html'), dir);
    const goodIntegrity = firstReport.processed[0].integrity;

    flakyShouldFail = true;
    const secondInjector = new SubresourceIntegrityInjector({ lockFilePath });
    const secondReport = await secondInjector.insertSRIInFile(path.join(dir, 'index.html'), dir);

    expect(secondReport.errors).toHaveLength(0);
    expect(secondReport.processed).toHaveLength(1);
    expect(secondReport.processed[0].usedCachedHash).toBe(true);
    expect(secondReport.processed[0].integrity).toBe(goodIntegrity);
    expect(secondReport.warnings[0].warning).toMatch(/Fetch failed/);
  });

  test('a fetch failure with no prior lock entry is still a hard error', async () => {
    const dir = freshDir('lock-no-fallback');
    const lockFilePath = path.join(dir, 'sri-lock.json');
    flakyShouldFail = true;
    fs.writeFileSync(
      path.join(dir, 'index.html'),
      `<html><head><script src="${baseUrl}/flaky.js"></script></head><body></body></html>`
    );

    const injector = new SubresourceIntegrityInjector({ lockFilePath });
    const report = await injector.insertSRIInFile(path.join(dir, 'index.html'), dir);

    expect(report.processed).toHaveLength(0);
    expect(report.errors).toHaveLength(1);
  });
});

test('collects a missing local file as an error and keeps processing other tags', async () => {
  const dir = freshDir('missing-file');
  fs.writeFileSync(path.join(dir, 'exists.js'), 'console.log(1);');
  fs.writeFileSync(
    path.join(dir, 'index.html'),
    '<html><head>' +
      '<script src="missing.js"></script>' +
      '<script src="exists.js"></script>' +
      '</head><body></body></html>'
  );

  const injector = new SubresourceIntegrityInjector();
  const report = await injector.insertSRIInFile(path.join(dir, 'index.html'), dir);

  expect(report.errors).toHaveLength(1);
  expect(report.errors[0].src).toBe('missing.js');
  expect(report.processed).toHaveLength(1);
  expect(report.processed[0].src).toBe('exists.js');
});

test('rejects a resource path that escapes the base directory', async () => {
  const dir = freshDir('traversal');
  const outside = freshDir('traversal-outside');
  fs.writeFileSync(path.join(outside, 'secret.js'), 'console.log("secret");');
  fs.writeFileSync(
    path.join(dir, 'index.html'),
    `<html><head><script src="../traversal-outside/secret.js"></script></head><body></body></html>`
  );

  const injector = new SubresourceIntegrityInjector();
  const report = await injector.insertSRIInFile(path.join(dir, 'index.html'), dir);

  expect(report.processed).toHaveLength(0);
  expect(report.errors).toHaveLength(1);
  expect(report.errors[0].error).toMatch(/escapes the output directory|escapes/i);
});

test('re-running on already-processed HTML is idempotent', async () => {
  const dir = freshDir('idempotent');
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(1);');
  fs.writeFileSync(path.join(dir, 'index.html'), '<html><head><script src="app.js"></script></head><body></body></html>');

  const injector = new SubresourceIntegrityInjector();
  await injector.insertSRIInFile(path.join(dir, 'index.html'), dir);
  const firstPass = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  await injector.insertSRIInFile(path.join(dir, 'index.html'), dir);
  const secondPass = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');

  expect(secondPass).toBe(firstPass);
  expect((secondPass.match(/integrity="/g) || []).length).toBe(1);
  expect((secondPass.match(/crossorigin="/g) || []).length).toBe(1);
});

test('insertSRIInDirectory recurses into nested HTML files', async () => {
  const dir = freshDir('multi-file');
  fs.ensureDirSync(path.join(dir, 'nested'));
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log("root");');
  fs.writeFileSync(path.join(dir, 'nested', 'app.js'), 'console.log("nested");');
  fs.writeFileSync(path.join(dir, 'index.html'), '<html><head><script src="app.js"></script></head><body></body></html>');
  fs.writeFileSync(path.join(dir, 'nested', 'page.html'), '<html><head><script src="app.js"></script></head><body></body></html>');

  const injector = new SubresourceIntegrityInjector();
  const report = await injector.insertSRIInDirectory(dir);

  expect(report.processed).toHaveLength(2);
  const rootHtml = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const nestedHtml = fs.readFileSync(path.join(dir, 'nested', 'page.html'), 'utf8');
  expect(rootHtml).toContain('integrity=');
  expect(nestedHtml).toContain('integrity=');
});

test('CLI processes a directory and reports success', () => {
  const dir = freshDir('cli');
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(1);');
  fs.writeFileSync(path.join(dir, 'index.html'), '<html><head><script src="app.js"></script></head><body></body></html>');

  const cliPath = path.join(__dirname, '..', 'bin', 'cli.js');
  const output = execFileSync('node', [cliPath, '--dir', dir], { encoding: 'utf8' });

  expect(output).toContain('Processed 1 resource(s).');
  const updated = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  expect(updated).toContain('integrity=');
});

test('CLI exits non-zero and prints usage when --dir is missing', () => {
  const cliPath = path.join(__dirname, '..', 'bin', 'cli.js');
  expect(() => execFileSync('node', [cliPath], { encoding: 'utf8' })).toThrow();
});

