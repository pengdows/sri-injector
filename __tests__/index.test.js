const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
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

test('skips external and data URLs without touching the filesystem for them', async () => {
  const dir = freshDir('external-urls');
  fs.writeFileSync(
    path.join(dir, 'index.html'),
    '<html><head>' +
      '<script src="https://cdn.example.com/lib.js"></script>' +
      '<script src="//cdn.example.com/other.js"></script>' +
      '<script src="data:text/javascript,console.log(1)"></script>' +
      '</head><body></body></html>'
  );

  const injector = new SubresourceIntegrityInjector();
  const report = await injector.insertSRIInFile(path.join(dir, 'index.html'), dir);

  expect(report.errors).toHaveLength(0);
  expect(report.skippedExternal).toHaveLength(3);
  const updated = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  expect(updated).not.toContain('integrity=');
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
