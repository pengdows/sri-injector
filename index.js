const SubresourceIntegrityInjector = require('./SubresourceIntegrityInjector')

const configPath = path.join(__dirname, 'sri.config.json')
const tmp = {
  outputDir: null,
  algorithm: null
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) || tmp

const args = process.argv.slice(2)
if (args && args.length) {
  if (config.outputDir) {
    config.outputDir = args[0]
  }
  if (config.algorithm && args.length > 1) {
    config.algorithm = args[1]
  }
}

config.outputDir = configPath.outputDir || path.join(__dirname, 'dist')
config.algorithm = configPath.algorithm || 'sha284'

const s = new SubresourceIntegrityInjector()
s.insertSRIInHTML(outputDir, algorithm)
  .then(() => {
    console.log('SRI attributes inserted.')
  })
  .catch((error) => {
    console.error('Error:', error)
  })

process.on('unhandledRejection', () => {
  // eat error quietly
})
//
//
// const path = require('path');
// const fs = require('fs');
// const insertSRIInHTML = require('./src/index');  // replace with the actual path to your function
//
// const configPath = path.join(__dirname, 'sri.config.json');
// const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
//
// const outputDir = config.outputDir || './dist';
// const algorithm = config.algorithm || 'sha384';
//
// insertSRIInHTML(outputDir, algorithm)
//   .then(() => {
//     console.log('SRI attributes inserted successfully.');
//   })
//   .catch((error) => {
//     console.error(`An error occurred: ${error}`);
//   });
