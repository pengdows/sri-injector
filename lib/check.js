const { HtmlDocument } = require('./html-document')
const { collectTargets, SKIP_SRI } = require('./html')
const { isLocalUrl, resolveAgainstBase, normalizeUrl } = require('./url')
const { SkipResource } = require('./errors')
const { parseIntegrity, verifyIntegrity, calculateBase64Hash } = require('./integrity')

/**
 * Every result a check can give, in report order. The first four fail the check.
 *  - missing:   no integrity attribute (or an empty one)
 *  - wrong:     integrity present but malformed, or a token does not match the bytes
 *  - not-found: the resource could not be obtained (not in the output, unreadable, fetch failed)
 *  - blocked:   with an Integrity-Policy, a <script> left without integrity, which the header would block
 *  - ok:        integrity present and every token matches the bytes (any supported algorithm)
 *  - skipped:   the tag carries data-skip-sri ("do not add SRI to this tag")
 *  - unchecked: third-party and not verified (no --external, or the server sends no CORS header)
 */
const STATUSES = ['missing', 'wrong', 'not-found', 'blocked', 'ok', 'skipped', 'unchecked']
const FAILING = new Set(['missing', 'wrong', 'not-found', 'blocked'])

/**
 * Validates the integrity metadata already in one HTML page, without changing it. Examines exactly
 * the tags a real run protects, resolved the same way (<base href>, `base`, local vs third-party), plus
 * the entries of an import map "integrity" section (Vite/Rollup/Rolldown lazy chunks).
 *
 * @param {string} html
 * @param {Function} resolveAsset  as for injectSri: the served bytes for a local URL, null, or throws
 * @param {{base?: string, resolveExternal?: Function, policy?: object|null}} [options]
 *        Without `resolveExternal`, third-party resources are listed as unchecked. With `policy`, a
 *        <script> that has no integrity fails as blocked even when skipped or third-party, as in a real run.
 * @returns {Promise<{results: {target: 'tag'|'import-map', url: string, status: string, hasIntegrity: boolean, message?: string}[], problems: string[]}>}
 *          `problems` are page-level failures (an import map that is not valid JSON).
 */
async function checkPage(html, resolveAsset, { base, resolveExternal, policy } = {}) {
    const doc = new HtmlDocument(html)
    const tags = doc.elements()
    const baseTag = tags.find(t => t.name === 'base' && t.attr('href') !== undefined)
    const baseHref = baseTag ? baseTag.attr('href') : undefined
    const results = []
    const problems = []

    const examine = async (target, url, integrity, { skipped = false, isScript = false, credentialed = false } = {}) => {
        const hasIntegrity = !!(integrity && integrity.trim())
        const result = (status, message) => {
            // The header blocks any script request without integrity metadata, whatever the reason.
            if (policy && isScript && !hasIntegrity && (status === 'skipped' || status === 'unchecked')) {
                return { target, url, status: 'blocked', hasIntegrity, message: 'no integrity; the Integrity-Policy header would block it' }
            }
            return { target, url, status, hasIntegrity, ...(message ? { message } : {}) }
        }
        if (skipped) return result('skipped', SKIP_SRI)
        const local = isLocalUrl(url, base)
        if (!local && !resolveExternal) return result('unchecked', 'third-party; pass --external to verify it')
        // A real run leaves these alone: credentialed CORS cannot be verified at build time.
        if (!local && credentialed) return result('unchecked', 'third-party with crossorigin="use-credentials"; cannot be verified at build time')

        let content
        try {
            content = await (local ? resolveAsset : resolveExternal)(url)
        } catch (err) {
            if (err instanceof SkipResource) return result('unchecked', err.message)
            return result('not-found', err.message)
        }
        if (content === null || content === undefined) return result('not-found', 'the resource could not be found')
        if (!hasIntegrity) return result('missing', 'no integrity attribute')
        if (verifyIntegrity(integrity, content)) return result('ok')
        const parsed = parseIntegrity(integrity)
        if (!parsed) return result('wrong', `malformed or unsupported integrity value "${integrity}"`)
        const algorithm = parsed[0].algorithm
        return result('wrong', `integrity "${integrity}" does not match the resource, which hashes to ${algorithm}-${calculateBase64Hash(content, algorithm)}`)
    }

    for (const { tag, attribute } of collectTargets(tags)) {
        const written = tag.attr(attribute)
        if (!written || !normalizeUrl(written)) continue
        results.push(await examine('tag', resolveAgainstBase(normalizeUrl(written), baseHref), tag.attr('integrity'), {
            skipped: tag.attr(SKIP_SRI) !== undefined,
            isScript: tag.name === 'script',
            credentialed: (tag.attr('crossorigin') || '').trim().toLowerCase() === 'use-credentials'
        }))
    }

    const importMap = tags.find(t => t.name === 'script' && (t.attr('type') || '').toLowerCase() === 'importmap')
    const inner = importMap && importMap.innerRange()
    if (inner) {
        let map
        try {
            map = JSON.parse(html.slice(inner.start, inner.end).trim() || '{}')
        } catch (err) {
            problems.push(`Import map is not valid JSON, so its integrity entries could not be checked: ${err.message}`)
        }
        const entries = map && map.integrity && typeof map.integrity === 'object' ? Object.entries(map.integrity) : []
        for (const [key, value] of entries) {
            results.push(await examine('import-map', resolveAgainstBase(key, baseHref), typeof value === 'string' ? value : ''))
        }
    }

    return { results, problems }
}

module.exports = { checkPage, STATUSES, FAILING }
