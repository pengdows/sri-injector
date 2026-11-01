#!/usr/bin/env node

const { program } = require('commander');
const SubresourceIntegrityInjector = require('../SubresourceIntegrityInjector');
const pkg = require('../package.json');

program
  .version(pkg.version)
  .description('Inject Subresource Integrity (SRI) attributes into HTML files.')
  .argument('<outputDir>', 'Directory containing the HTML and asset files (e.g., ./dist)')
  .option('-a, --algo <algorithm>', 'Hash algorithm to use (sha256, sha384, sha512)', 'sha384')
  .option('--strict', 'Also fail (exit 1) when no HTML files are found', false)
  .option('-b, --base <pathOrUrl>', 'Public base the HTML was built for (e.g. /app/ or https://cdn.example.com/). With a URL, assets under it are hashed instead of skipped as external', '/')
  .option('--external', 'Also fetch third-party resources (https://..., //host/...) and pin them. Servers without CORS headers are skipped with a warning', false)
  .option('--external-timeout <ms>', 'Per-request timeout for --external', (v) => parseInt(v, 10), 10000)
  .option('--integrity-policy [mode]', 'Prepare the Integrity-Policy response header ("enforce" or "report-only"). Any script still without integrity becomes an error, since the header would make browsers block it')
  .option('--headers-file <path>', 'With --integrity-policy: write the header into this Netlify/Cloudflare-style _headers file (relative to outputDir)')
  .action((outputDir, options) => {
    const injector = new SubresourceIntegrityInjector();
    const integrityPolicy = options.integrityPolicy
      ? { reportOnly: options.integrityPolicy === 'report-only', headersFile: options.headersFile }
      : undefined;
    if (options.integrityPolicy && !['enforce', 'report-only', true].includes(options.integrityPolicy)) {
      console.error(`\n❌ --integrity-policy must be "enforce" or "report-only", got "${options.integrityPolicy}"`);
      process.exitCode = 1;
      return;
    }
    injector.insertSRIInHTML(outputDir, options.algo, {
      strict: options.strict,
      base: options.base,
      external: options.external,
      externalTimeout: options.externalTimeout,
      integrityPolicy,
    })
      .then(({ files, errors, warnings, integrityPolicy: header }) => {
        if (header) {
          const where = options.headersFile ? ` (written to ${options.headersFile})` : '';
          console.log(`\nℹ️  Send this response header with your HTML${where}:\n    ${header.name}: ${header.value}`);
        }
        const replaced = warnings.length ? ` (${warnings.length} warning(s) above)` : '';
        if (files === 0) {
          console.warn(`\n⚠️  No HTML files found in: ${outputDir} (nothing to do)`);
          return;
        }
        if (errors.length > 0) {
          // HTML files with resolvable resources have still been rewritten, but the build must not be
          // treated as successful: a missing integrity attribute is a silent security regression.
          console.error(`\n❌ Processed ${files} HTML file(s) in ${outputDir}, but ${errors.length} resource(s) could not be processed (see errors above).`);
          process.exitCode = 1;
          return;
        }
        console.log(`\n✅ SRI attributes successfully injected into ${files} HTML file(s) in: ${outputDir}${replaced}`);
      })
      .catch((error) => {
        console.error(`\n❌ Failed to inject SRI attributes: ${error.message}`);
        process.exitCode = 1;
      });
  });

program.parse(process.argv);
