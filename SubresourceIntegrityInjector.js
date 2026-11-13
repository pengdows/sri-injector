const { processDirectory } = require('./lib/directory')
const { classify, formatFatal } = require('./lib/diagnostics')

/**
 * Injects SRI attributes into the HTML files of a build output directory. A thin wrapper over
 * processDirectory (lib/directory.js): it holds no state, so one instance can be reused freely.
 */
class SubresourceIntegrityInjector {
    /**
     * Scans outputDir (recursively) and injects SRI attributes into every HTML file.
     *
     * Resolves to `{ files, changes, errors, warnings, integrityPolicy }`: the number of HTML files
     * processed, the edits made (`{ file, kind, url? }`, see processDirectory), every resource that
     * could not be protected (`errors`), every existing integrity value that was wrong and got
     * replaced or other advisory (`warnings`), and the Integrity-Policy header when one was requested.
     * The caller decides what is fatal; the CLI exits 1 on any error.
     *
     * With options.strict it rejects instead when there are errors or no HTML files at all.
     *
     * With options.dryRun nothing is written and `changes` lists what a real run would do; an empty
     * list means every page is already up to date (this is what `--check` builds on).
     *
     * Other options are those of the plugins (see lib/options): base, crossorigin, external,
     * externalTimeout and integrityPolicy ({ reportOnly, endpoints, headersFile }).
     */
    async insertSRIInHTML(outputDir, algorithm = 'sha384', options = {}) {
        const run = await processDirectory(outputDir, { ...options, algorithm })
        if (options.strict) {
            const { fatal } = classify(run.diagnostics, { strict: true })
            if (fatal.length) {
                // The run is over, so hand its warnings to the caller along with the failure.
                throw Object.assign(new Error(formatFatal(fatal)), { warnings: run.warnings })
            }
        }
        return { files: run.files, changes: run.changes, errors: run.errors, warnings: run.warnings, integrityPolicy: run.integrityPolicy }
    }
}

module.exports = SubresourceIntegrityInjector
