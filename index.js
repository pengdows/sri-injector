const SubresourceIntegrityInjector = require('./SubresourceIntegrityInjector');
const { injectSri, processPages, resolveOptions } = require('./core');
const { processDirectory, checkDirectory } = require('./lib/directory');

// The default export is the directory injector class; the building blocks hang off it.
module.exports = SubresourceIntegrityInjector;
module.exports.SubresourceIntegrityInjector = SubresourceIntegrityInjector;
module.exports.injectSri = injectSri;
module.exports.processPages = processPages;
module.exports.processDirectory = processDirectory;
module.exports.checkDirectory = checkDirectory;
module.exports.resolveOptions = resolveOptions;
