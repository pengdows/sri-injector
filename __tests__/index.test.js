const fs = require('fs-extra');
const path = require('path');
const SubresourceIntegrityInjector = require('../SubresourceIntegrityInjector')

const TEST_DIR = path.join(__dirname, 'test_dist');
const HTML_FILE = path.join(TEST_DIR, 'index.html');

beforeEach(() => {
  // Create a test directory and an index.html file
  fs.removeSync(TEST_DIR);
  fs.ensureDirSync(TEST_DIR);
  const jsContent = 'console.log("hello world");';
  const jsPath = path.join(TEST_DIR, 'test.js');
  fs.writeFileSync(jsPath, jsContent);
  
  const cssContent = 'body { color: red; }';
  const cssPath = path.join(TEST_DIR, 'test.css');
  fs.writeFileSync(cssPath, cssContent);

  fs.writeFileSync(HTML_FILE, '<html><head><link rel="stylesheet" href="test.css"/><script src="test.js" async defer></script></head><body></body></html>');
});

afterAll(() => {
  // Clean up after tests are done
  fs.removeSync(TEST_DIR);
});

test('insertSRIInHTML should add SRI attributes to script and preserve existing ones', async () => {
  const s = new SubresourceIntegrityInjector();
  await s.insertSRIInHTML(TEST_DIR, 'sha256');
  
  const updatedHtmlContent = fs.readFileSync(HTML_FILE, 'utf-8');
  expect(updatedHtmlContent).toContain('src="test.js"');
  // boolean attributes are preserved exactly as written, not rewritten to async=""
  expect(updatedHtmlContent).toContain(' async defer');
  expect(updatedHtmlContent).not.toContain('async=""');
  expect(updatedHtmlContent).toContain('integrity="sha256-');
  expect(updatedHtmlContent).toContain('crossorigin="anonymous"');
});

test('insertSRIInHTML should add SRI attributes for link stylesheet', async () => {
  const s = new SubresourceIntegrityInjector();
  await s.insertSRIInHTML(TEST_DIR, 'sha256');
  
  const updatedHtmlContent = fs.readFileSync(HTML_FILE, 'utf-8');
  expect(updatedHtmlContent).toContain('rel="stylesheet"');
  expect(updatedHtmlContent).toContain('href="test.css"');
  expect(updatedHtmlContent).toContain('integrity="sha256-');
  expect(updatedHtmlContent).toContain('crossorigin="anonymous"');
});

test('insertSRIInHTML should skip external resources', async () => {
  fs.writeFileSync(HTML_FILE, '<html><head><script src="https://example.com/app.js"></script></head><body></body></html>');
  const s = new SubresourceIntegrityInjector();
  await s.insertSRIInHTML(TEST_DIR, 'sha256');
  
  const updatedHtmlContent = fs.readFileSync(HTML_FILE, 'utf-8');
  expect(updatedHtmlContent).not.toContain('integrity=');
});

test('insertSRIInHTML should prevent path traversal', async () => {
    // Create a file outside the output dir
    const secretPath = path.join(__dirname, 'secret.txt');
    fs.writeFileSync(secretPath, 'secret data');
    
    fs.writeFileSync(HTML_FILE, '<html><head><script src="../secret.txt"></script></head><body></body></html>');
    
    const s = new SubresourceIntegrityInjector();
    await s.insertSRIInHTML(TEST_DIR, 'sha256');
    
    const updatedHtmlContent = fs.readFileSync(HTML_FILE, 'utf-8');
    expect(updatedHtmlContent).not.toContain('integrity=');
    
    fs.removeSync(secretPath);
});

test('resolves root-relative URLs against the output directory', async () => {
    fs.ensureDirSync(path.join(TEST_DIR, 'assets'));
    fs.writeFileSync(path.join(TEST_DIR, 'assets', 'app.js'), 'var a=1;');
    fs.writeFileSync(HTML_FILE, '<html><head><script src="/assets/app.js"></script></head><body></body></html>');
    await new SubresourceIntegrityInjector().insertSRIInHTML(TEST_DIR, 'sha256');
    expect(fs.readFileSync(HTML_FILE, 'utf-8')).toContain('integrity="sha256-');
});

test('serializes script tags with explicit closing tags (not self-closed)', async () => {
    await new SubresourceIntegrityInjector().insertSRIInHTML(TEST_DIR, 'sha256');
    const out = fs.readFileSync(HTML_FILE, 'utf-8');
    expect(out).toMatch(/<script [^>]*><\/script>/);
    expect(out).not.toMatch(/<script [^>]*\/>/);
});

test('does not treat local files starting with "http" as external', async () => {
    fs.writeFileSync(path.join(TEST_DIR, 'http-utils.js'), 'var h=1;');
    fs.writeFileSync(HTML_FILE, '<html><head><script src="http-utils.js"></script></head><body></body></html>');
    await new SubresourceIntegrityInjector().insertSRIInHTML(TEST_DIR, 'sha256');
    expect(fs.readFileSync(HTML_FILE, 'utf-8')).toContain('integrity="sha256-');
});

test('ignores query strings and fragments when locating files', async () => {
    fs.writeFileSync(HTML_FILE, '<html><head><script src="test.js?v=3#x"></script></head><body></body></html>');
    await new SubresourceIntegrityInjector().insertSRIInHTML(TEST_DIR, 'sha256');
    expect(fs.readFileSync(HTML_FILE, 'utf-8')).toContain('integrity="sha256-');
});

test('rejects sibling directories sharing the output dir prefix', async () => {
    const evil = TEST_DIR + '-evil';
    fs.ensureDirSync(evil);
    fs.writeFileSync(path.join(evil, 'x.js'), 'evil');
    fs.writeFileSync(HTML_FILE, '<html><head><script src="../test_dist-evil/x.js"></script></head><body></body></html>');
    await new SubresourceIntegrityInjector().insertSRIInHTML(TEST_DIR, 'sha256');
    expect(fs.readFileSync(HTML_FILE, 'utf-8')).not.toContain('integrity=');
    fs.removeSync(evil);
});

test('strict mode rejects when a resource is missing; default resolves and reports the errors', async () => {
    fs.writeFileSync(HTML_FILE, '<html><head><script src="nope.js"></script></head><body></body></html>');
    const s = new SubresourceIntegrityInjector();
    await expect(s.insertSRIInHTML(TEST_DIR, 'sha256')).resolves.toEqual({
        files: 1,
        changes: [],
        errors: [expect.stringMatching(/nope\.js/)],
        warnings: [],
    });
    await expect(s.insertSRIInHTML(TEST_DIR, 'sha256', { strict: true })).rejects.toThrow(/nope\.js/);
});

test('resolves with the processed file count and no errors on success', async () => {
    await expect(new SubresourceIntegrityInjector().insertSRIInHTML(TEST_DIR, 'sha256'))
        .resolves.toEqual({
            files: 1,
            changes: [
                { file: 'index.html', kind: 'add-integrity', url: 'test.css' },
                { file: 'index.html', kind: 'add-crossorigin', url: 'test.css' },
                { file: 'index.html', kind: 'add-integrity', url: 'test.js' },
                { file: 'index.html', kind: 'add-crossorigin', url: 'test.js' },
            ],
            errors: [],
            warnings: [],
        });
});

test('no HTML files: resolves with files=0 by default, rejects in strict mode', async () => {
    fs.removeSync(HTML_FILE);
    const s = new SubresourceIntegrityInjector();
    await expect(s.insertSRIInHTML(TEST_DIR, 'sha256')).resolves.toEqual({ files: 0, changes: [], errors: [], warnings: [] });
    await expect(s.insertSRIInHTML(TEST_DIR, 'sha256', { strict: true })).rejects.toThrow(/No HTML files/);
});

test('does not mistake a file named "..foo.js" for path traversal', async () => {
    fs.writeFileSync(path.join(TEST_DIR, '..foo.js'), 'var f=1;');
    fs.writeFileSync(HTML_FILE, '<html><head><script src="..foo.js"></script><script src="/..foo.js"></script></head><body></body></html>');
    const result = await new SubresourceIntegrityInjector().insertSRIInHTML(TEST_DIR, 'sha256', { strict: true });
    expect(result.errors).toEqual([]);
    const out = fs.readFileSync(HTML_FILE, 'utf-8');
    expect(out.match(/integrity="sha256-/g)).toHaveLength(2);
});

test('still rejects a reference to the parent directory itself', async () => {
    fs.writeFileSync(HTML_FILE, '<html><head><script src=".."></script></head><body></body></html>');
    const { errors } = await new SubresourceIntegrityInjector().insertSRIInHTML(TEST_DIR, 'sha256');
    expect(errors).toEqual([expect.stringMatching(/path traversal/)]);
});

test('invalid algorithm throws', async () => {
    await expect(new SubresourceIntegrityInjector().insertSRIInHTML(TEST_DIR, 'md5')).rejects.toThrow(/Unsupported hash algorithm/);
});

test('refreshes stale integrity values', async () => {
    fs.writeFileSync(HTML_FILE, '<html><head><script src="test.js" integrity="sha256-STALE"></script></head><body></body></html>');
    await new SubresourceIntegrityInjector().insertSRIInHTML(TEST_DIR, 'sha256');
    const out = fs.readFileSync(HTML_FILE, 'utf-8');
    expect(out).toContain('integrity="sha256-');
    expect(out).not.toContain('STALE');
});

test('preserves existing crossorigin value', async () => {
    fs.writeFileSync(HTML_FILE, '<html><head><script src="test.js" crossorigin="use-credentials"></script></head><body></body></html>');
    await new SubresourceIntegrityInjector().insertSRIInHTML(TEST_DIR, 'sha256');
    expect(fs.readFileSync(HTML_FILE, 'utf-8')).toContain('crossorigin="use-credentials"');
});

test('processes HTML files in subdirectories, resolving relative URLs from the file', async () => {
    fs.ensureDirSync(path.join(TEST_DIR, 'sub'));
    fs.writeFileSync(path.join(TEST_DIR, 'sub', 'page.html'), '<html><head><script src="../test.js"></script></head><body></body></html>');
    await new SubresourceIntegrityInjector().insertSRIInHTML(TEST_DIR, 'sha256');
    expect(fs.readFileSync(path.join(TEST_DIR, 'sub', 'page.html'), 'utf-8')).toContain('integrity="sha256-');
});

describe('absolute-URL base (CDN deployments)', () => {
    const CDN = 'https://cdn.example.com/';

    beforeEach(() => {
        fs.ensureDirSync(path.join(TEST_DIR, 'assets'));
        fs.writeFileSync(path.join(TEST_DIR, 'assets', 'app.js'), 'var a=1;');
    });

    test('resolves CDN URLs under base against the output directory', async () => {
        fs.writeFileSync(HTML_FILE, `<html><head><script src="${CDN}assets/app.js"></script></head><body></body></html>`);
        const result = await new SubresourceIntegrityInjector().insertSRIInHTML(TEST_DIR, 'sha256', { strict: true, base: CDN });
        expect(result.errors).toEqual([]);
        expect(fs.readFileSync(HTML_FILE, 'utf-8')).toContain('integrity="sha256-');
    });

    test('a CDN URL under base cannot escape the output directory', async () => {
        fs.writeFileSync(HTML_FILE, `<html><head><script src="${CDN}../secret.js"></script></head><body></body></html>`);
        const { errors } = await new SubresourceIntegrityInjector().insertSRIInHTML(TEST_DIR, 'sha256', { base: CDN });
        expect(errors).toEqual([expect.stringMatching(/path traversal/)]);
    });

    test('without base, CDN URLs are still treated as external', async () => {
        fs.writeFileSync(HTML_FILE, `<html><head><script src="${CDN}assets/app.js"></script></head><body></body></html>`);
        const result = await new SubresourceIntegrityInjector().insertSRIInHTML(TEST_DIR, 'sha256');
        expect(result.errors).toEqual([]);
        expect(fs.readFileSync(HTML_FILE, 'utf-8')).not.toContain('integrity=');
    });
});

describe('existing integrity attributes', () => {
    const crypto = require('crypto');
    const valid = () => 'sha256-' + crypto.createHash('sha256').update(fs.readFileSync(path.join(TEST_DIR, 'test.js'))).digest('base64');

    test('a file whose integrity values are all valid is not rewritten', async () => {
        const original = `<html><head><script src="test.js" integrity="${valid()}" crossorigin="anonymous"></script></head><body></body></html>`;
        fs.writeFileSync(HTML_FILE, original);
        const result = await new SubresourceIntegrityInjector().insertSRIInHTML(TEST_DIR, 'sha256');
        expect(result.warnings).toEqual([]);
        expect(fs.readFileSync(HTML_FILE, 'utf-8')).toBe(original);
    });

    test('stale values are replaced and surfaced as warnings, not errors', async () => {
        fs.writeFileSync(HTML_FILE, '<html><head><script src="test.js" integrity="sha256-STALE"></script></head><body></body></html>');
        const result = await new SubresourceIntegrityInjector().insertSRIInHTML(TEST_DIR, 'sha256', { strict: true });
        expect(result.errors).toEqual([]);
        expect(result.warnings).toEqual([expect.stringMatching(/test\.js.*sha256-STALE/)]);
        expect(fs.readFileSync(HTML_FILE, 'utf-8')).toContain(`integrity="${valid()}"`);
    });
});

describe('external resources (--external)', () => {
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

    test('default: external resources are left alone', async () => {
        fs.writeFileSync(HTML_FILE, `<html><head><script src="${origin}/lib.js"></script></head><body></body></html>`);
        await new SubresourceIntegrityInjector().insertSRIInHTML(TEST_DIR, 'sha256');
        expect(fs.readFileSync(HTML_FILE, 'utf-8')).not.toContain('integrity=');
    });

    test('external: true fetches and hashes CORS-enabled third-party resources', async () => {
        fs.writeFileSync(HTML_FILE, `<html><head><script src="${origin}/lib.js"></script></head><body></body></html>`);
        const result = await new SubresourceIntegrityInjector().insertSRIInHTML(TEST_DIR, 'sha256', { strict: true, external: true });
        expect(result.errors).toEqual([]);
        const sha = 'sha256-' + require('crypto').createHash('sha256').update('lib').digest('base64');
        expect(fs.readFileSync(HTML_FILE, 'utf-8')).toContain(`integrity="${sha}"`);
    });

    test('external: true leaves a non-CORS resource alone with a warning, and strict still passes', async () => {
        fs.writeFileSync(HTML_FILE, `<html><head><script src="${origin}/no-cors.js"></script></head><body></body></html>`);
        const result = await new SubresourceIntegrityInjector().insertSRIInHTML(TEST_DIR, 'sha256', { strict: true, external: true });
        expect(result.errors).toEqual([]);
        expect(result.warnings).toEqual([expect.stringMatching(/no-cors\.js.*Access-Control-Allow-Origin/)]);
        expect(fs.readFileSync(HTML_FILE, 'utf-8')).not.toContain('integrity=');
    });

    test('external: true + strict fails on an unreachable third-party resource', async () => {
        fs.writeFileSync(HTML_FILE, `<html><head><script src="${origin}/gone.js"></script></head><body></body></html>`);
        await expect(new SubresourceIntegrityInjector().insertSRIInHTML(TEST_DIR, 'sha256', { strict: true, external: true }))
            .rejects.toThrow(/gone\.js/);
    });
});

describe('Integrity-Policy', () => {
    const HEADER = 'Integrity-Policy: blocked-destinations=(script), sources=(inline)';

    test('integrityPolicy: true turns unprotected scripts into errors even without strict', async () => {
        fs.writeFileSync(HTML_FILE, '<html><head><script src="https://third.example.net/a.js"></script><script src="test.js"></script></head><body></body></html>');
        const result = await new SubresourceIntegrityInjector().insertSRIInHTML(TEST_DIR, 'sha256', { integrityPolicy: true });
        expect(result.errors).toEqual([expect.stringMatching(/third\.example\.net\/a\.js.*Integrity-Policy/)]);
        expect(result.integrityPolicy).toEqual({ name: 'Integrity-Policy', value: 'blocked-destinations=(script), sources=(inline)' });
    });

    test('headersFile writes and then merges a _headers file in the output directory', async () => {
        const file = path.join(TEST_DIR, '_headers');
        fs.writeFileSync(file, '/assets/*\n  Cache-Control: immutable\n');
        const s = new SubresourceIntegrityInjector();
        await s.insertSRIInHTML(TEST_DIR, 'sha256', { integrityPolicy: { headersFile: '_headers' } });
        await s.insertSRIInHTML(TEST_DIR, 'sha256', { integrityPolicy: { headersFile: '_headers' } });
        expect(fs.readFileSync(file, 'utf-8')).toBe(`/assets/*\n  Cache-Control: immutable\n\n/*\n  ${HEADER}\n`);
    });

    test('an enforcing policy treats dynamic import() as an error, since the CLI cannot cover it without an import map', async () => {
        fs.writeFileSync(path.join(TEST_DIR, 'test.js'), 'button.onclick = () => import("./lazy.js")');
        const result = await new SubresourceIntegrityInjector().insertSRIInHTML(TEST_DIR, 'sha256', { integrityPolicy: true });
        expect(result.errors).toEqual([expect.stringMatching(/test\.js.*import\(\)/)]);
        expect(result.warnings).toEqual([]);
    });

    test('without the option there is no header, no file and no audit', async () => {
        fs.writeFileSync(HTML_FILE, '<html><head><script src="https://third.example.net/a.js"></script></head><body></body></html>');
        const result = await new SubresourceIntegrityInjector().insertSRIInHTML(TEST_DIR, 'sha256', { strict: true });
        expect(result.errors).toEqual([]);
        expect(result.integrityPolicy).toBeUndefined();
        expect(fs.existsSync(path.join(TEST_DIR, '_headers'))).toBe(false);
    });
});

test('rejects when the output directory does not exist', async () => {
  await expect(new SubresourceIntegrityInjector().insertSRIInHTML(path.join(TEST_DIR, 'nope'), 'sha256'))
    .rejects.toThrow(/Output directory not found/);
});

test('an unreadable resource (a directory, not a file) is reported as an error, not a crash', async () => {
  fs.ensureDirSync(path.join(TEST_DIR, 'assets'));
  fs.writeFileSync(HTML_FILE, '<html><head><script src="assets"></script></head><body></body></html>');
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await expect(new SubresourceIntegrityInjector().insertSRIInHTML(TEST_DIR, 'sha256', { strict: true }))
      .rejects.toThrow(/EISDIR/);
  } finally {
    spy.mockRestore();
  }
});

describe('character encodings', () => {
  const page = (charset, body) => Buffer.concat([
    Buffer.from(`<html><head><meta charset="${charset}"><script src="test.js"></script></head><body>`),
    body,
    Buffer.from('</body></html>'),
  ]);

  test('a page that is not UTF-8 keeps every other byte as written', async () => {
    const body = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0xf1]); // "café ñ" in ISO-8859-1
    fs.writeFileSync(HTML_FILE, page('iso-8859-1', body));
    const { errors } = await new SubresourceIntegrityInjector().insertSRIInHTML(TEST_DIR, 'sha256');
    expect(errors).toEqual([]);
    const out = fs.readFileSync(HTML_FILE);
    expect(out.includes(body)).toBe(true);
    expect(out.toString('latin1')).toContain('integrity="sha256-');
    expect(out.includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(false); // no U+FFFD
  });

  test('UTF-8 pages (with and without a BOM) are unchanged apart from the injected attributes', async () => {
    for (const bom of [Buffer.alloc(0), Buffer.from([0xef, 0xbb, 0xbf])]) {
      fs.writeFileSync(HTML_FILE, Buffer.concat([bom, page('utf-8', Buffer.from('café ñ 日本'))]));
      await new SubresourceIntegrityInjector().insertSRIInHTML(TEST_DIR, 'sha256');
      const out = fs.readFileSync(HTML_FILE);
      expect(out.subarray(0, bom.length).equals(bom)).toBe(true);
      expect(out.toString('utf8')).toContain('café ñ 日本');
    }
  });

  test('a UTF-16 page is reported as an error and left untouched', async () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<html><head><script src="test.js"></script></head></html>', 'utf16le')]);
    fs.writeFileSync(HTML_FILE, utf16);
    const { errors } = await new SubresourceIntegrityInjector().insertSRIInHTML(TEST_DIR, 'sha256');
    expect(errors.join('\n')).toMatch(/UTF-16/);
    expect(fs.readFileSync(HTML_FILE).equals(utf16)).toBe(true);
  });
});

describe('dry run (dryRun: true)', () => {
  const { processDirectory } = require('../index');
  // Every file under TEST_DIR with its bytes and modification time, so "nothing was written" covers
  // new files, rewritten files and files rewritten with identical content.
  const snapshot = () => {
    const files = {};
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else files[path.relative(TEST_DIR, full)] = [fs.readFileSync(full).toString('base64'), fs.statSync(full).mtimeMs];
      }
    };
    walk(TEST_DIR);
    return files;
  };

  test('writes nothing, and reports the changes a real run then makes', async () => {
    fs.ensureDirSync(path.join(TEST_DIR, 'sub'));
    fs.writeFileSync(path.join(TEST_DIR, 'sub', 'page.html'), '<html><head><script src="../test.js" integrity="sha256-STALE" crossorigin="anonymous"></script></head></html>');
    fs.writeFileSync(path.join(TEST_DIR, 'plain.html'), '<p>no resources</p>');
    const before = snapshot();
    const s = new SubresourceIntegrityInjector();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const dry = await s.insertSRIInHTML(TEST_DIR, 'sha256', { dryRun: true });
      expect(snapshot()).toEqual(before);
      expect(dry.files).toBe(3);
      // Worded as what would happen, since nothing was replaced
      expect(dry.warnings).toEqual(['sub/page.html: Would replace integrity on "../test.js": existing value "sha256-STALE" does not match the resource.']);
      expect(dry.changes).toEqual(expect.arrayContaining([
        { file: 'index.html', kind: 'add-integrity', url: 'test.css' },
        { file: 'sub/page.html', kind: 'replace-integrity', url: '../test.js' },
      ]));
      expect(dry.changes.some(c => c.file === 'plain.html')).toBe(false);

      const real = await s.insertSRIInHTML(TEST_DIR, 'sha256');
      expect(real.changes).toEqual(dry.changes);
      expect(real.warnings).toEqual(['sub/page.html: Replaced integrity on "../test.js": existing value "sha256-STALE" did not match the resource.']);
      expect(snapshot()).not.toEqual(before);
    } finally {
      warn.mockRestore();
    }
  });

  test('on output that is already up to date, reports no changes (the basis of --check)', async () => {
    const s = new SubresourceIntegrityInjector();
    await s.insertSRIInHTML(TEST_DIR, 'sha384');
    const before = snapshot();
    // A different algorithm does not count as stale: valid existing values are kept.
    const dry = await s.insertSRIInHTML(TEST_DIR, 'sha512', { dryRun: true });
    expect(dry).toMatchObject({ files: 1, changes: [], errors: [], warnings: [] });
    expect(snapshot()).toEqual(before);
  });

  test('a data-skip-sri tag: the dry run lists nothing and touches nothing; the real run removes the marker', async () => {
    fs.writeFileSync(HTML_FILE, '<html><head><script src="/rt.js" data-skip-sri></script></head></html>');
    const before = snapshot();
    const s = new SubresourceIntegrityInjector();
    const dry = await s.insertSRIInHTML(TEST_DIR, 'sha256', { dryRun: true });
    expect(dry.changes).toEqual([]);
    expect(snapshot()).toEqual(before);
    expect(fs.readFileSync(HTML_FILE, 'utf8')).toContain('data-skip-sri');

    await s.insertSRIInHTML(TEST_DIR, 'sha256');
    expect(fs.readFileSync(HTML_FILE, 'utf8')).toBe('<html><head><script src="/rt.js"></script></head></html>');
  });

  test('keeps the bytes of a non-UTF-8 page exactly as they were', async () => {
    const latin1 = Buffer.from([...Buffer.from('<html><head><script src="test.js"></script></head><body>caf'), 0xe9, ...Buffer.from('</body></html>')]);
    fs.writeFileSync(HTML_FILE, latin1);
    const { changes } = await new SubresourceIntegrityInjector().insertSRIInHTML(TEST_DIR, 'sha256', { dryRun: true });
    expect(changes).toHaveLength(2);
    expect(fs.readFileSync(HTML_FILE).equals(latin1)).toBe(true);
  });

  describe('with a headers file', () => {
    const policy = { integrityPolicy: { headersFile: '_headers' } };
    const HEADERS = path.join(TEST_DIR, '_headers');

    test('does not create it, and reports that it would', async () => {
      const r = await processDirectory(TEST_DIR, { ...policy, dryRun: true });
      expect(r.dryRun).toBe(true);
      expect(fs.existsSync(HEADERS)).toBe(false);
      expect(r.changes).toContainEqual({ file: '_headers', kind: 'update-headers-file' });
    });

    test('does not modify an existing one', async () => {
      fs.writeFileSync(HEADERS, '/assets/*\n  Cache-Control: immutable\n');
      const r = await processDirectory(TEST_DIR, { ...policy, dryRun: true });
      expect(fs.readFileSync(HEADERS, 'utf8')).toBe('/assets/*\n  Cache-Control: immutable\n');
      expect(r.changes).toContainEqual({ file: '_headers', kind: 'update-headers-file' });
    });

    test('reports no change once the header is in place, and leaves the file untouched', async () => {
      await processDirectory(TEST_DIR, policy);
      const before = snapshot();
      expect(fs.readFileSync(HEADERS, 'utf8')).toContain('Integrity-Policy:');
      const r = await processDirectory(TEST_DIR, { ...policy, dryRun: true });
      expect(r.changes).toEqual([]);
      expect(snapshot()).toEqual(before);
    });

    test('a real run still rewrites the headers file every time, as it always has', async () => {
      await processDirectory(TEST_DIR, policy);
      const past = new Date('2000-01-01T00:00:00Z');
      fs.utimesSync(HEADERS, past, past);
      await processDirectory(TEST_DIR, policy);
      expect(fs.statSync(HEADERS).mtimeMs).not.toBe(past.getTime());
    });
  });

  test('with strict, rejects on errors as a real run does, and still writes nothing', async () => {
    fs.writeFileSync(HTML_FILE, '<html><head><script src="test.js"></script><script src="nope.js"></script></head></html>');
    const before = snapshot();
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(new SubresourceIntegrityInjector().insertSRIInHTML(TEST_DIR, 'sha256', { dryRun: true, strict: true }))
        .rejects.toThrow(/nope\.js/);
    } finally {
      err.mockRestore();
    }
    expect(snapshot()).toEqual(before);
  });

  test('is a directory-only option: the bundler plugins reject it instead of silently ignoring it', () => {
    const { resolveOptions } = require('../index');
    expect(() => resolveOptions({ dryRun: true })).toThrow(/Unknown option "dryRun"/);
    expect(() => require('../adapters/rollup')({ dryRun: true })).toThrow(/Unknown option "dryRun"/);
    expect(() => new (require('../adapters/webpack'))({ dryRun: true })).toThrow(/Unknown option "dryRun"/);
  });
});

describe('manifestFile', () => {
  const MANIFEST = path.join(TEST_DIR, 'sri-manifest.json');
  const sha256 = (c) => 'sha256-' + require('crypto').createHash('sha256').update(c).digest('base64');

  test('writes the integrity of every non-HTML, non-map file, keyed by relative path, and is stable on a second run', async () => {
    fs.ensureDirSync(path.join(TEST_DIR, 'sub'));
    fs.writeFileSync(path.join(TEST_DIR, 'sub', 'lazy.js'), 'lazy()');
    fs.writeFileSync(path.join(TEST_DIR, 'test.js.map'), '{}');
    const s = new SubresourceIntegrityInjector();
    const r = await s.insertSRIInHTML(TEST_DIR, 'sha256', { manifestFile: 'sri-manifest.json' });
    expect(r.changes).toContainEqual({ file: 'sri-manifest.json', kind: 'update-manifest-file' });
    const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    expect(m).toEqual({
      version: 1, algorithm: 'sha256',
      files: { 'sub/lazy.js': sha256('lazy()'), 'test.css': sha256('body { color: red; }'), 'test.js': sha256('console.log("hello world");') },
    });
    const before = fs.readFileSync(MANIFEST, 'utf8');
    const again = await s.insertSRIInHTML(TEST_DIR, 'sha256', { manifestFile: 'sri-manifest.json' });
    expect(again.changes.filter(c => c.kind === 'update-manifest-file')).toEqual([]);
    expect(fs.readFileSync(MANIFEST, 'utf8')).toBe(before);
  });

  test('a dry run reports it and writes nothing', async () => {
    const r = await new SubresourceIntegrityInjector().insertSRIInHTML(TEST_DIR, 'sha256', { dryRun: true, manifestFile: 'sri-manifest.json' });
    expect(r.changes).toContainEqual({ file: 'sri-manifest.json', kind: 'update-manifest-file' });
    expect(fs.existsSync(MANIFEST)).toBe(false);
  });

  test('is written even when the output has no HTML, and must stay inside the output directory', async () => {
    fs.removeSync(HTML_FILE);
    const s = new SubresourceIntegrityInjector();
    await s.insertSRIInHTML(TEST_DIR, 'sha256', { manifestFile: 'sri-manifest.json' });
    expect(Object.keys(JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).files)).toEqual(['test.css', 'test.js']);
    await expect(s.insertSRIInHTML(TEST_DIR, 'sha256', { manifestFile: '../escape.json' })).rejects.toThrow(/inside the output directory/);
  });
});
