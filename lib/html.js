const { HtmlDocument } = require('./html-document')
const { isLocalUrl, resolveAgainstBase, normalizeUrl } = require('./url')
const { SkipResource } = require('./errors')
const { error, warning, integrityReplacedMessage, CODES } = require('./diagnostics')
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

// <script type> values that make a script execute: absent or empty, "module", or a JavaScript MIME
// type (parameters ignored). Anything else (application/ld+json, text/template, ...) is a data block
// the browser never fetches, so it is not a subresource.
const JS_MIME_TYPES = new Set([
    'application/ecmascript', 'application/javascript', 'application/x-ecmascript', 'application/x-javascript',
    'text/ecmascript', 'text/javascript', 'text/javascript1.0', 'text/javascript1.1', 'text/javascript1.2',
    'text/javascript1.3', 'text/javascript1.4', 'text/javascript1.5', 'text/jscript', 'text/livescript',
    'text/x-ecmascript', 'text/x-javascript'
])

function scriptExecutes(tag) {
    const type = (tag.attr('type') || '').split(';')[0].trim().toLowerCase()
    return type === '' || type === 'module' || JS_MIME_TYPES.has(type)
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
 * A tag carrying `data-skip-sri` ("do not add SRI to this tag", e.g. a script the server generates) gets
 * no integrity, and the marker is removed from the page, which is final output. (A dry run or --check
 * writes nothing, so there the marker stays.)
 *
 * @returns {Promise<{html: string, modified: boolean, changes: {kind: string, url?: string}[], diagnostics: object[], errors: string[], warnings: string[], unprotectedScripts: string[]}>}
 *          `changes` lists the SRI edits made to the page, one entry per attribute or import map
 *          (kinds: add-integrity, replace-integrity, add-crossorigin, update-import-map); this is what
 *          a dry run reports. Removing a data-skip-sri marker is not listed. `diagnostics` is the structured form (see ./diagnostics); `errors` and
 *          `warnings` are the same problems as plain messages. `unprotectedScripts` lists the src of
 *          every <script> that still has no integrity (an Integrity-Policy header would block them).
 */
async function injectSri(html, resolveAsset, { algorithm = 'sha384', crossorigin, base, resolveExternal, importMapIntegrity } = {}) {
    const algo = validateAlgorithm(algorithm)
    const crossoriginValue = validateCrossorigin(crossorigin)
    const doc = new HtmlDocument(html)
    const tags = doc.elements()
    const diagnostics = []
    const changes = []

    // Browsers resolve relative URLs against the first <base href>, so that is the file to hash.
    const baseTag = tags.find(t => t.name === 'base' && t.attr('href') !== undefined)
    const baseHref = baseTag ? baseTag.attr('href') : undefined

    const scriptUrls = []
    for (const { tag, attribute } of collectTargets(tags)) {
        const written = tag.attr(attribute)
        if (!written || !normalizeUrl(written)) continue
        const url = resolveAgainstBase(normalizeUrl(written), baseHref)
        const local = isLocalUrl(url, base)
        if (local && (tag.name === 'script' || relTokens(tag.attr('rel')).has('modulepreload'))) {
            scriptUrls.push(url)
        }
        if (tag.attr(SKIP_SRI) !== undefined) {
            tag.remove(SKIP_SRI)
            continue
        }
        if (!local && !resolveExternal) continue

        await protectTag(tag, url, local ? resolveAsset : resolveExternal, {
            local, algo, crossorigin: crossoriginValue, diagnostics, changes })
    }

    if (importMapIntegrity) {
        const entries = await importMapIntegrity(scriptUrls)
        if (entries && Object.keys(entries).length > 0) {
            const problems = []
            if (applyImportMapIntegrity(doc, entries, problems)) changes.push({ kind: 'update-import-map' })
            problems.forEach(m => diagnostics.push(error(CODES.IMPORT_MAP_INVALID, m)))
        }
    }

    return {
        html: doc.modified ? doc.toString() : html,
        modified: doc.modified,
        changes,
        diagnostics,
        errors: diagnostics.filter(d => d.severity === 'error').map(d => d.message),
        warnings: diagnostics.filter(d => d.severity === 'warning').map(d => d.message),
        unprotectedScripts: findUnprotectedScripts(tags)
    }
}

/** The one opt-out marker: "do not add SRI to this tag". */
const SKIP_SRI = 'data-skip-sri'

// The tags that carry integrity. Shared with --check (./check), which must examine exactly these.
// Each element is visited once even if it matches several rules (e.g. rel="stylesheet preload")
function collectTargets(tags) {
    const targets = []
    for (const tag of tags) {
        if (tag.name === 'script' && tag.attr('src') !== undefined && scriptExecutes(tag)) targets.push({ tag, attribute: 'src' })
        else if (tag.name === 'link' && tag.attr('href') !== undefined && linkCarriesSri(tag)) targets.push({ tag, attribute: 'href' })
    }
    return targets
}

/**
 * Resolves one tag's resource and sets integrity (and crossorigin) on it. Problems are pushed to
 * `diagnostics`, edits to `changes`.
 */
async function protectTag(tag, url, resolve, { local, algo, crossorigin, diagnostics, changes }) {
    // Credentialed CORS rejects "Access-Control-Allow-Origin: *" and needs Allow-Credentials, and the
    // page's real origin is unknown at build time, so a third-party resource cannot be verified for it.
    const written = tag.attr('crossorigin')
    if (!local && (written === undefined ? crossorigin : written.trim().toLowerCase()) === 'use-credentials') {
        diagnostics.push(warning(CODES.RESOURCE_SKIPPED, `Skipped resource "${url}": third-party resources loaded with crossorigin="use-credentials" cannot be verified at build time (credentialed CORS needs the page's real origin); tag left unchanged.`, { url }))
        return
    }
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
            const stale = existing !== undefined && existing.trim() !== ''
            if (stale) {
                diagnostics.push(warning(CODES.INTEGRITY_REPLACED, integrityReplacedMessage(url, existing), { url, existing }))
            }
            tag.set('integrity', `${algo}-${calculateBase64Hash(content, algo)}`)
            changes.push({ kind: stale ? 'replace-integrity' : 'add-integrity', url })
        }
        // Keep an existing crossorigin (e.g. use-credentials)
        if (tag.attr('crossorigin') === undefined) {
            tag.set('crossorigin', crossorigin)
            changes.push({ kind: 'add-crossorigin', url })
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
        .filter(t => t.name === 'script' && normalizeUrl(t.attr('src') || '') && scriptExecutes(t))
        .filter(t => !(t.attr('integrity') || '').trim())
        .map(t => t.attr('src'))
}

module.exports = { injectSri, collectTargets, SKIP_SRI }
