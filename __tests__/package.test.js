/**
 * Packaging contract: what npm would publish, what it declares, and that the packed tarball
 * works when installed into a clean project (catches missing files and undeclared dependencies).
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pkg = require('../package.json');

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });

let packed; // { files: Set<string>, tarball: string }
let packDir;
beforeAll(() => {
  packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sri-pack-'));
  const r = run('npm', ['pack', '--json', '--pack-destination', packDir], { cwd: ROOT });
  if (r.status !== 0) throw new Error(`npm pack failed: ${r.stderr}`);
  const [info] = JSON.parse(r.stdout);
  packed = { files: new Set(info.files.map(f => f.path)), tarball: path.join(packDir, info.filename) };
}, 60000);
afterAll(() => fs.rmSync(packDir, { recursive: true, force: true }));

describe('manifest', () => {
  test('declares the supported Node version (global fetch is needed for --external)', () => {
    expect(pkg.engines).toBeDefined();
    expect(pkg.engines.node).toMatch(/^>=\s*18/);
  });

  test('has a description, license and repository', () => {
    expect(pkg.description).toMatch(/\S/);
    expect(pkg.license).toBeTruthy();
    expect(pkg.repository).toBeDefined();
  });

  test('bundlers are optional peer dependencies, not runtime dependencies', () => {
    for (const name of ['webpack', 'rollup', 'vite']) {
      expect(pkg.dependencies || {}).not.toHaveProperty(name);
      expect(pkg.peerDependencies).toHaveProperty(name);
      expect(pkg.peerDependenciesMeta[name]).toEqual({ optional: true });
    }
  });

  test('test-only tools stay in devDependencies', () => {
    for (const name of ['jest', 'html-webpack-plugin', '@rollup/plugin-html', 'c8']) {
      expect(pkg.dependencies || {}).not.toHaveProperty(name);
    }
  });

  test('exports an entry for every adapter', () => {
    for (const key of ['.', './rollup', './vite', './webpack', './core', './external', './package.json']) {
      expect(pkg.exports).toHaveProperty([key]);
    }
  });
});

describe('published files', () => {
  test('includes everything the entry points need', () => {
    for (const f of ['package.json', 'README.md', 'index.js', 'core.js', 'external.js', 'HashAlgo.js',
      'SubresourceIntegrityInjector.js', 'bin/cli.js', 'adapters/rollup.js', 'adapters/webpack.js', 'adapters/shared.js']) {
      expect(packed.files).toContain(f);
    }
  });

  test('every exports target and the bin file is in the tarball', () => {
    const targets = [...Object.values(pkg.exports), ...Object.values(pkg.bin)].map(t => t.replace(/^\.\//, ''));
    for (const t of targets) expect(packed.files).toContain(t);
  });

  test('excludes tests, examples, agent docs, editor files and the lockfile', () => {
    const leaked = [...packed.files].filter(f =>
      /^(__tests__|examples|\.idea|node_modules)\//.test(f) ||
      ['GEMINI.md', 'REVIEW_POLICY.md', 'TESTING.md', 'pnpm-lock.yaml', '.gitignore'].includes(f));
    expect(leaked).toEqual([]);
  });
});

describe('entry points resolve by package name', () => {
  test.each(['sri-injector', 'sri-injector/rollup', 'sri-injector/vite', 'sri-injector/webpack', 'sri-injector/core', 'sri-injector/external'])(
    'require(%s)', (spec) => {
      const r = run(process.execPath, ['-e', `const m = require(${JSON.stringify(spec)}); if (!m) process.exit(2)`], { cwd: ROOT });
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
    });

  test('the Vite/Rollup plugin is a function when imported from ESM (vite.config.mjs style)', () => {
    const r = run(process.execPath, ['--input-type=module', '-e',
      "import sri from 'sri-injector/vite'; import webpackSri from 'sri-injector/webpack'; process.stdout.write(typeof sri + ',' + typeof webpackSri)"], { cwd: ROOT });
    expect(r.stdout).toBe('function,function');
  });

  test('the main entry exposes injectSri and the injector class', () => {
    const m = require('..');
    expect(typeof m.injectSri).toBe('function');
    expect(typeof m).toBe('function'); // SubresourceIntegrityInjector
  });
});

describe('installed tarball', () => {
  test('installs into a clean project and the installed CLI injects integrity', () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'sri-install-'));
    try {
      fs.writeFileSync(path.join(proj, 'package.json'), '{"name":"consumer","version":"1.0.0"}');
      const install = run('npm', ['install', '--no-audit', '--no-fund', packed.tarball], { cwd: proj });
      expect(install.status).toBe(0);

      const dist = path.join(proj, 'dist');
      fs.mkdirSync(dist);
      fs.writeFileSync(path.join(dist, 'app.js'), 'console.log(1)');
      fs.writeFileSync(path.join(dist, 'index.html'), '<html><head><script src="/app.js"></script></head></html>');

      const cli = run(path.join(proj, 'node_modules', '.bin', 'sri-injector'), [dist, '--strict'], { cwd: proj });
      expect(cli.status).toBe(0);
      expect(fs.readFileSync(path.join(dist, 'index.html'), 'utf8')).toMatch(/integrity="sha384-/);

      const adapters = run(process.execPath, ['-e',
        "require('sri-injector/rollup'); require('sri-injector/webpack'); require('sri-injector/vite')"], { cwd: proj });
      expect(adapters.stderr).toBe('');
      expect(adapters.status).toBe(0);
    } finally {
      fs.rmSync(proj, { recursive: true, force: true });
    }
  }, 120000);
});
