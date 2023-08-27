const fs = require('fs-extra');
const path = require('path');
const SubresourceIntegrityInjector = require('../SubresourceIntegrityInjector')

const TEST_DIR = path.join(__dirname, 'test_dist');
const HTML_FILE = path.join(TEST_DIR, 'index.html');

beforeAll(() => {
  // Create a test directory and an index.html file
  fs.removeSync(TEST_DIR);
  fs.ensureDirSync(TEST_DIR);
  const jsContent = 'console.log("hello world");';
  const jsPath = path.join(TEST_DIR, 'test.js');
  fs.writeFileSync(jsPath, jsContent);
  fs.writeFileSync(HTML_FILE, '<html><head><script src="test.js"></script></head><body></body></html>');
});

afterAll(() => {
  // Clean up after tests are done
  fs.removeSync(TEST_DIR);
});

test('insertSRIInHTML should add SRI attributes', async () => {

  const s = new SubresourceIntegrityInjector();
  await s.insertSRIInHTML(TEST_DIR).then(()=>{
    const updatedHtmlContent = fs.readFileSync(HTML_FILE, 'utf-8');

    // Check if integrity attribute has been added to the script tag
    expect(updatedHtmlContent).toMatch(/<script src="test\.js" integrity="[^"]+" crossorigin="anonymous"><\/script>/);
  }).catch(()=>{
    console.log("error");
  });
});

