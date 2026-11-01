/**
 * Bundler asset sources are `string | Uint8Array`; String() on a Uint8Array yields "60,104,...".
 */
function sourceToString(source) {
    return typeof source === 'string' ? source : Buffer.from(source).toString('utf8')
}

module.exports = { sourceToString }
