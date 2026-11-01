const crypto = require('crypto')
const path = require('path')
const cheerio = require('cheerio')
const HashAlgos = require('./HashAlgo')

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
 * True for URLs with a scheme (https:, data:, ...) or protocol-relative (//host/...).
 */
function isExternal(url) {
    return /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(url)
}

/**
 * Strips query string and fragment and URL-decodes, yielding a filesystem-style path.
 */
function toFilePath(url) {
    const clean = url.split('#')[0].split('?')[0]
    try {
        return decodeURIComponent(clean)
    } catch {
        return clean
    }
}

/**
 * Normalizes a public base path/URL to end with '/', so prefix matches land on a path boundary
 * ("https://cdn.example.com/" cannot match "https://cdn.example.com.evil.io/x.js").
 */
function normalizeBase(base) {
    if (!base) return '/'
    return base.endsWith('/') ? base : base + '/'
}

/**
 * True for URLs this build owns. Relative and root-relative URLs are local; so are URLs under an
 * absolute-URL base (a Vite/Rollup build deployed to a CDN writes "https://cdn.example.com/assets/x.js"
 * for its own assets, which must not be mistaken for third-party externals).
 */
function isLocalUrl(url, base) {
    const b = normalizeBase(base)
    if (isExternal(b) && url.startsWith(b)) return true
    return !isExternal(url)
}

/**
 * If `url` lies under an absolute `base` (a root path like "/app/" or a full URL), returns its path
 * relative to that base with query/fragment removed and percent-decoded; otherwise null.
 * Relative bases ("./") never strip: their URLs are relative to the HTML file, not the root.
 */
function relativeToBase(url, base) {
    const b = normalizeBase(base)
    const absolute = b.startsWith('/') || isExternal(b)
    if (!absolute || !url.startsWith(b)) return null
    if (isExternal(url) && !isExternal(b)) return null // "//host/x.js" is not under base "/"
    return toFilePath(url.slice(b.length)).replace(/^\/+/, '')
}

/**
 * True when `target` is strictly inside `root` (not root itself, not a parent, not outside).
 * Compares on segment boundaries so a file literally named "..foo.js" is not mistaken
 * for a traversal.
 */
function isInsideDir(root, target) {
    const rel = path.relative(root, target)
    return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)
}

/**
 * Thrown by a resolver to say "this resource cannot be given integrity, but that is not a failure"
 * (e.g. a third-party server without CORS headers). Recorded as a warning; the tag is left untouched.
 */
class SkipResource extends Error {
    constructor(reason) {
        super(reason)
        this.name = 'SkipResource'
    }
}

function validateAlgorithm(name) {
    const selected = HashAlgos[name]
    if (!selected) {
        throw new Error(`Unsupported hash algorithm "${name}". Use one of: ${Object.keys(HashAlgos).join(', ')}`)
    }
    return selected
}

const CROSSORIGIN_VALUES = ['anonymous', 'use-credentials']

function validateCrossorigin(value) {
    if (value === undefined) return 'anonymous'
    if (!CROSSORIGIN_VALUES.includes(value)) {
        throw new Error(`Invalid crossorigin value ${JSON.stringify(value)}. Use one of: ${CROSSORIGIN_VALUES.join(', ')}`)
    }
    return value
}

function calculateBase64Hash(content, algorithm) {
    return crypto.createHash(algorithm).update(content).digest('base64')
}

/**
 * Parses an SRI attribute value ("sha384-abc sha512-def?opt") into [{ algorithm, digest }].
 * Returns [] for an empty value and null if any token is malformed or uses an unsupported algorithm.
 */
function parseIntegrity(value) {
    const tokens = (value || '').trim().split(/\s+/).filter(Boolean)
    const parsed = []
    for (const token of tokens) {
        const m = /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})(\?.*)?$/.exec(token)
        if (!m) return null
        parsed.push({ algorithm: m[1], digest: m[2] })
    }
    return parsed
}

/**
 * True when `value` is a non-empty SRI attribute whose every token matches `content`.
 * Stricter than browsers (which only consult the strongest algorithm present): a stale token
 * anywhere means the attribute is wrong and should be regenerated.
 */
function verifyIntegrity(value, content) {
    const parsed = parseIntegrity(value)
    if (!parsed || parsed.length === 0) return false
    return parsed.every(({ algorithm, digest }) => calculateBase64Hash(content, algorithm) === digest)
}

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

/**
 * Merges `entries` ({ url: integrity }) into the page's import map "integrity" section, creating
 * the map if needed. Browsers apply these hashes to module fetches that carry no integrity of
 * their own (dynamic import(), static imports between chunks, modulepreload), which is the only
 * way to cover code-split chunks that never appear in the HTML.
 *
 * The map must come before the first module script or modulepreload, and most browsers allow only
 * one import map per page, so an existing one is merged into rather than duplicated.
 * Returns true if the document changed.
 */
function applyImportMapIntegrity($, entries, errors) {
    const existing = $('script[type="importmap"]').first()
    let map = {}
    if (existing.length) {
        try {
            map = JSON.parse(existing.html() || '{}')
        } catch (err) {
            errors.push(`Existing import map is not valid JSON, so chunk integrity could not be added: ${err.message}`)
            return false
        }
    }
    const before = JSON.stringify(map)
    map.integrity = { ...(map.integrity || {}), ...entries }
    const after = JSON.stringify(map)
    if (after === before) return false

    if (existing.length) {
        existing.text(after)
        return true
    }
    const tag = `<script type="importmap">${after}</script>`
    const firstModule = $('script[type="module"], link[rel~="modulepreload" i]').first()
    if (firstModule.length) firstModule.before(tag)
    else if ($('head').length) $('head').append(tag)
    else $.root().prepend(tag)
    return true
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
 * @returns {Promise<{html: string, modified: boolean, errors: string[], warnings: string[], unprotectedScripts: string[]}>}
 *          `errors` are resources that could not be protected; `warnings` are existing integrity
 *          values that did not match the resource and were replaced; `unprotectedScripts` lists the
 *          src of every <script> that still has no integrity (an Integrity-Policy header would block them).
 */
async function injectSri(html, resolveAsset, { algorithm = 'sha384', crossorigin, base, resolveExternal, importMapIntegrity } = {}) {
    const algo = validateAlgorithm(algorithm)
    const crossoriginValue = validateCrossorigin(crossorigin)
    const errors = []
    const warnings = []
    // Parse as HTML (not XML) so empty elements serialize as <script ...></script>
    const isDocument = /<!doctype|<html[\s>]/i.test(html)
    const $ = cheerio.load(html, undefined, isDocument)
    let modified = false

    // Each element is visited once even if it matches several rules (e.g. rel="stylesheet preload")
    const targets = [
        ...$('script[src]').toArray().map(el => ({ el, attribute: 'src' })),
        ...$('link[href]').toArray().filter(el => linkCarriesSri($(el))).map(el => ({ el, attribute: 'href' }))
    ]
    const scriptUrls = []

    for (const { el, attribute } of targets) {
        const $el = $(el)
        const url = $el.attr(attribute)
        if (!url) continue
        const local = isLocalUrl(url, base)
        if (local && (el.tagName === 'script' || relTokens($el.attr('rel')).has('modulepreload'))) {
            scriptUrls.push(url)
        }
        if (!local && !resolveExternal) continue

        try {
            const content = await (local ? resolveAsset(url) : resolveExternal(url))
            if (content === null || content === undefined) {
                errors.push(`The linked resource "${url}" could not be found.`)
                continue
            }
            let changed = false
            // An existing value is verified against the real bytes and kept if it holds up;
            // otherwise (stale, malformed, unsupported algorithm) it is regenerated and reported.
            const existing = $el.attr('integrity')
            if (!verifyIntegrity(existing, content)) {
                if (existing && existing.trim() !== '') {
                    warnings.push(`Replaced integrity on "${url}": existing value "${existing}" did not match the resource.`)
                }
                $el.attr('integrity', `${algo}-${calculateBase64Hash(content, algo)}`)
                changed = true
            }
            // Keep an existing crossorigin (e.g. use-credentials)
            if ($el.attr('crossorigin') === undefined) {
                $el.attr('crossorigin', crossoriginValue)
                changed = true
            }
            if (changed) modified = true
        } catch (err) {
            if (err instanceof SkipResource) {
                warnings.push(`Skipped resource "${url}": ${err.message}`)
            } else {
                errors.push(`Could not process resource "${url}": ${err.message}`)
            }
        }
    }

    if (importMapIntegrity) {
        const entries = await importMapIntegrity(scriptUrls)
        if (entries && Object.keys(entries).length > 0) {
            if (applyImportMapIntegrity($, entries, errors)) modified = true
        }
    }

    const unprotectedScripts = $('script[src]').toArray()
        .map(el => $(el))
        .filter($el => $el.attr('src') && !($el.attr('integrity') || '').trim())
        .map($el => $el.attr('src'))

    return { html: modified ? $.html() : html, modified, errors, warnings, unprotectedScripts }
}

module.exports = { injectSri, SkipResource, buildIntegrityPolicyHeader, normalizeIntegrityPolicy, mergeHeadersFile, isExternal, isLocalUrl, normalizeBase, relativeToBase, toFilePath, isInsideDir, validateAlgorithm, validateCrossorigin, calculateBase64Hash, parseIntegrity, verifyIntegrity }
