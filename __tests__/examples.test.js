/**
 * Golden-file tests: a realistic site in examples/<name>/input is processed and every HTML file is
 * compared byte-for-byte with examples/<name>/expected, along with the reported errors/warnings.
 * They double as the worked before/after examples for the README.
 *
 * To regenerate after an intentional behaviour change:
 *     UPDATE_EXAMPLES=1 npx jest examples
 * then REVIEW `git diff examples/` line by line before committing. A golden file only proves the
 * output has not changed since someone checked it; regenerating without reading it proves nothing.
 */
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const SubresourceIntegrityInjector = require('../SubresourceIntegrityInjector');

const EXAMPLES = path.join(__dirname, '..', 'examples');
const UPDATE = process.env.UPDATE_EXAMPLES === '1';

function htmlFiles(dir) {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.html'))
    .map(e => path.relative(dir, path.join(e.parentPath || e.path, e.name)))
    .sort();
}

describe('examples/site', () => {
  const example = path.join(EXAMPLES, 'site');
  let work, result;

  beforeAll(async () => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'sri-example-'));
    fs.copySync(path.join(example, 'input'), work);
    result = await new SubresourceIntegrityInjector().insertSRIInHTML(work, 'sha384');
    // make paths in messages stable
    result.errors = result.errors.map(e => e.split(work).join('<dir>'));
    result.warnings = result.warnings.map(w => w.split(work).join('<dir>'));

    if (UPDATE) {
      fs.removeSync(path.join(example, 'expected'));
      for (const rel of htmlFiles(work)) fs.copySync(path.join(work, rel), path.join(example, 'expected', rel));
      fs.writeJsonSync(path.join(example, 'expected', 'result.json'), { files: result.files, errors: result.errors, warnings: result.warnings }, { spaces: 2 });
    }
  });
  afterAll(() => fs.removeSync(work));

  test('processes every HTML file in the tree', () => {
    expect(htmlFiles(work)).toEqual(['index.html', path.join('pages', 'about.html')]);
    expect(result.files).toBe(2);
  });

  test.each(['index.html', path.join('pages', 'about.html')])('%s matches expected output byte for byte', (rel) => {
    const actual = fs.readFileSync(path.join(work, rel), 'utf8');
    const expected = fs.readFileSync(path.join(example, 'expected', rel), 'utf8');
    expect(actual).toBe(expected);
  });

  test('reports the expected errors and warnings', () => {
    const expected = fs.readJsonSync(path.join(example, 'expected', 'result.json'));
    expect({ files: result.files, errors: result.errors, warnings: result.warnings }).toEqual(expected);
  });

  test('processing the expected output again changes nothing; the only error is the opted-out tag', async () => {
    const again = fs.mkdtempSync(path.join(os.tmpdir(), 'sri-example-again-'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      fs.copySync(path.join(example, 'input'), again);
      for (const rel of htmlFiles(again)) fs.copySync(path.join(example, 'expected', rel), path.join(again, rel));
      const before = Object.fromEntries(htmlFiles(again).map(rel => [rel, fs.readFileSync(path.join(again, rel), 'utf8')]));
      const r = await new SubresourceIntegrityInjector().insertSRIInHTML(again, 'sha384');
      expect(r.warnings).toEqual([]);
      // The first run removed data-skip-sri, so a second run sees an ordinary tag whose file the
      // build does not own. Every other tag is already correct, so nothing else is reported.
      expect(r.errors).toEqual([expect.stringMatching(/^index\.html: Could not process resource "\/runtime-config\.js": not found/)]);
      for (const rel of htmlFiles(again)) expect(fs.readFileSync(path.join(again, rel), 'utf8')).toBe(before[rel]);
    } finally {
      spy.mockRestore();
      fs.removeSync(again);
    }
  });

  describe('data-skip-sri', () => {
    const TAG_IN = '<script src="/runtime-config.js" data-skip-sri defer></script>';
    const TAG_OUT = '<script src="/runtime-config.js" defer></script>';
    // Elements carrying the attribute, as a parser sees them (the page's comments also mention its name).
    const marked = (html) => {
      const found = [];
      const visit = (node) => {
        if (node.attrs && node.attrs.some(a => a.name === 'data-skip-sri')) found.push(node.attrs.find(a => a.name === 'src').value);
        (node.childNodes || []).forEach(visit);
      };
      visit(require('parse5').parse(html));
      return found;
    };

    test('the input carries the attribute', () => {
      const input = fs.readFileSync(path.join(example, 'input', 'index.html'), 'utf8');
      expect(input).toContain(TAG_IN);
      expect(marked(input)).toEqual(['/runtime-config.js']);
    });

    test('a real run removes the attribute and adds no SRI to the tag', () => {
      const out = fs.readFileSync(path.join(work, 'index.html'), 'utf8');
      expect(marked(out)).toEqual([]);
      expect(out).toContain(TAG_OUT); // exactly this: no integrity, no crossorigin
      expect(result.errors).toEqual([]); // its file is not in the output, and that is fine
    });

    describe('a dry run', () => {
      let dry, before, after, real;
      // Every file in the site, with its bytes and modification time.
      const snapshot = (dir) => Object.fromEntries(
        fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => {
          const full = path.join(e.parentPath || e.path, e.name);
          return [path.relative(dir, full), [fs.readFileSync(full).toString('base64'), fs.statSync(full).mtimeMs]];
        }));

      beforeAll(async () => {
        const site = fs.mkdtempSync(path.join(os.tmpdir(), 'sri-example-dry-'));
        try {
          fs.copySync(path.join(example, 'input'), site);
          const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
          before = snapshot(site);
          dry = await new SubresourceIntegrityInjector().insertSRIInHTML(site, 'sha384', { dryRun: true });
          after = snapshot(site);
          real = await new SubresourceIntegrityInjector().insertSRIInHTML(site, 'sha384');
          spy.mockRestore();
        } finally {
          fs.removeSync(site);
        }
      });

      test('does not remove the attribute: no file is written, changed or deleted', () => {
        expect(after).toEqual(before);
        const html = Buffer.from(after['index.html'][0], 'base64').toString('utf8');
        expect(html).toContain(TAG_IN);
        expect(marked(html)).toEqual(['/runtime-config.js']);
      });

      test('does not list the opted-out tag, and otherwise previews exactly what the real run does', () => {
        expect(dry.changes.some(c => c.url === '/runtime-config.js')).toBe(false);
        expect(dry.changes).toEqual(real.changes);
        expect(dry.errors).toEqual([]);
      });
    });
  });
});

describe('examples/rollup-bundle', () => {
  const example = path.join(EXAMPLES, 'rollup-bundle');
  const sriPlugin = require('../adapters/rollup');
  let bundle, warnings, infos;

  beforeAll(async () => {
    bundle = fs.readJsonSync(path.join(example, 'bundle.json'));
    delete bundle._comment;
    warnings = []; infos = [];
    const plugin = sriPlugin({ algorithm: 'sha384', strict: true, base: 'https://cdn.example.com/', integrityPolicy: { headersFile: '_headers' } });
    const self = {
      error: (m) => { throw new Error(m); }, warn: (m) => warnings.push(m), info: (m) => infos.push(m),
      emitFile: (f) => { bundle[f.fileName] = { type: 'asset', fileName: f.fileName, source: f.source }; },
    };
    await plugin.generateBundle.handler.call(self, {}, bundle);

    if (UPDATE) {
      fs.writeFileSync(path.join(example, 'expected.index.html'), String(bundle['index.html'].source));
      fs.writeFileSync(path.join(example, 'expected._headers'), String(bundle['_headers'].source));
    }
  });

  test('index.html matches expected output byte for byte', () => {
    expect(String(bundle['index.html'].source)).toBe(fs.readFileSync(path.join(example, 'expected.index.html'), 'utf8'));
  });

  test('_headers matches expected output', () => {
    expect(String(bundle['_headers'].source)).toBe(fs.readFileSync(path.join(example, 'expected._headers'), 'utf8'));
  });

  test('no warnings; the header is logged as info', () => {
    expect(warnings).toEqual([]);
    expect(infos.join('\n')).toContain('Integrity-Policy: blocked-destinations=(script), sources=(inline)');
  });

  test('chunks are not modified', () => {
    const original = fs.readJsonSync(path.join(example, 'bundle.json'));
    for (const k of Object.keys(original)) if (original[k].type === 'chunk') expect(bundle[k].code).toBe(original[k].code);
  });
});

describe('examples/microfrontend', () => {
  test('--manifest-file hashes every remote file, including the lazy chunks that no HTML mentions', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sri-mf-'));
    try {
      fs.copySync(path.join(EXAMPLES, 'microfrontend', 'remote'), work);
      await new SubresourceIntegrityInjector().insertSRIInHTML(work, 'sha384', { manifestFile: 'sri-manifest.json' });
      const { files } = JSON.parse(fs.readFileSync(path.join(work, 'sri-manifest.json'), 'utf8'));
      expect(Object.keys(files)).toEqual(['assets/leaf.js', 'assets/main.js', 'assets/style.css', 'assets/widget.js', 'entry.json']);
      const crypto = require('crypto');
      for (const [file, hash] of Object.entries(files)) {
        expect(hash).toBe('sha384-' + crypto.createHash('sha384').update(fs.readFileSync(path.join(work, file))).digest('base64'));
      }
    } finally {
      fs.removeSync(work);
    }
  });
});
