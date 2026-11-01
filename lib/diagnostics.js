/**
 * Structured diagnostics: every adapter (CLI, Rollup/Vite, webpack) reports problems as
 * `{ severity, code, message, file?, url? }` and decides what is fatal with one rule, `classify`,
 * instead of each keeping its own strings and its own idea of "strict".
 */
const CODES = Object.freeze({
    RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
    RESOURCE_FAILED: 'RESOURCE_FAILED',
    RESOURCE_SKIPPED: 'RESOURCE_SKIPPED',
    INTEGRITY_REPLACED: 'INTEGRITY_REPLACED',
    IMPORT_MAP_INVALID: 'IMPORT_MAP_INVALID',
    UNPROTECTED_SCRIPT: 'UNPROTECTED_SCRIPT',
    DYNAMIC_IMPORT: 'DYNAMIC_IMPORT',
    NO_HTML: 'NO_HTML'
})

const error = (code, message, extra = {}) => ({ severity: 'error', code, message, ...extra })
const warning = (code, message, extra = {}) => ({ severity: 'warning', code, message, ...extra })

/**
 * Nothing was protected because there was no HTML to protect. An error, but only a fatal one in
 * strict mode (see classify): a build that legitimately has no pages is not always a misconfiguration.
 */
function noHtmlDiagnostic(where) {
    return error(CODES.NO_HTML, `No HTML files found in ${where}; no integrity attributes were injected.`)
}

/**
 * Splits diagnostics into the ones that must fail the run and the ones to merely report.
 * Errors are fatal; "no HTML" is an error only when `strict`; warnings are never fatal.
 */
function classify(diagnostics, { strict = false } = {}) {
    const fatal = []
    const warnings = []
    for (const d of diagnostics) {
        const isFatal = d.severity === 'error' && (d.code !== CODES.NO_HTML || strict)
        ;(isFatal ? fatal : warnings).push(d)
    }
    return { fatal, warnings }
}

function formatDiagnostic(d) {
    return d.file ? `${d.file}: ${d.message}` : d.message
}

const bullets = (items) => items.map(d => `\n  - ${formatDiagnostic(d)}`).join('')

/**
 * One summary text for a set of fatal diagnostics, with the same wording in every adapter.
 */
function formatFatal(fatal) {
    const unprotected = fatal.filter(d => d.code === CODES.UNPROTECTED_SCRIPT)
    const noHtml = fatal.filter(d => d.code === CODES.NO_HTML)
    const resources = fatal.filter(d => d.code !== CODES.UNPROTECTED_SCRIPT && d.code !== CODES.NO_HTML)
    const parts = []
    if (resources.length) {
        parts.push(`${resources.length} resource(s) could not be processed:${bullets(resources)}`)
    }
    if (unprotected.length) {
        const lines = unprotected.map(d => `\n  - ${d.file ? d.file + ': ' : ''}${d.url}`).join('')
        parts.push(`${unprotected.length} script(s) have no integrity and would be blocked by the Integrity-Policy header:${lines}`)
    }
    for (const d of noHtml) parts.push(d.message)
    return parts.join('\n')
}

module.exports = { CODES, error, warning, noHtmlDiagnostic, classify, formatDiagnostic, formatFatal }
