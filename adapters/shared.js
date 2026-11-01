const path = require('path')
const { toFilePath, relativeToBase } = require('../core')

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
 * Bundler asset sources are `string | Uint8Array`; String() on a Uint8Array yields "60,104,...".
 */
function sourceToString(source) {
    return typeof source === 'string' ? source : Buffer.from(source).toString('utf8')
}

module.exports = { outputPathFor, sourceToString }
