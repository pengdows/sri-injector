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
