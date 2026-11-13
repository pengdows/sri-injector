const { HtmlDocument } = require('./html-document')

/**
 * Merges `entries` ({ url: integrity }) into the page's import map "integrity" section, creating
 * the map if needed. Browsers apply these hashes to module fetches that carry no integrity of
 * their own (dynamic import(), static imports between chunks, modulepreload), which is the only
 * way to cover code-split chunks that never appear in the HTML.
 *
 * The map must come before the first module script or modulepreload, and most browsers allow only
 * one import map per page, so an existing one is merged into rather than duplicated. Only the map's
 * own text (or a new tag) is edited.
 * Returns true if the document changed.
 */
function applyImportMapIntegrity(doc, entries, errors) {
    const tags = doc.elements()
    const existing = tags.find(t => t.name === 'script' && (t.attr('type') || '').toLowerCase() === 'importmap')
    let map = {}
    let inner = null
    if (existing) {
        inner = existing.innerRange()
        try {
            if (!inner) throw new Error('the <script> element is never closed')
            map = JSON.parse(doc.html.slice(inner.start, inner.end).trim() || '{}')
        } catch (err) {
            errors.push(`Existing import map is not valid JSON, so chunk integrity could not be added: ${err.message}`)
            return false
        }
    }
    const before = JSON.stringify(map)
    map.integrity = { ...(map.integrity || {}), ...entries }
    const after = JSON.stringify(map)
    if (after === before) return false

    if (existing) {
        doc.edit(inner.start, inner.end, after)
        return true
    }
    const tag = `<script type="importmap">${after}</script>`
    const firstModule = tags.find(t =>
        (t.name === 'script' && (t.attr('type') || '').toLowerCase() === 'module') ||
        (t.name === 'link' && /(^|[ \t\n\f\r])modulepreload($|[ \t\n\f\r])/i.test(t.attr('rel') || '')))
    const at = firstModule ? firstModule.startOffset : doc.headEndOffset()
    doc.edit(at, at, tag)
    return true
}

/** The keys of the page's import map "integrity" section, as written; [] if there is none or it is invalid. */
function importMapIntegrityKeys(html) {
    const doc = new HtmlDocument(html)
    const map = doc.elements().find(t => t.name === 'script' && (t.attr('type') || '').toLowerCase() === 'importmap')
    const inner = map && map.innerRange()
    if (!inner) return []
    try {
        const parsed = JSON.parse(html.slice(inner.start, inner.end).trim() || '{}')
        return parsed.integrity && typeof parsed.integrity === 'object' ? Object.keys(parsed.integrity) : []
    } catch {
        return []
    }
}

module.exports = { applyImportMapIntegrity, importMapIntegrityKeys }
