const SubresourceIntegrityInjector = require('./SubresourceIntegrityInjector')

// Example Usage
const outputDir = './dist';  // Configure this to your build tool's output directory
const injector = new SubresourceIntegrityInjector({ algorithm: 'sha384' });

injector.insertSRIInDirectory(outputDir)
  .then((report) => {
    console.log(`SRI attributes inserted for ${report.processed.length} resource(s).`);
    if (report.skipped.length > 0) {
      console.log(`Skipped ${report.skipped.length} resource(s).`);
    }
    if (report.warnings.length > 0) {
      console.warn('Warnings:', report.warnings);
    }
    if (report.errors.length > 0) {
      console.error('Errors:', report.errors);
    }
  })
  .catch((error) => {
    console.error('Error:', error);
  });
