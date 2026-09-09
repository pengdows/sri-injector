const HashAlgo = (() => {
  function createEnum(values) {
    const enumObject = {};
    for (const val of values) {
      enumObject[val] = val;
    }
    return Object.freeze(enumObject);
  }

  return createEnum(['sha256', 'sha384', 'sha512']);
})();
module.exports = HashAlgo;
