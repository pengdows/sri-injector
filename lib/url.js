const path = require('path')

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
 * Maps a URL as written in an HTML asset to a posix path relative to the output root, or null if
 * it would leave the output root. Under the public base (a path like "/app/" or a CDN URL) the
 * remainder is the path; other root-relative URLs map to the output root and relative URLs resolve
 * from the HTML file's directory. Checked on a segment boundary so a file literally named
 * "..foo.js" is not mistaken for traversal.
 */
function outputPathFor(url, prefix, htmlDir) {
    let p = relativeToBase(url, prefix)
    if (p === null) {
        p = toFilePath(url)
        p = p.startsWith('/') ? p.replace(/^\/+/, '') : path.posix.join(htmlDir, p)
    }
    p = path.posix.normalize(p)
    if (p === '..' || p.startsWith('..' + path.posix.sep)) return null
    return p
}

/**
 * Resolves `url` the way a browser does on a page with `<base href="baseHref">`: relative URLs are
 * relative to the base's directory. Root-relative and absolute URLs are returned unchanged. The result
 * is root-relative for a root-relative base, a full URL for an absolute base, and otherwise relative to
 * the HTML file (where the caller resolves it).
 */
function resolveAgainstBase(url, baseHref) {
    if (baseHref === undefined || url.startsWith('/') || isExternal(url)) return url
    const clean = baseHref.trim().split('#')[0].split('?')[0]
    const dir = clean.slice(0, clean.lastIndexOf('/') + 1)
    if (clean.startsWith('/') && !clean.startsWith('//')) {
        const u = new URL(url, 'http://base.invalid' + dir)
        return u.pathname + u.search + u.hash
    }
    if (isExternal(clean)) return new URL(url, clean.startsWith('//') ? 'https:' + dir : dir).href
    return dir + url
}

module.exports = { resolveAgainstBase, isExternal, toFilePath, normalizeBase, isLocalUrl, relativeToBase, isInsideDir, outputPathFor }
