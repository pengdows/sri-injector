const { injectSri } = require('./html')
const { mergeHeadersFile } = require('./policy')
const { error, CODES } = require('./diagnostics')

/**
 * The pipeline every host shares: run each HTML page through injectSri, tag diagnostics with the page
 * they came from, and, when an Integrity-Policy is configured, audit the pages and prepare the
 * headers file. Hosts (CLI, Rollup/Vite, webpack) supply only how to find an asset, how to store a
 * rewritten page, and how to report what comes back.
 *
 * @param {{name: string, html: string, resolveAsset: Function, importMapIntegrity?: Function}[]} pages
 * @param {object} config  from resolveOptions
 * @param {{base?: string, resolveExternal?: Function,
 *          headersFile?: {read: () => Promise<string|null>, write: (content: string) => Promise<void>}, extraDiagnostics?: object[]}} [runtime]
 *        `base` overrides config.base (Vite learns it late); `headersFile` is how the host reads and
 *        stores the Netlify/Cloudflare `_headers` file; `extraDiagnostics` are problems only the host can
 *        see (e.g. webpack's lazy chunks), reported with the rest. An error among them keeps the header
 *        from being written, like an uncovered script.
 * @returns {Promise<{pages: {name: string, html: string, modified: boolean, changes: object[]}[], diagnostics: object[]}>}
 *          Each page's `changes` (see injectSri) are tagged with the page's name, like diagnostics.
 */
async function processPages(pages, config, runtime = {}) {
    const base = runtime.base !== undefined ? runtime.base : config.base
    const diagnostics = [...(runtime.extraDiagnostics || [])]
    const results = []

    for (const page of pages) {
        const r = await injectSri(page.html, page.resolveAsset, {
            algorithm: config.algorithm,
            crossorigin: config.crossorigin,
            base,
            resolveExternal: runtime.resolveExternal,
            importMapIntegrity: page.importMapIntegrity
        })
        r.diagnostics.forEach(d => diagnostics.push({ ...d, file: page.name }))
        if (config.policy) {
            for (const url of r.unprotectedScripts) {
                diagnostics.push(error(CODES.UNPROTECTED_SCRIPT, `Script "${url}" has no integrity and would be blocked by the Integrity-Policy header`, { file: page.name, url }))
            }
        }
        results.push({ name: page.name, html: r.html, modified: r.modified, changes: r.changes.map(c => ({ ...c, file: page.name })) })
    }

    // The header would make browsers block any uncovered script; shipping both is a broken site.
    const blocked = diagnostics.some(d => d.severity === 'error' && [CODES.UNPROTECTED_SCRIPT, CODES.UNPROTECTED_CHUNK, CODES.DYNAMIC_IMPORT].includes(d.code))
    if (config.policy && config.policy.headersFile && runtime.headersFile && pages.length > 0 && !blocked) {
        const existing = await runtime.headersFile.read()
        await runtime.headersFile.write(mergeHeadersFile(existing || '', config.policyHeader))
    }

    return { pages: results, diagnostics }
}

module.exports = { processPages }
