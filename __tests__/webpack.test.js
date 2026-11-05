/**
 * Runs real webpack + html-webpack-plugin builds and checks the emitted HTML against the
 * emitted bytes, so these tests fail if the stage ordering or hashing is wrong, not just if a mock is.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const webpack = require('webpack');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const SriWebpackPlugin = require('../adapters/webpack');

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sri-webpack-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'index.js'), 'console.log("main");');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const { integrity: sha, scriptTags, attr } = require('./helpers/html');

function build({ sriOptions = {}, output = {}, html = {}, sriFirst = false } = {}) {
  const sri = new SriWebpackPlugin(sriOptions);
  const htmlPlugin = new HtmlWebpackPlugin({ inject: 'head', ...html });
  const compiler = webpack({
    mode: 'production',
    context: dir,
    entry: './src/index.js',
    devtool: false,
    optimization: { runtimeChunk: 'single' },
    output: { path: path.join(dir, 'dist'), filename: '[name].[contenthash].js', publicPath: '/', ...output },
    plugins: sriFirst ? [sri, htmlPlugin] : [htmlPlugin, sri],
  });
  return new Promise((resolve, reject) => {
    compiler.run((err, stats) => {
      if (err) return reject(err);
      compiler.close(() => resolve({
        stats,
        errors: stats.compilation.errors.map(e => e.message),
        warnings: stats.compilation.warnings.map(w => w.message),
        read: (name) => fs.readFileSync(path.join(dir, 'dist', name)),
        exists: (name) => fs.existsSync(path.join(dir, 'dist', name)),
        dist: path.join(dir, 'dist'),
      }));
    });
  });
}


test('every emitted script tag carries the hash of the emitted bytes', async () => {
  const r = await build();
  expect(r.errors).toEqual([]);
  const tags = scriptTags(r.read('index.html').toString('utf8'));
  expect(tags.length).toBe(2); // runtime + main
  for (const tag of tags) {
    const file = attr(tag, 'src').replace(/^\//, '');
    expect(attr(tag, 'integrity')).toBe(sha('sha384', r.read(file)));
    expect(attr(tag, 'crossorigin')).toBe('anonymous');
  }
});

test('the algorithm option is honoured', async () => {
  const r = await build({ sriOptions: { algorithm: 'sha512' } });
  const tag = scriptTags(r.read('index.html').toString('utf8'))[0];
  expect(attr(tag, 'integrity')).toMatch(/^sha512-/);
});

test('works when the plugin is listed before html-webpack-plugin', async () => {
  const r = await build({ sriFirst: true });
  expect(scriptTags(r.read('index.html').toString('utf8')).every(t => /integrity="sha384-/.test(t))).toBe(true);
});

test('a non-root publicPath is stripped when locating assets', async () => {
  const r = await build({ output: { publicPath: '/app/' } });
  expect(r.errors).toEqual([]);
  const tag = scriptTags(r.read('index.html').toString('utf8'))[0];
  expect(attr(tag, 'src')).toMatch(/^\/app\//);
  expect(attr(tag, 'integrity')).toMatch(/^sha384-/);
});

test('publicPath "auto" (relative URLs) resolves from the HTML file', async () => {
  const r = await build({ output: { publicPath: 'auto' } });
  expect(r.errors).toEqual([]);
  expect(scriptTags(r.read('index.html').toString('utf8')).every(t => /integrity="sha384-/.test(t))).toBe(true);
});

test('a full-URL publicPath hashes assets under it instead of skipping them as external', async () => {
  const r = await build({ output: { publicPath: 'https://cdn.example.com/static/' } });
  expect(r.errors).toEqual([]);
  const tag = scriptTags(r.read('index.html').toString('utf8'))[0];
  expect(attr(tag, 'src')).toMatch(/^https:\/\/cdn\.example\.com\/static\//);
  expect(attr(tag, 'integrity')).toMatch(/^sha384-/);
});

describe('unresolvable resources', () => {
  const html = { templateContent: '<html><head></head><body><script src="/missing.js"></script></body></html>' };

  test('fail the build by default (same rule as the CLI and the Rollup/Vite plugin)', async () => {
    const r = await build({ html });
    expect(r.errors.join('\n')).toMatch(/1 resource\(s\) could not be processed[\s\S]*missing\.js/);
  });

  test('skip-sri opts a tag out', async () => {
    const r = await build({ html: { templateContent: '<html><head></head><body><script src="/runtime-config.js" skip-sri></script></body></html>' } });
    expect(r.errors).toEqual([]);
    expect(r.read('index.html').toString('utf8')).not.toMatch(/skip-sri/);
  });

  test('strict keeps failing too', async () => {
    const r = await build({ html, sriOptions: { strict: true } });
    expect(r.errors.join('\n')).toMatch(/missing\.js/);
  });

  const buildWithoutHtml = async (sriOptions) => {
    const compiler = webpack({
      mode: 'production', context: dir, entry: './src/index.js', devtool: false,
      output: { path: path.join(dir, 'dist') },
      plugins: [new SriWebpackPlugin(sriOptions)],
    });
    return new Promise((res, rej) => compiler.run((e, s) => (e ? rej(e) : compiler.close(() => res(s)))));
  };

  test('strict also fails when there is no HTML at all', async () => {
    const stats = await buildWithoutHtml({ strict: true });
    expect(stats.compilation.errors.map(e => e.message).join('\n')).toMatch(/No HTML files/);
  });

  test('without strict, no HTML is only a warning', async () => {
    const stats = await buildWithoutHtml({});
    expect(stats.compilation.errors).toEqual([]);
    expect(stats.compilation.warnings.map(w => w.message).join('\n')).toMatch(/No HTML files/);
  });
});

describe('integrityPolicy', () => {
  test('writes the header into a _headers asset', async () => {
    const r = await build({ sriOptions: { integrityPolicy: { headersFile: '_headers' } } });
    expect(r.errors).toEqual([]);
    expect(r.read('_headers').toString('utf8')).toContain('Integrity-Policy: blocked-destinations=(script), sources=(inline)');
  });

  test('a script that stays uncovered is a build error', async () => {
    const html = { templateContent: '<html><head></head><body><script src="https://third.example.net/a.js"></script></body></html>' };
    const r = await build({ html, sriOptions: { integrityPolicy: true } });
    expect(r.errors.join('\n')).toMatch(/third\.example\.net\/a\.js[\s\S]*Integrity-Policy|Integrity-Policy[\s\S]*third\.example\.net\/a\.js/);
  });

  describe('lazy chunks', () => {
    // webpack's classic chunk loader creates <script> elements at runtime; they carry no integrity,
    // so under an enforcing policy the browser would block every lazily loaded chunk.
    const withLazyChunk = () => {
      fs.writeFileSync(path.join(dir, 'src', 'index.js'), 'import("./lazy.js").then(m => m.default()); console.log("main");');
      fs.writeFileSync(path.join(dir, 'src', 'lazy.js'), 'export default () => console.log("lazy");');
    };
    const lazyFile = (r) => r.stats.compilation.getAssets().map(a => a.name).find(n => /^\d+\..*\.js$/.test(n));

    test('an enforcing policy fails the build and names the lazy chunk', async () => {
      withLazyChunk();
      const r = await build({ sriOptions: { integrityPolicy: true } });
      const lazy = lazyFile(r);
      expect(lazy).toBeDefined();
      expect(r.errors.join('\n')).toContain('1 chunk(s) are loaded at runtime without integrity');
      expect(r.errors.join('\n')).toContain(lazy);
    });

    test('the headers file is not emitted for a build that would be blocked', async () => {
      withLazyChunk();
      const r = await build({ sriOptions: { integrityPolicy: { headersFile: '_headers' } } });
      expect(r.errors).not.toEqual([]);
      expect(r.exists('_headers')).toBe(false);
    });

    test('report-only only warns, since nothing is blocked', async () => {
      withLazyChunk();
      const r = await build({ sriOptions: { integrityPolicy: 'report-only' } });
      expect(r.errors).toEqual([]);
      expect(r.warnings.join('\n')).toContain(lazyFile(r));
    });

    test('without a policy, lazy chunks raise nothing', async () => {
      withLazyChunk();
      const r = await build();
      expect(r.errors).toEqual([]);
      expect(r.warnings).toEqual([]);
    });

    test('a policy with no lazy chunks is fine', async () => {
      const r = await build({ sriOptions: { integrityPolicy: true } });
      expect(r.errors).toEqual([]);
    });
  });

  test('a headersFile outside the output directory is rejected at configuration time', () => {
    expect(() => new SriWebpackPlugin({ integrityPolicy: { headersFile: '../_headers' } })).toThrow(/headers file/i);
  });
});

test('unknown options are rejected at configuration time', () => {
  expect(() => new SriWebpackPlugin({ strcit: true })).toThrow(/Unknown option "strcit"/);
});

test('an unsupported algorithm is rejected at configuration time', () => {
  expect(() => new SriWebpackPlugin({ algorithm: 'md5' })).toThrow(/Unsupported hash algorithm/);
});

test('running twice on the same output does not change the HTML (idempotent)', async () => {
  const first = await build();
  const before = first.read('index.html').toString('utf8');
  const SubresourceIntegrityInjector = require('../SubresourceIntegrityInjector');
  await new SubresourceIntegrityInjector().insertSRIInHTML(first.dist, 'sha384', { base: '/' });
  expect(first.read('index.html').toString('utf8')).toBe(before);
});

test('enabled: false leaves the HTML untouched', async () => {
  const r = await build({ sriOptions: { enabled: false } });
  expect(r.read('index.html').toString('utf8')).not.toContain('integrity=');
  expect(r.warnings).toEqual([]);
});

test('the crossorigin option is applied', async () => {
  const r = await build({ sriOptions: { crossorigin: 'use-credentials' } });
  expect(scriptTags(r.read('index.html').toString('utf8')).every(t => /crossorigin="use-credentials"/.test(t))).toBe(true);
});

test('an invalid crossorigin value is rejected at configuration time', () => {
  expect(() => new SriWebpackPlugin({ crossorigin: 'sometimes' })).toThrow(/crossorigin/);
});
