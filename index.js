const SubresourceIntegrityInjector = require('./SubresourceIntegrityInjector')

// Example Usage
const outputDir = './dist';  // Configure this to your build tool's output directory
const algorithm = 'sha256';  // Configure the algorithm here
const s = new SubresourceIntegrityInjector()
s.insertSRIInHTML(outputDir, algorithm)
  .then(() => {
    console.log('SRI attributes inserted.');
  })
  .catch((error) => {
    console.error('Error:', error);
  });

process.on("unhandledRejection", () => {
  // eat error quietly
});
