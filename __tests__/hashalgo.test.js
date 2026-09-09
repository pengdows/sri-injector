const HashAlgo = require('../HashAlgo');

test('exposes exactly the SRI-legal algorithms', () => {
  expect(Object.keys(HashAlgo).sort()).toEqual(['sha256', 'sha384', 'sha512']);
});

test('is frozen', () => {
  expect(Object.isFrozen(HashAlgo)).toBe(true);
});
