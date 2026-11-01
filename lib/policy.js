const path = require('path')

// RFC 8941 structured-field token: reporting endpoint names must be one of these.
const SF_TOKEN = /^[A-Za-z*][A-Za-z0-9:/!#$%&'*+\-.^_`|~]*$/

/**
 * Builds the Integrity-Policy response header (WebAppSec SRI "Integrity Policy"). Browsers honouring
 * it block script requests that carry no integrity metadata (attribute or import map), so it must
 * only be enabled once every script on every page is covered.
 * Only the `script` destination exists in the spec today.
 *
 * @param {{reportOnly?: boolean, endpoints?: string[]}} [options]
 *        `endpoints` are Reporting API endpoint names (declared separately via Reporting-Endpoints).
 * @returns {{name: string, value: string}}
 */
function buildIntegrityPolicyHeader({ reportOnly = false, endpoints = [] } = {}) {
    for (const e of endpoints) {
        if (!SF_TOKEN.test(e)) throw new Error(`Invalid reporting endpoint name "${e}": must be a structured-field token`)
    }
    const parts = ['blocked-destinations=(script)', 'sources=(inline)']
    if (endpoints.length) parts.push(`endpoints=(${endpoints.join(' ')})`)
    return { name: reportOnly ? 'Integrity-Policy-Report-Only' : 'Integrity-Policy', value: parts.join(', ') }
}

/**
 * The headers file is read and written relative to the output directory, so it must be a plain
 * relative path that stays inside it ("_headers", "sub/_headers"; never "../x" or an absolute path).
 */
function validateHeadersFile(file) {
    if (file === undefined || file === null || file === '') return undefined
    const segments = String(file).split(/[\\/]/)
    if (typeof file !== 'string' || path.isAbsolute(file) || path.win32.isAbsolute(file) || segments.includes('..')) {
        throw new Error(`Invalid headers file ${JSON.stringify(file)}: must be a relative path inside the output directory`)
    }
    return file
}

/**
 * Normalizes the user-facing `integrityPolicy` option:
 *   false | undefined        -> null (off)
 *   true | 'enforce'         -> { reportOnly: false, endpoints: [], headersFile: undefined }
 *   'report-only'            -> { reportOnly: true, ... }
 *   { reportOnly, endpoints, headersFile }
 */
function normalizeIntegrityPolicy(option) {
    if (!option) return null
    if (option === true || option === 'enforce') return { reportOnly: false, endpoints: [], headersFile: undefined }
    if (option === 'report-only') return { reportOnly: true, endpoints: [], headersFile: undefined }
    if (typeof option === 'object') {
        return { reportOnly: !!option.reportOnly, endpoints: option.endpoints || [], headersFile: validateHeadersFile(option.headersFile) }
    }
    throw new Error(`Invalid integrityPolicy option: ${JSON.stringify(option)}`)
}

/**
 * Adds `header` to a Netlify / Cloudflare Pages style `_headers` file body under a catch-all rule,
 * replacing an earlier value of the same header (either enforcing or report-only variant) so that
 * re-running the build does not accumulate entries. Other rules are left untouched.
 */
function mergeHeadersFile(existing, header) {
    const names = ['Integrity-Policy', 'Integrity-Policy-Report-Only']
    const lines = (existing || '').split('\n').filter(line => !names.some(n => line.trim().startsWith(n + ':')))
    // Drop a rule that we emptied, and trailing blank lines
    const kept = lines.join('\n').replace(/(^|\n)\/\*\n(?=\n|$)/g, '$1').replace(/\n+$/, '')
    const rule = `/*\n  ${header.name}: ${header.value}\n`
    return kept ? `${kept}\n\n${rule}` : rule
}

module.exports = { buildIntegrityPolicyHeader, normalizeIntegrityPolicy, mergeHeadersFile }
