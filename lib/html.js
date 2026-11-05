const { HtmlDocument } = require('./html-document')
const { isLocalUrl, resolveAgainstBase } = require('./url')
const { SkipResource } = require('./errors')
const { error, warning, CODES } = require('./diagnostics')
const { validateAlgorithm, calculateBase64Hash, verifyIntegrity } = require('./integrity')
const { validateCrossorigin } = require('./options')
const { applyImportMapIntegrity } = require('./importmap')

// Link relationships that take an integrity attribute (HTML spec: stylesheet, preload, modulepreload).
// A preload is included only for the destinations where integrity is enforced and where the consumer
// can carry the same value: script and style. The consumers of the others (CSS @font-face, <img>,
// fetch()) carry none, and a preload is reused only if the consuming request matches, so a hash there
// would only make the browser download the file twice.
const LINK_RELS = new Set(['stylesheet', 'modulepreload'])
const PRELOAD_DESTINATIONS = new Set(['script', 'style'])

/**
 * HTML `rel` is a case-insensitive set of ASCII-whitespace-separated tokens,
 * so `rel="Stylesheet alternate"` is a stylesheet.
 */
function relTokens(rel) {
    return new Set((rel || '').toLowerCase().split(/[ \t\n\f\r]+/).filter(Boolean))
}

function linkCarriesSri(tag) {
    const rel = relTokens(tag.attr('rel'))
    for (const t of LINK_RELS) if (rel.has(t)) return true
    return rel.has('preload') && PRELOAD_DESTINATIONS.has((tag.attr('as') || '').trim().toLowerCase())
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
    const doc = new HtmlDocument(html)
    const tags = doc.elements()
    const diagnostics = []

    // Browsers resolve relative URLs against the first <base href>, so that is the file to hash.
    const baseTag = tags.find(t => t.name === 'base' && t.attr('href') !== undefined)
    const baseHref = baseTag ? baseTag.attr('href') : undefined

    const scriptUrls = []
    for (const { tag, attribute } of collectTargets(tags)) {
        const written = tag.attr(attribute)
        if (!written) continue
        const url = resolveAgainstBase(written, baseHref)
        const local = isLocalUrl(url, base)
        if (local && (tag.name === 'script' || relTokens(tag.attr('rel')).has('modulepreload'))) {
            scriptUrls.push(url)
        }
        if (tag.attr('skip-sri') !== undefined) {
            tag.remove('skip-sri')
            continue
        }
        if (!local && !resolveExternal) continue

        await protectTag(tag, url, local ? resolveAsset : resolveExternal, { algo, crossorigin: crossoriginValue, diagnostics })
    }

    if (importMapIntegrity) {
        const entries = await importMapIntegrity(scriptUrls)
        if (entries && Object.keys(entries).length > 0) {
            const problems = []
            applyImportMapIntegrity(doc, entries, problems)
            problems.forEach(m => diagnostics.push(error(CODES.IMPORT_MAP_INVALID, m)))
        }
    }

    return {
        html: doc.modified ? doc.toString() : html,
        modified: doc.modified,
        diagnostics,
        errors: diagnostics.filter(d => d.severity === 'error').map(d => d.message),
        warnings: diagnostics.filter(d => d.severity === 'warning').map(d => d.message),
        unprotectedScripts: findUnprotectedScripts(tags)
    }
}

// Each element is visited once even if it matches several rules (e.g. rel="stylesheet preload")
function collectTargets(tags) {
    const targets = []
    for (const tag of tags) {
        if (tag.name === 'script' && tag.attr('src') !== undefined) targets.push({ tag, attribute: 'src' })
        else if (tag.name === 'link' && tag.attr('href') !== undefined && linkCarriesSri(tag)) targets.push({ tag, attribute: 'href' })
    }
    return targets
}

/**
 * Resolves one tag's resource and sets integrity (and crossorigin) on it. Problems are pushed to
 * `diagnostics`.
 */
async function protectTag(tag, url, resolve, { algo, crossorigin, diagnostics }) {
    try {
        const content = await resolve(url)
        if (content === null || content === undefined) {
            diagnostics.push(error(CODES.RESOURCE_NOT_FOUND, `The linked resource "${url}" could not be found.`, { url }))
            return
        }
        // An existing value is verified against the real bytes and kept if it holds up;
        // otherwise (stale, malformed, unsupported algorithm) it is regenerated and reported.
        const existing = tag.attr('integrity')
        if (!verifyIntegrity(existing, content)) {
            if (existing && existing.trim() !== '') {
                diagnostics.push(warning(CODES.INTEGRITY_REPLACED, `Replaced integrity on "${url}": existing value "${existing}" did not match the resource.`, { url }))
            }
            tag.set('integrity', `${algo}-${calculateBase64Hash(content, algo)}`)
        }
        // Keep an existing crossorigin (e.g. use-credentials)
        if (tag.attr('crossorigin') === undefined) {
            tag.set('crossorigin', crossorigin)
        }
    } catch (err) {
        if (err instanceof SkipResource) {
            diagnostics.push(warning(CODES.RESOURCE_SKIPPED, `Skipped resource "${url}": ${err.message}`, { url }))
        } else {
            diagnostics.push(error(CODES.RESOURCE_FAILED, `Could not process resource "${url}": ${err.message}`, { url }))
        }
    }
}

/** The src of every <script src> that still has no integrity. */
function findUnprotectedScripts(tags) {
    return tags
        .filter(t => t.name === 'script' && t.attr('src'))
        .filter(t => !(t.attr('integrity') || '').trim())
        .map(t => t.attr('src'))
}

module.exports = { injectSri }
