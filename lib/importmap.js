
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

module.exports = { applyImportMapIntegrity }
