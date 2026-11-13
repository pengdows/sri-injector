#!/usr/bin/env node

const { program, Option, InvalidArgumentError } = require('commander');
const SubresourceIntegrityInjector = require('../SubresourceIntegrityInjector');
const { checkDirectory } = require('../lib/directory');
const pkg = require('../package.json');

function parseTimeout(value) {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new InvalidArgumentError('must be a positive integer (milliseconds).');
  }
  return parseInt(value, 10);
}

const CHANGE_TEXT = {
  'add-integrity': 'add integrity',
  'replace-integrity': 'replace wrong integrity',
  'add-crossorigin': 'add crossorigin',
  'update-import-map': 'update import map integrity',
  'update-headers-file': 'add the Integrity-Policy header',
  'update-manifest-file': 'write the hash manifest',
};

/**
 * --dry-run: lists what a real run would change, one line per tag. The changes for one tag are
 * consecutive (integrity, then crossorigin), so consecutive entries for the same file and URL merge.
 */
function printChanges(changes) {
  const lines = [];
  for (const c of changes) {
    const last = lines[lines.length - 1];
    if (last && last.file === c.file && last.url === c.url) last.actions.push(CHANGE_TEXT[c.kind] || c.kind);
    else lines.push({ file: c.file, url: c.url, actions: [CHANGE_TEXT[c.kind] || c.kind] });
  }
  let file;
  for (const line of lines) {
    if (line.file !== file) console.log(`\nWould update ${(file = line.file)}:`);
    console.log(`  ${line.url === undefined ? '' : `"${line.url}": `}${line.actions.join(', ')}`);
  }
}

// --check report: failures are marked ✗, results that are listed but do not fail are marked -.
const CHECK_LABEL = {
  missing: '✗ missing', wrong: '✗ wrong', 'not-found': '✗ not found', blocked: '✗ blocked',
  skipped: '- skipped', unchecked: '- unchecked',
};
const COUNT_LABEL = { 'not-found': 'not found' };

function printCheck(outputDir, { files, passed, integrityFound, results, counts, diagnostics }, { strict }) {
  const noHtml = diagnostics.find(d => d.code === 'NO_HTML');
  if (noHtml) {
    if (strict) console.error(`\n❌ Check failed: ${noHtml.message}`);
    else console.warn(`\n⚠️  No HTML files found in: ${outputDir} (nothing to check)`);
    process.exitCode = strict ? 1 : 0;
    return;
  }

  // One block per page, in the order the pages were examined; passing results are not listed.
  const byPage = new Map();
  const add = (file, line) => {
    if (!byPage.has(file)) byPage.set(file, []);
    byPage.get(file).push(line);
  };
  for (const d of diagnostics) add(d.file, `✗ ${d.message}`);
  for (const r of results) {
    if (r.status === 'ok') continue;
    const what = `${r.target === 'import-map' ? 'import map ' : ''}"${r.url}"`;
    add(r.file, `${CHECK_LABEL[r.status].padEnd(11)} ${what}${r.message ? `: ${r.message}` : ''}`);
  }
  for (const [file, lines] of byPage) console.log(`\n${file}\n${lines.map(l => `  ${l}`).join('\n')}`);

  if (!integrityFound && results.some(r => r.status === 'missing')) {
    console.log('\n⚠️  No integrity attributes found: sri-injector does not appear to have been run on this output.');
  }
  console.log('\nℹ️  Not checked: chunks loaded with import() are covered only through an import map entry, and a chunk without one cannot be detected from the output.');

  const tally = Object.entries(counts).filter(([, n]) => n > 0).map(([s, n]) => `${n} ${COUNT_LABEL[s] || s}`).join(', ');
  const pageProblems = diagnostics.length ? `; ${diagnostics.length} page problem(s)` : '';
  const summary = `${results.length} target(s) in ${files} HTML file(s)${tally ? `: ${tally}` : ''}${pageProblems}`;
  if (passed) {
    console.log(`\n✅ Check passed: ${summary}.`);
  } else {
    console.error(`\n❌ Check failed: ${summary} (listed above).`);
    process.exitCode = 1;
  }
}

function runInject(outputDir, options, sriOptions) {
  const dryRun = !!options.dryRun;
  return new SubresourceIntegrityInjector().insertSRIInHTML(outputDir, options.algo, { ...sriOptions, dryRun, manifestFile: options.manifestFile })
    .then(({ files, changes, errors, warnings, integrityPolicy: header }) => {
      const headersChanged = changes.some(c => c.kind === 'update-headers-file');
      const manifestChanged = changes.some(c => c.kind === 'update-manifest-file');
      if (dryRun) printChanges(changes);
      // The library never prints; diagnostics are reported here.
      errors.forEach(m => console.error(`Error: ${m}`));
      warnings.forEach(m => console.warn(`Warning: ${m}`));
      if (header) {
        let where = '';
        if (options.headersFile && !dryRun) where = ` (written to ${options.headersFile})`;
        else if (options.headersFile && headersChanged) where = ` (would be written to ${options.headersFile})`;
        console.log(`\nℹ️  Send this response header with your HTML${where}:\n    ${header.name}: ${header.value}`);
        if (header.name === 'Integrity-Policy' && errors.length === 0) {
          console.warn('⚠️  The CLI cannot prove that every script is covered: it sees <script> tags and literal import() calls, not loaders that build their requests at runtime (webpack chunk loading, for one). A script without integrity is blocked by this header. Try --integrity-policy-report-only first.');
        }
      }
      const warned = warnings.length ? ` (${warnings.length} warning(s) above)` : '';
      if (files === 0) {
        console.warn(`\n⚠️  No HTML files found in: ${outputDir} (nothing to do)`);
        return;
      }
      if (errors.length > 0) {
        // HTML files with resolvable resources have still been rewritten, but the build must not be
        // treated as successful: a missing integrity attribute is a silent security regression.
        const written = dryRun ? ' Nothing was written (dry run).' : '';
        console.error(`\n❌ Processed ${files} HTML file(s) in ${outputDir}, but ${errors.length} resource(s) could not be processed (see errors above).${written}`);
        process.exitCode = 1;
        return;
      }
      if (dryRun) {
        const pages = new Set(changes.filter(c => c.kind !== 'update-headers-file' && c.kind !== 'update-manifest-file').map(c => c.file)).size;
        const parts = [];
        if (pages) parts.push(`${pages} of ${files} HTML file(s) in ${outputDir} would get SRI updates`);
        if (headersChanged) parts.push(`${options.headersFile} would get the Integrity-Policy header`);
        if (manifestChanged) parts.push(`${options.manifestFile} would be written`);
        if (parts.length) console.log(`\nℹ️  Dry run: ${parts.join(', and ')} (listed above)${warned}. Nothing was written.`);
        else console.log(`\n✅ Dry run: nothing to change in ${files} HTML file(s) in ${outputDir}${warned}. Nothing was written.`);
        return;
      }
      const manifest = options.manifestFile ? `; hashes written to ${options.manifestFile}` : '';
      console.log(`\n✅ SRI attributes successfully injected into ${files} HTML file(s) in: ${outputDir}${warned}${manifest}`);
    });
}

program
  .version(pkg.version)
  .description('Inject Subresource Integrity (SRI) attributes into HTML files.')
  .argument('<outputDir>', 'Directory containing the HTML and asset files (e.g., ./dist)')
  .option('-a, --algo <algorithm>', 'Hash algorithm to use (sha256, sha384, sha512)', 'sha384')
  .option('--crossorigin <value>', 'Value for the crossorigin attribute on tags that have none (anonymous or use-credentials)', 'anonymous')
  .option('--strict', 'Also fail (exit 1) when no HTML files are found', false)
  .option('-b, --base <pathOrUrl>', 'Public base the HTML was built for (e.g. /app/ or https://cdn.example.com/). With a URL, assets under it are hashed instead of skipped as external', '/')
  .option('--external', 'Also fetch third-party resources (https://..., //host/...) and pin them. Servers without CORS headers are skipped with a warning', false)
  .option('--external-timeout <ms>', 'Per-request timeout for --external', parseTimeout, 10000)
  .addOption(new Option('--integrity-policy', 'Prepare the Integrity-Policy response header. Any script still without integrity becomes an error, since the header would make browsers block it').default(false).conflicts('integrityPolicyReportOnly'))
  .addOption(new Option('--integrity-policy-report-only', 'Like --integrity-policy, but prepare Integrity-Policy-Report-Only, which reports violations without blocking (use it to roll the policy out)').default(false).conflicts('integrityPolicy'))
  .option('--headers-file <path>', 'With either policy flag: write the header into this Netlify/Cloudflare-style _headers file (relative to outputDir)')
  .addOption(new Option('--manifest-file <path>', 'Also write a JSON file (relative to outputDir) with the integrity of every file in the output except HTML and source maps, for a shell or backend that loads this build at runtime').conflicts('check'))
  .addOption(new Option('--dry-run', 'Show what a run would change, without writing anything. Exits as a real run would'))
  .addOption(new Option('--check', 'Validate the integrity already in the output, without writing anything: exit 1 if any is missing or wrong, or a referenced file is not found').conflicts('dryRun'))
  .action((outputDir, options) => {
    if (options.headersFile && !options.integrityPolicy && !options.integrityPolicyReportOnly) {
      program.error('error: --headers-file needs --integrity-policy or --integrity-policy-report-only (it would be ignored)');
    }
    const integrityPolicy = options.integrityPolicy || options.integrityPolicyReportOnly
      ? { reportOnly: options.integrityPolicyReportOnly, headersFile: options.headersFile }
      : undefined;
    const sriOptions = {
      strict: options.strict,
      crossorigin: options.crossorigin,
      base: options.base,
      external: options.external,
      externalTimeout: options.externalTimeout,
      integrityPolicy,
    };
    const run = options.check
      ? checkDirectory(outputDir, { ...sriOptions, algorithm: options.algo }).then(result => printCheck(outputDir, result, options))
      : runInject(outputDir, options, sriOptions);
    const failed = options.check ? 'Check failed' : options.dryRun ? 'Dry run failed' : 'Failed to inject SRI attributes';
    run.catch((error) => {
      (error.warnings || []).forEach(m => console.warn(`Warning: ${m}`));
      console.error(`\n❌ ${failed}: ${error.message}`);
      process.exitCode = 1;
    });
  });

program.parse(process.argv);
