
const HashAlgo = require('../HashAlgo');
test('it should exist and have properties',()=>{
  const arr = Object.getOwnPropertyNames(HashAlgo);
  expect(arr).toBeDefined();
  expect(arr.length).toBeGreaterThan(0);
});
