/**
 * Real-browser tests: a real Vite build, served over HTTP and loaded in Chromium. The attribute and
 * hash tests elsewhere prove what we write; these prove the browser accepts an honest build and
 * refuses a tampered one, including the lazy chunk that only the import map protects.
 *
 * Not part of `npm test` (it needs a Chrome/Chromium). Run with `npm run test:browser`; set
 * CHROME_PATH to pick a browser. Under CI=true a missing browser fails instead of skipping.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright-core');
const SubresourceIntegrityInjector = require('../..');

const CANDIDATES = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium']
  .filter(Boolean);
const chrome = CANDIDATES.find(p => fs.existsSync(p));
const maybe = chrome || process.env.CI ? describe : describe.skip;
if (!chrome && !process.env.CI) console.warn('browser tests skipped: no Chrome/Chromium found (set CHROME_PATH)');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const serve = (root, { headers = {}, cors = false } = {}) => new Promise((resolve) => {
  const server = http.createServer((req, res) => {
    const file = path.join(root, decodeURIComponent(req.url.split('?')[0]).replace(/\/$/, '/index.html'));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', ...headers, ...(cors ? { 'Access-Control-Allow-Origin': '*' } : {}) });
    res.end(fs.readFileSync(file));
  }).listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
});

maybe('in Chromium', () => {
  jest.setTimeout(180000);
  let work, browser;
  const servers = [];
  const site = async (root, opts) => { const s = await serve(root, opts); servers.push(s.server); return s.url; };

  /** Opens a page, collects console output, and waits for the page's own "settled" signal. */
  const open = async (url, settled = () => window.__lazy !== undefined || window.__lazyError !== undefined) => {
    const page = await browser.newPage();
    const messages = [];
    page.on('console', (m) => messages.push(m.text()));
    page.on('pageerror', (e) => messages.push(String(e)));
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(settled, null, { timeout: 4000 }).catch(() => {});
    return { page, messages, get: (name) => page.evaluate((n) => window[n], name) };
  };
  const tamper = (dir, matcher) => {
    const target = fs.readdirSync(path.join(dir, 'assets')).find(f => matcher.test(f));
    fs.appendFileSync(path.join(dir, 'assets', target), '\n/* tampered */');
    return target;
  };

  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'sri-browser-'));

    // a real Vite project: an entry with a CSS import and a lazy chunk
    const project = path.join(work, 'project');
    fs.mkdirSync(path.join(project, 'src'), { recursive: true });
    fs.writeFileSync(path.join(project, 'index.html'), '<!doctype html><html><head></head><body><script type="module" src="/src/main.js"></script></body></html>');
    fs.writeFileSync(path.join(project, 'src', 'main.js'), "import './style.css'; window.__main = true; import('./lazy.js').then(m => { window.__lazy = m.value }).catch(e => { window.__lazyError = String(e) });");
    fs.writeFileSync(path.join(project, 'src', 'lazy.js'), "export const value = 'lazy-ok';");
    fs.writeFileSync(path.join(project, 'src', 'style.css'), 'body { background: rgb(1, 2, 3); }');
    const built = spawnSync(process.execPath, [path.join(__dirname, '..', 'helpers', 'vite-build.mjs'), project, 'plain'], { encoding: 'utf8', timeout: 120000 });
    if (built.status !== 0) throw new Error(`vite build failed: ${built.stdout}${built.stderr}`);

    for (const name of ['healthy', 'entry', 'lazy', 'css']) fs.cpSync(path.join(project, 'dist'), path.join(work, name), { recursive: true });
    tamper(path.join(work, 'entry'), /^index-.*\.js$/);
    tamper(path.join(work, 'lazy'), /^lazy-.*\.js$/);
    tamper(path.join(work, 'css'), /\.css$/);
  });
  afterAll(async () => {
    await browser.close();
    servers.forEach(s => s.close());
    fs.rmSync(work, { recursive: true, force: true });
  });

  test('an honest build runs: entry, lazy chunk and stylesheet all load, with no integrity errors', async () => {
    const t = await open(await site(path.join(work, 'healthy')));
    expect(await t.get('__main')).toBe(true);
    expect(await t.get('__lazy')).toBe('lazy-ok');
    expect(await t.page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(1, 2, 3)');
    expect(t.messages.filter(m => /integrity|digest/i.test(m))).toEqual([]);
  });

  test('a tampered entry script is refused', async () => {
    const t = await open(await site(path.join(work, 'entry')), () => false);
    expect(await t.get('__main')).toBeUndefined();
    expect(t.messages.join('\n')).toMatch(/integrity|digest/i);
  });

  test('a tampered lazy chunk is refused through the import map, while the entry still runs', async () => {
    const t = await open(await site(path.join(work, 'lazy')));
    expect(await t.get('__main')).toBe(true);
    expect(await t.get('__lazy')).toBeUndefined();
    expect(await t.get('__lazyError')).toBeDefined();
    expect(t.messages.join('\n')).toMatch(/integrity|digest/i);
  });

  test('a tampered stylesheet is refused', async () => {
    const t = await open(await site(path.join(work, 'css')));
    expect(await t.page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe('rgb(1, 2, 3)');
    expect(t.messages.join('\n')).toMatch(/integrity|digest/i);
  });

  describe('third-party scripts, pinned from another origin', () => {
    const page = (src) => `<!doctype html><html><head><script src="${src}"></script></head><body></body></html>`;

    test('one that sends CORS headers is pinned and loads', async () => {
      const cdn = path.join(work, 'cdn-ok'); fs.mkdirSync(cdn);
      fs.writeFileSync(path.join(cdn, 'lib.js'), 'window.__lib = true;');
      const cdnUrl = await site(cdn, { cors: true });
      const out = path.join(work, 'page-ok'); fs.mkdirSync(out);
      fs.writeFileSync(path.join(out, 'index.html'), page(`${cdnUrl}/lib.js`));
      const run = await new SubresourceIntegrityInjector().insertSRIInHTML(out, 'sha384', { external: true });
      expect(run.errors).toEqual([]);
      expect(fs.readFileSync(path.join(out, 'index.html'), 'utf8')).toMatch(/integrity="sha384-.*crossorigin="anonymous"/);
      const t = await open(await site(out), () => window.__lib !== undefined);
      expect(await t.get('__lib')).toBe(true);
    });

    test('one without CORS headers is left alone, so the page does not break', async () => {
      const cdn = path.join(work, 'cdn-nocors'); fs.mkdirSync(cdn);
      fs.writeFileSync(path.join(cdn, 'lib.js'), 'window.__lib = true;');
      const cdnUrl = await site(cdn, { cors: false });
      const out = path.join(work, 'page-nocors'); fs.mkdirSync(out);
      fs.writeFileSync(path.join(out, 'index.html'), page(`${cdnUrl}/lib.js`));
      const run = await new SubresourceIntegrityInjector().insertSRIInHTML(out, 'sha384', { external: true });
      expect(run.warnings.join()).toMatch(/Access-Control-Allow-Origin/);
      expect(fs.readFileSync(path.join(out, 'index.html'), 'utf8')).not.toContain('integrity=');
      const t = await open(await site(out), () => window.__lib !== undefined);
      expect(await t.get('__lib')).toBe(true);
    });
  });

  test('with the Integrity-Policy header, a script added at runtime without integrity is blocked', async () => {
    const out = path.join(work, 'policy'); fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, 'app.js'), 'window.__app = true;');
    fs.writeFileSync(path.join(out, 'rogue.js'), 'window.__rogue = true;');
    fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><html><head><script src="/app.js"></script></head><body></body></html>');
    const run = await new SubresourceIntegrityInjector().insertSRIInHTML(out, 'sha384', { integrityPolicy: true });
    expect(run.errors).toEqual([]);
    const { name, value } = run.integrityPolicy;
    const t = await open(await site(out, { headers: { [name]: value } }), () => window.__app !== undefined);
    expect(await t.get('__app')).toBe(true); // our own protected script runs
    await t.page.evaluate(() => { const s = document.createElement('script'); s.src = '/rogue.js'; document.head.appendChild(s); });
    await t.page.waitForTimeout(500);
    expect(await t.get('__rogue')).toBeUndefined(); // an unprotected script does not
  });
});
