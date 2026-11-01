#!/usr/bin/env node

const { program } = require('commander');
const SubresourceIntegrityInjector = require('../SubresourceIntegrityInjector');
const pkg = require('../package.json');

program
  .version(pkg.version)
  .description('Inject Subresource Integrity (SRI) attributes into HTML files.')
  .argument('<outputDir>', 'Directory containing the HTML and asset files (e.g., ./dist)')
  .option('-a, --algo <algorithm>', 'Hash algorithm to use (sha256, sha384, sha512)', 'sha384')
  .option('--strict', 'Fail (exit 1) if any referenced resource is missing or rejected', false)
  .action((outputDir, options) => {
    const injector = new SubresourceIntegrityInjector();
    injector.insertSRIInHTML(outputDir, options.algo, { strict: options.strict })
      .then(() => {
        console.log(`\n✅ SRI attributes successfully injected into HTML files in: ${outputDir}`);
      })
      .catch((error) => {
        console.error(`\n❌ Failed to inject SRI attributes: ${error.message}`);
        process.exit(1);
      });
  });

program.parse(process.argv);
