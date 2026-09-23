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
