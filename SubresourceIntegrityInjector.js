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
     * Resolves to `{ files, errors, warnings, integrityPolicy }`: the number of HTML files processed,
     * every resource that could not be protected (`errors`), every existing integrity value that was
     * wrong and got replaced or other advisory (`warnings`), and the Integrity-Policy header when one
     * was requested. The caller decides what is fatal; the CLI exits 1 on any error.
     *
     * With options.strict it rejects instead when there are errors or no HTML files at all.
     *
     * Other options are those of the plugins (see lib/options): base, crossorigin, external,
     * externalTimeout and integrityPolicy ({ reportOnly, endpoints, headersFile }).
     */
    async insertSRIInHTML(outputDir, algorithm = 'sha384', options = {}) {
        const run = await processDirectory(outputDir, { ...options, algorithm })
        if (options.strict) {
            const { fatal } = classify(run.diagnostics, { strict: true })
            if (fatal.length) throw new Error(formatFatal(fatal))
        }
        return { files: run.files, errors: run.errors, warnings: run.warnings, integrityPolicy: run.integrityPolicy }
    }
}

module.exports = SubresourceIntegrityInjector
