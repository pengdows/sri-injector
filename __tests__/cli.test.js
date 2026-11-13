/**
 * End-to-end tests for the CLI's exit codes and summary output.
 * Build tools (webpack/rollup/swc post-build scripts, CI) rely on the exit code, so every
 * outcome branch is pinned here by spawning the real binary.
 */
const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

function runCli(dir, ...args) {
  const r = spawnSync(process.execPath, [CLI, dir, ...args], { encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, out: r.stdout + r.stderr };
}

// For tests that need a live server in this process: spawnSync would block the event loop
// and the server could never answer the child.
function runCliAsync(dir, ...args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, dir, ...args]);
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr, out: stdout + stderr }));
  });
}

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sri-cli-'));
  fs.writeFileSync(path.join(dir, 'ok.js'), 'var ok=1;');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const html = (...srcs) =>
  `<html><head>${srcs.map(s => `<script src="${s}"></script>`).join('')}</head><body></body></html>`;

test('exit 0 with a success summary when every resource is hashed', () => {
  fs.writeFileSync(path.join(dir, 'index.html'), html('ok.js'));
  const r = runCli(dir);
  expect(r.code).toBe(0);
  expect(r.stdout).toMatch(/✅.*1 HTML file\(s\)/);
  expect(fs.readFileSync(path.join(dir, 'index.html'), 'utf8')).toContain('integrity="sha384-');
});

test('exit 1 with a failure count when a resource is missing, even without --strict', () => {
  fs.writeFileSync(path.join(dir, 'index.html'), html('ok.js', 'missing.js', 'also-missing.js'));
  const r = runCli(dir);
  expect(r.code).toBe(1);
  expect(r.stderr).toMatch(/missing\.js/);
  expect(r.stderr).toMatch(/❌.*2 resource\(s\) could not be processed/);
  expect(r.stdout).not.toMatch(/✅/);
  // Resolvable resources in the same file are still rewritten
  expect(fs.readFileSync(path.join(dir, 'index.html'), 'utf8')).toContain('integrity="sha384-');
});

test('exit 1 when a resource is missing with --strict', () => {
  fs.writeFileSync(path.join(dir, 'index.html'), html('missing.js'));
  const r = runCli(dir, '--strict');
  expect(r.code).toBe(1);
  expect(r.stderr).toMatch(/❌ Failed to inject SRI attributes.*1 resource\(s\)/s);
});

test('exit 1 when a resource would traverse outside the output directory', () => {
  fs.writeFileSync(path.join(dir, 'index.html'), html('../outside.js'));
  const r = runCli(dir);
  expect(r.code).toBe(1);
  expect(r.stderr).toMatch(/path traversal/);
});

test('no HTML files: exit 0 with a warning by default', () => {
  const r = runCli(dir);
  expect(r.code).toBe(0);
  expect(r.out).toMatch(/⚠️ {2}No HTML files found/);
  expect(r.stdout).not.toMatch(/✅/);
});

test('no HTML files: exit 1 with --strict', () => {
  const r = runCli(dir, '--strict');
  expect(r.code).toBe(1);
  expect(r.stderr).toMatch(/❌.*No HTML files found/);
});

test('exit 1 for a nonexistent directory or an unsupported algorithm', () => {
  expect(runCli(path.join(dir, 'does-not-exist')).code).toBe(1);
  fs.writeFileSync(path.join(dir, 'index.html'), html('ok.js'));
  const r = runCli(dir, '--algo', 'md5');
  expect(r.code).toBe(1);
  expect(r.stderr).toMatch(/Unsupported hash algorithm/);
});

test('--base lets CDN-hosted assets be hashed from the output directory', () => {
  fs.writeFileSync(path.join(dir, 'index.html'), html('https://cdn.example.com/ok.js'));
  const r = runCli(dir, '--base', 'https://cdn.example.com/');
  expect(r.code).toBe(0);
  expect(fs.readFileSync(path.join(dir, 'index.html'), 'utf8')).toContain('integrity="sha384-');
});

describe('--external', () => {
  const http = require('http');
  let server, origin;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/lib.js') { res.writeHead(200, { 'Access-Control-Allow-Origin': '*' }); return res.end('lib'); }
      res.writeHead(404); res.end();
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => new Promise(r => server.close(r)));

  test('without the flag, third-party scripts are untouched and the run succeeds', () => {
    fs.writeFileSync(path.join(dir, 'index.html'), html(`${origin}/lib.js`));
    const r = runCli(dir, '--strict');
    expect(r.code).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'index.html'), 'utf8')).not.toContain('integrity=');
  });

  test('with the flag, third-party scripts are fetched and pinned', async () => {
    fs.writeFileSync(path.join(dir, 'index.html'), html(`${origin}/lib.js`));
    const r = await runCliAsync(dir, '--strict', '--external');
    expect(r.code).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'index.html'), 'utf8')).toContain('integrity="sha384-');
  });

  test('with the flag, an unreachable third-party script fails a strict run', async () => {
    fs.writeFileSync(path.join(dir, 'index.html'), html(`${origin}/gone.js`));
    const r = await runCliAsync(dir, '--strict', '--external');
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/gone\.js/);
  });
});

describe('--integrity-policy', () => {
  test('prints the header to configure and exits 0 when every script is covered', () => {
    fs.writeFileSync(path.join(dir, 'index.html'), html('ok.js'));
    const r = runCli(dir, '--integrity-policy');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Integrity-Policy: blocked-destinations=(script), sources=(inline)');
  });

  test('report-only flag prints the report-only header', () => {
    fs.writeFileSync(path.join(dir, 'index.html'), html('ok.js'));
    const r = runCli(dir, '--integrity-policy-report-only');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Integrity-Policy-Report-Only: blocked-destinations=(script), sources=(inline)');
  });

  test('exits 1 when a script would be blocked by the policy, even without --strict', () => {
    fs.writeFileSync(path.join(dir, 'index.html'), html('ok.js', 'https://third.example.net/a.js'));
    const r = runCli(dir, '--integrity-policy');
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/third\.example\.net\/a\.js.*Integrity-Policy/);
  });

  test('--headers-file writes the header in _headers format', () => {
    fs.writeFileSync(path.join(dir, 'index.html'), html('ok.js'));
    const r = runCli(dir, '--integrity-policy', '--headers-file', '_headers');
    expect(r.code).toBe(0);
    expect(fs.readFileSync(path.join(dir, '_headers'), 'utf8')).toBe('/*\n  Integrity-Policy: blocked-destinations=(script), sources=(inline)\n');
  });
});

describe('argument handling', () => {
  const spawnArgs = (...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
    return { code: r.status, out: r.stdout + r.stderr };
  };

  test.each(['abc', '0', '-5', '1.5x'])('--external-timeout %s is rejected with a clear message', (value) => {
    fs.writeFileSync(path.join(dir, 'index.html'), html('ok.js'));
    const r = spawnArgs(dir, '--external', `--external-timeout=${value}`);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/--external-timeout/);
    expect(r.out).not.toMatch(/NaN/);
  });

  test('--integrity-policy before the directory does not swallow it', () => {
    fs.writeFileSync(path.join(dir, 'index.html'), html('ok.js'));
    const r = spawnArgs('--integrity-policy', dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Integrity-Policy: blocked-destinations=(script)');
  });

  test('--integrity-policy-report-only selects the report-only header, wherever it is written', () => {
    fs.writeFileSync(path.join(dir, 'index.html'), html('ok.js'));
    const r = spawnArgs('--integrity-policy-report-only', dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Integrity-Policy-Report-Only:');
  });

  test('--integrity-policy takes no value, so a typo cannot be mistaken for a mode', () => {
    fs.writeFileSync(path.join(dir, 'index.html'), html('ok.js'));
    const r = spawnArgs(dir, '--integrity-policy=report_only');
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/--integrity-policy/);
  });

  test('--headers-file outside the output directory is rejected and nothing is written', () => {
    fs.writeFileSync(path.join(dir, 'index.html'), html('ok.js'));
    const escaped = path.join(path.dirname(dir), `sri-escape-${path.basename(dir)}`);
    const r = spawnArgs(dir, '--integrity-policy', '--headers-file', `../${path.basename(escaped)}`);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/headers file/i);
    expect(fs.existsSync(escaped)).toBe(false);
  });

  test('an absolute --headers-file is rejected too', () => {
    fs.writeFileSync(path.join(dir, 'index.html'), html('ok.js'));
    const target = path.join(os.tmpdir(), `sri-abs-${path.basename(dir)}`);
    const r = spawnArgs(dir, '--integrity-policy', '--headers-file', target);
    expect(r.code).toBe(1);
    expect(fs.existsSync(target)).toBe(false);
  });
});

describe('--crossorigin', () => {
  test('use-credentials is written to tags that lack crossorigin', () => {
    fs.writeFileSync(path.join(dir, 'index.html'), html('ok.js'));
    const r = runCli(dir, '--crossorigin', 'use-credentials');
    expect(r.code).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'index.html'), 'utf8')).toContain('crossorigin="use-credentials"');
  });

  test('an unsupported value exits 1 with a clear message', () => {
    fs.writeFileSync(path.join(dir, 'index.html'), html('ok.js'));
    const r = runCli(dir, '--crossorigin', 'sometimes');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/crossorigin/);
  });
});

describe('--dry-run and --check', () => {
  const INDEX = () => path.join(dir, 'index.html');
  const write = (content, name = 'index.html') => {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  };
  const read = () => fs.readFileSync(INDEX(), 'utf8');
  const sha384 = (content) => `sha384-${require('crypto').createHash('sha384').update(content).digest('base64')}`;
  // Every file in the output with its bytes and modification time.
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

  test('--dry-run and --check together are a usage error, and nothing runs', () => {
    write(html('ok.js'));
    const before = snapshot();
    const r = runCli(dir, '--dry-run', '--check');
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/--check.*cannot be used with.*--dry-run|--dry-run.*cannot be used with.*--check/);
    expect(snapshot()).toEqual(before);
  });

  test('--dry-run and --check never remove a data-skip-sri marker; only a real run does', () => {
    const page = '<html><head><script src="/runtime-config.js" data-skip-sri></script></head></html>';
    write(page);
    const before = snapshot();
    for (const mode of ['--dry-run', '--check']) {
      expect(runCli(dir, mode).code).toBe(0);
      expect(snapshot()).toEqual(before);
    }
    expect(runCli(dir).code).toBe(0);
    expect(read()).toBe('<html><head><script src="/runtime-config.js"></script></head></html>');
  });

  describe('--dry-run: what would a real run change?', () => {
    test('lists each change per page and tag, writes nothing, and exits 0', () => {
      write(html('ok.js', '/rt.js" data-skip-sri="'));
      write(html('../ok.js'), 'sub/page.html');
      const before = snapshot();
      const r = runCli(dir, '--dry-run');
      expect(r.code).toBe(0);
      expect(snapshot()).toEqual(before);
      expect(r.stdout).toContain('Would update index.html:\n  "ok.js": add integrity, add crossorigin\n');
      expect(r.stdout).not.toMatch(/rt\.js/); // data-skip-sri: nothing to report
      expect(r.stdout).toContain('Would update sub/page.html:\n  "../ok.js": add integrity, add crossorigin\n');
      expect(r.stdout).toMatch(/Dry run: 2 of 2 HTML file\(s\) .* would get SRI updates .*Nothing was written\./);
    });

    test('warnings are worded as what would happen', () => {
      write(html('ok.js').replace('src="ok.js"', 'src="ok.js" integrity="sha384-STALE" crossorigin'));
      const r = runCli(dir, '--dry-run');
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('"ok.js": replace wrong integrity');
      expect(r.stderr).toContain('Warning: index.html: Would replace integrity on "ok.js": existing value "sha384-STALE" does not match the resource.');
      expect(r.stderr).not.toMatch(/Replaced/);
    });

    test('exits 1 exactly when a real run would: on errors, and with --strict when there is no HTML', () => {
      write(html('ok.js', 'missing.js'));
      const before = snapshot();
      const r = runCli(dir, '--dry-run');
      expect(r.code).toBe(1);
      expect(snapshot()).toEqual(before);
      expect(r.stderr).toMatch(/❌ .*1 resource\(s\) could not be processed .*Nothing was written \(dry run\)\./);
      expect(runCli(dir).code).toBe(1); // ...as the real run then confirms

      fs.rmSync(INDEX());
      expect(runCli(dir, '--dry-run').code).toBe(0);
      expect(runCli(dir, '--dry-run', '--strict').code).toBe(1);
    });

    test('with an Integrity-Policy, exits 1 where a real run would, and never writes the headers file', () => {
      write(html('ok.js', 'https://third.example.net/a.js'));
      const blocked = runCli(dir, '--dry-run', '--integrity-policy', '--headers-file', '_headers');
      expect(blocked.code).toBe(1);
      expect(fs.existsSync(path.join(dir, '_headers'))).toBe(false);

      write(html('ok.js'));
      const r = runCli(dir, '--dry-run', '--integrity-policy', '--headers-file', '_headers');
      expect(r.code).toBe(0);
      expect(fs.existsSync(path.join(dir, '_headers'))).toBe(false);
      expect(r.stdout).toContain('Would update _headers:\n  add the Integrity-Policy header');
      expect(r.stdout).toMatch(/\(would be written to _headers\)/);
    });

    test('on output that is already up to date, says there is nothing to do', () => {
      write(html('ok.js'));
      expect(runCli(dir).code).toBe(0);
      const before = snapshot();
      const r = runCli(dir, '--dry-run');
      expect(r.code).toBe(0);
      expect(snapshot()).toEqual(before);
      expect(r.stdout).not.toMatch(/Would update/);
      expect(r.stdout).toMatch(/✅ Dry run: nothing to change in 1 HTML file\(s\) .*Nothing was written\./);
    });
  });

  describe('--check: is what is there complete and correct?', () => {
    test('passes on output the tool has processed', () => {
      write(html('ok.js'));
      write(html('../ok.js'), 'sub/page.html');
      expect(runCli(dir).code).toBe(0);
      const before = snapshot();
      const r = runCli(dir, '--check');
      expect(r.code).toBe(0);
      expect(snapshot()).toEqual(before);
      expect(r.stdout).toMatch(/✅ Check passed: 2 target\(s\) in 2 HTML file\(s\): 2 ok/);
    });

    test('honours a data-skip-sri marker that is still in the output, and leaves it there', () => {
      write(html('ok.js', '/runtime-config.js" data-skip-sri="'));
      const r = runCli(dir, '--check');
      expect(r.stdout).toMatch(/index\.html\n(.*\n)*\s+- skipped\s+"\/runtime-config\.js": data-skip-sri/);
      expect(read()).toContain('data-skip-sri');
    });

    test('after a real run the marker is gone, so that tag is examined like any other', () => {
      // Pinned on purpose: the real run removes data-skip-sri from the final output, so a later
      // --check cannot know the tag was opted out. A file the build does not own then fails.
      write(html('ok.js', '/runtime-config.js" data-skip-sri="'));
      expect(runCli(dir).code).toBe(0);
      const r = runCli(dir, '--check');
      expect(r.code).toBe(1);
      expect(r.stdout).toMatch(/✗ not found\s+"\/runtime-config\.js"/);
    });

    test('a bare skip-sri attribute is not an opt-out', () => {
      write('<html><head><script src="/ok.js" skip-sri></script></head></html>');
      const r = runCli(dir, '--check');
      expect(r.code).toBe(1);
      expect(r.stdout).toMatch(/✗ missing\s+"\/ok\.js"/);
    });

    test('fails on output the tool was never run on, and says so', () => {
      write(html('ok.js'));
      const before = snapshot();
      const r = runCli(dir, '--check');
      expect(r.code).toBe(1);
      expect(snapshot()).toEqual(before);
      expect(r.stdout).toMatch(/index\.html\n\s+✗ missing\s+"ok\.js": no integrity attribute/);
      expect(r.stdout).toMatch(/No integrity attributes found: sri-injector does not appear to have been run on this output\./);
      expect(r.stderr).toMatch(/❌ Check failed: 1 target\(s\) in 1 HTML file\(s\): 1 missing/);
    });

    test('fails when a file changed after its hash was written, naming both hashes', () => {
      write(html('ok.js'));
      expect(runCli(dir).code).toBe(0);
      fs.writeFileSync(path.join(dir, 'ok.js'), 'var tampered=1;');
      const before = snapshot();
      const r = runCli(dir, '--check');
      expect(r.code).toBe(1);
      expect(snapshot()).toEqual(before);
      expect(r.stdout).toContain(`✗ wrong`);
      expect(r.stdout).toContain(sha384('var tampered=1;'));
      expect(r.stdout).toContain(sha384('var ok=1;'));
      expect(r.stdout).not.toMatch(/does not appear to have been run/);
    });

    test('fails when a referenced file is not in the output', () => {
      write(html('gone.js').replace('src="gone.js"', 'src="gone.js" integrity="sha384-X"'));
      const r = runCli(dir, '--check');
      expect(r.code).toBe(1);
      expect(r.stdout).toMatch(/✗ not found\s+"gone\.js"/);
    });

    test('lists third-party tags as unchecked without failing; --external verifies them', async () => {
      const http = require('http');
      const server = http.createServer((req, res) => { res.writeHead(200, { 'Access-Control-Allow-Origin': '*' }); res.end('lib'); });
      await new Promise(r => server.listen(0, '127.0.0.1', r));
      const url = `http://127.0.0.1:${server.address().port}/lib.js`;
      try {
        write(html(url));
        const unchecked = await runCliAsync(dir, '--check');
        expect(unchecked.code).toBe(0);
        expect(unchecked.stdout).toMatch(/- unchecked\s+"http:\/\/127\.0\.0\.1:\d+\/lib\.js": third-party; pass --external to verify it/);
        const verified = await runCliAsync(dir, '--check', '--external');
        expect(verified.code).toBe(1);
        expect(verified.stdout).toMatch(/✗ missing\s+"http:\/\/127\.0\.0\.1/);
      } finally {
        await new Promise(r => server.close(r));
      }
    });

    test('verifies import map integrity entries, and states what it cannot see', () => {
      fs.writeFileSync(path.join(dir, 'lazy.js'), 'export const x=1');
      const map = JSON.stringify({ integrity: { '/lazy.js': 'sha384-WRONG' } });
      write(`<html><head><script type="importmap">${map}</script><script type="module" src="/ok.js" integrity="${sha384('var ok=1;')}"></script></head></html>`);
      const r = runCli(dir, '--check');
      expect(r.code).toBe(1);
      expect(r.stdout).toMatch(/✗ wrong\s+import map "\/lazy\.js"/);
      expect(r.stdout).toMatch(/import\(\).*import map entry.*cannot be detected/);
    });

    test('with an Integrity-Policy flag, a script the header would block fails', () => {
      write(html('ok.js', 'https://third.example.net/a.js'));
      expect(runCli(dir).code).toBe(0);
      expect(runCli(dir, '--check').code).toBe(0);
      const r = runCli(dir, '--check', '--integrity-policy');
      expect(r.code).toBe(1);
      expect(r.stdout).toMatch(/✗ blocked\s+"https:\/\/third\.example\.net\/a\.js"/);
    });

    test('never writes, even with the flags of a real run that would write the headers file', () => {
      write(html('ok.js'));
      const before = snapshot();
      runCli(dir, '--check', '--integrity-policy', '--headers-file', '_headers');
      expect(snapshot()).toEqual(before);
    });

    test('--algo does not change what counts as valid: any supported algorithm that matches is ok', () => {
      write(html('ok.js'));
      expect(runCli(dir, '--algo', 'sha256').code).toBe(0);
      expect(runCli(dir, '--check', '--algo', 'sha512').code).toBe(0);
    });

    test('no HTML: exit 0 with a warning, exit 1 with --strict', () => {
      const r = runCli(dir, '--check');
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/No HTML files found/);
      const strict = runCli(dir, '--check', '--strict');
      expect(strict.code).toBe(1);
      expect(strict.stderr).toMatch(/❌ Check failed: .*No HTML files found/);
    });

    test('an unreadable page fails the check', () => {
      fs.writeFileSync(INDEX(), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(html('ok.js'), 'utf16le')]));
      const r = runCli(dir, '--check');
      expect(r.code).toBe(1);
      expect(r.stdout).toMatch(/index\.html\n\s+✗ .*UTF-16/);
    });
  });
});
