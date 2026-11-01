const cheerio = require('cheerio')
const { isLocalUrl } = require('./url')
const { SkipResource } = require('./errors')
const { error, warning, CODES } = require('./diagnostics')
const { validateAlgorithm, calculateBase64Hash, verifyIntegrity } = require('./integrity')
const { validateCrossorigin } = require('./options')
const { applyImportMapIntegrity } = require('./importmap')

// Link relationships that take an integrity attribute (HTML spec: stylesheet, preload, modulepreload).
// All `rel=preload` destinations are included; note that browsers currently enforce integrity on
// preloads only for script and style, and a preload is reused only if the consuming request
// carries the same integrity/crossorigin (see README).
const LINK_RELS = new Set(['stylesheet', 'preload', 'modulepreload'])

/**
 * HTML `rel` is a case-insensitive set of ASCII-whitespace-separated tokens,
 * so `rel="Stylesheet alternate"` is a stylesheet.
 */
function relTokens(rel) {
    return new Set((rel || '').toLowerCase().split(/[ \t\n\f\r]+/).filter(Boolean))
}

function linkCarriesSri($el) {
    const rel = relTokens($el.attr('rel'))
    for (const t of LINK_RELS) if (rel.has(t)) return true
    return false
}

/**
 * Pure core: adds integrity (and crossorigin) to local script/link tags in an HTML string.
 *
 * @param {string} html
 * @param {(url: string) => Promise<Buffer|string|Uint8Array|null>|Buffer|string|Uint8Array|null} resolveAsset
 *        Returns the exact bytes served for a URL as written in the HTML, null if it does not
 *        exist, or throws to report a problem. It is never called for external URLs.
 * @param {{algorithm?: string, crossorigin?: 'anonymous'|'use-credentials', base?: string, resolveExternal?: (url: string) => Promise<Buffer|string|Uint8Array|null>|Buffer|string|Uint8Array|null}} [options]
 *        `base` is the public base path or URL the HTML was built for. When it is an absolute URL,
 *        assets under it are treated as local rather than external.
 *        `resolveExternal`, when given, is called for external URLs (https://..., //host/...) with the
 *        same contract as resolveAsset; it may also throw SkipResource to leave a tag untouched with a
 *        warning. Without it, external URLs are skipped.
 *        `importMapIntegrity(scriptUrls)`, when given, receives the page's local script and modulepreload
 *        URLs and returns { url: integrity } entries for every module reachable from them (code-split
 *        chunks), or null. Entries are merged into the page's import map "integrity" section.
 *
 * A tag carrying the `skip-sri` attribute is left alone (the marker attribute is removed): use it for
 * local files the build does not own, such as a script the server generates.
 *
 * @returns {Promise<{html: string, modified: boolean, diagnostics: object[], errors: string[], warnings: string[], unprotectedScripts: string[]}>}
 *          `diagnostics` is the structured form (see ./diagnostics); `errors` and `warnings` are the same
 *          problems as plain messages. `unprotectedScripts` lists the src of every <script> that still
 *          has no integrity (an Integrity-Policy header would block them).
 */
async function injectSri(html, resolveAsset, { algorithm = 'sha384', crossorigin, base, resolveExternal, importMapIntegrity } = {}) {
    const algo = validateAlgorithm(algorithm)
    const crossoriginValue = validateCrossorigin(crossorigin)
    // Parse as HTML (not XML) so empty elements serialize as <script ...></script>
    const isDocument = /<!doctype|<html[\s>]/i.test(html)
    const $ = cheerio.load(html, undefined, isDocument)
    const diagnostics = []
    let modified = false

    const scriptUrls = []
    for (const { el, attribute } of collectTargets($)) {
        const $el = $(el)
        const url = $el.attr(attribute)
        if (!url) continue
        const local = isLocalUrl(url, base)
        if (local && (el.tagName === 'script' || relTokens($el.attr('rel')).has('modulepreload'))) {
            scriptUrls.push(url)
        }
        if ($el.attr('skip-sri') !== undefined) {
            $el.removeAttr('skip-sri')
            modified = true
            continue
        }
        if (!local && !resolveExternal) continue

        if (await protectTag($el, url, local ? resolveAsset : resolveExternal, { algo, crossorigin: crossoriginValue, diagnostics })) {
            modified = true
        }
    }

    if (importMapIntegrity) {
        const entries = await importMapIntegrity(scriptUrls)
        if (entries && Object.keys(entries).length > 0) {
            const problems = []
            if (applyImportMapIntegrity($, entries, problems)) modified = true
            problems.forEach(m => diagnostics.push(error(CODES.IMPORT_MAP_INVALID, m)))
        }
    }

    return {
        html: modified ? $.html() : html,
        modified,
        diagnostics,
        errors: diagnostics.filter(d => d.severity === 'error').map(d => d.message),
        warnings: diagnostics.filter(d => d.severity === 'warning').map(d => d.message),
        unprotectedScripts: findUnprotectedScripts($)
    }
}

// Each element is visited once even if it matches several rules (e.g. rel="stylesheet preload")
function collectTargets($) {
    return [
        ...$('script[src]').toArray().map(el => ({ el, attribute: 'src' })),
        ...$('link[href]').toArray().filter(el => linkCarriesSri($(el))).map(el => ({ el, attribute: 'href' }))
    ]
}

/**
 * Resolves one tag's resource and sets integrity (and crossorigin) on it. Problems are pushed to
 * `diagnostics`; returns true if the tag changed.
 */
async function protectTag($el, url, resolve, { algo, crossorigin, diagnostics }) {
    try {
        const content = await resolve(url)
        if (content === null || content === undefined) {
            diagnostics.push(error(CODES.RESOURCE_NOT_FOUND, `The linked resource "${url}" could not be found.`, { url }))
            return false
        }
        let changed = false
        // An existing value is verified against the real bytes and kept if it holds up;
        // otherwise (stale, malformed, unsupported algorithm) it is regenerated and reported.
        const existing = $el.attr('integrity')
        if (!verifyIntegrity(existing, content)) {
            if (existing && existing.trim() !== '') {
                diagnostics.push(warning(CODES.INTEGRITY_REPLACED, `Replaced integrity on "${url}": existing value "${existing}" did not match the resource.`, { url }))
            }
            $el.attr('integrity', `${algo}-${calculateBase64Hash(content, algo)}`)
            changed = true
        }
        // Keep an existing crossorigin (e.g. use-credentials)
        if ($el.attr('crossorigin') === undefined) {
            $el.attr('crossorigin', crossorigin)
            changed = true
        }
        return changed
    } catch (err) {
        if (err instanceof SkipResource) {
            diagnostics.push(warning(CODES.RESOURCE_SKIPPED, `Skipped resource "${url}": ${err.message}`, { url }))
        } else {
            diagnostics.push(error(CODES.RESOURCE_FAILED, `Could not process resource "${url}": ${err.message}`, { url }))
        }
        return false
    }
}

/** The src of every <script src> that still has no integrity. */
function findUnprotectedScripts($) {
    return $('script[src]').toArray()
        .map(el => $(el))
        .filter($el => $el.attr('src') && !($el.attr('integrity') || '').trim())
        .map($el => $el.attr('src'))
}

module.exports = { injectSri }
