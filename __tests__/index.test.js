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
  // Cheerio might reorder attributes or use self-closing tags depending on settings
  expect(updatedHtmlContent).toContain('src="test.js"');
  expect(updatedHtmlContent).toContain('async=""');
  expect(updatedHtmlContent).toContain('defer=""');
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

test('strict mode rejects when a resource is missing; default does not', async () => {
    fs.writeFileSync(HTML_FILE, '<html><head><script src="nope.js"></script></head><body></body></html>');
    const s = new SubresourceIntegrityInjector();
    await expect(s.insertSRIInHTML(TEST_DIR, 'sha256')).resolves.toBeUndefined();
    await expect(s.insertSRIInHTML(TEST_DIR, 'sha256', { strict: true })).rejects.toThrow(/nope\.js/);
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
