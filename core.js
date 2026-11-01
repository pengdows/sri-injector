const crypto = require('crypto')
const cheerio = require('cheerio')
const HashAlgos = require('./HashAlgo')

const TAGS = [
    { tag: 'script', attribute: 'src' },
    { tag: 'link[rel="stylesheet"]', attribute: 'href' },
    { tag: 'link[rel="preload"][as="script"]', attribute: 'href' },
    { tag: 'link[rel="preload"][as="style"]', attribute: 'href' },
    { tag: 'link[rel="modulepreload"]', attribute: 'href' }
]

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

function validateAlgorithm(name) {
    const selected = HashAlgos[name]
    if (!selected) {
        throw new Error(`Unsupported hash algorithm "${name}". Use one of: ${Object.keys(HashAlgos).join(', ')}`)
    }
    return selected
}

function calculateBase64Hash(content, algorithm) {
    return crypto.createHash(algorithm).update(content).digest('base64')
}

/**
 * Pure core: adds integrity (and crossorigin) to local script/link tags in an HTML string.
 *
 * @param {string} html
 * @param {(url: string) => Promise<Buffer|string|Uint8Array|null>|Buffer|string|Uint8Array|null} resolveAsset
 *        Returns the exact bytes served for a URL as written in the HTML, null if it does not
 *        exist, or throws to report a problem. It is never called for external URLs.
 * @param {{algorithm?: string}} [options]
 * @returns {Promise<{html: string, modified: boolean, errors: string[]}>}
 */
async function injectSri(html, resolveAsset, { algorithm = 'sha384' } = {}) {
    const algo = validateAlgorithm(algorithm)
    const errors = []
    // Parse as HTML (not XML) so empty elements serialize as <script ...></script>
    const isDocument = /<!doctype|<html[\s>]/i.test(html)
    const $ = cheerio.load(html, undefined, isDocument)
    let modified = false

    for (const { tag, attribute } of TAGS) {
        for (const el of $(tag).toArray()) {
            const $el = $(el)
            const url = $el.attr(attribute)
            // Skip external resources; existing integrity values are recomputed
            if (!url || isExternal(url)) continue

            try {
                const content = await resolveAsset(url)
                if (content === null || content === undefined) {
                    errors.push(`The linked resource "${url}" could not be found.`)
                    continue
                }
                $el.attr('integrity', `${algo}-${calculateBase64Hash(content, algo)}`)
                // Keep an existing crossorigin (e.g. use-credentials)
                if ($el.attr('crossorigin') === undefined) {
                    $el.attr('crossorigin', 'anonymous')
                }
                modified = true
            } catch (err) {
                errors.push(`Could not process resource "${url}": ${err.message}`)
            }
        }
    }

    return { html: modified ? $.html() : html, modified, errors }
}

module.exports = { injectSri, isExternal, toFilePath, validateAlgorithm, calculateBase64Hash }
