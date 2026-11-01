const path = require('path')
const { injectSri, toFilePath } = require('../core')

/**
 * Rollup/Vite plugin: injects SRI into every .html asset in the output bundle.
 * Runs in generateBundle with order 'post', so hashes cover the final emitted bytes.
 * Place it after any plugin that emits or rewrites HTML or assets.
 *
 * Options:
 *  - algorithm: 'sha256' | 'sha384' (default) | 'sha512'
 *  - strict:    throw (fail the build) if a local resource cannot be resolved
 *  - base:      public base path; defaults to Vite's resolved `base`, else '/'
 *  - publicDir: extra dir checked for files not in the bundle (defaults to Vite's publicDir)
 */
function sriPlugin(options = {}) {
    const { algorithm = 'sha384', strict = false } = options
    let base = options.base
    let publicDir = options.publicDir

    return {
        name: 'sri-injector',
        enforce: 'post',
        configResolved(config) {
            if (base === undefined) base = config.base
            if (publicDir === undefined && config.publicDir) publicDir = config.publicDir
        },
        generateBundle: {
            order: 'post',
            async handler(_outputOptions, bundle) {
                const fs = require('fs')
                const prefix = (base ?? '/')
                const allErrors = []

                for (const [htmlName, item] of Object.entries(bundle)) {
                    if (item.type !== 'asset' || !htmlName.endsWith('.html')) continue
                    const html = String(item.source)
                    const htmlDir = path.posix.dirname(htmlName)

                    const resolveAsset = async (url) => {
                        let p = toFilePath(url)
                        if (p.startsWith('/')) {
                            // Strip the public base (e.g. /app/) when present, else just the leading slash
                            p = prefix !== '/' && p.startsWith(prefix) ? p.slice(prefix.length) : p.replace(/^\/+/, '')
                        } else {
                            p = path.posix.join(htmlDir, p)
                        }
                        p = path.posix.normalize(p)
                        if (p.startsWith('..')) throw new Error('potential path traversal, skipping')

                        const found = bundle[p]
                        if (found) return found.type === 'chunk' ? found.code : found.source
                        if (publicDir) {
                            const full = path.resolve(publicDir, p)
                            if (path.relative(publicDir, full).startsWith('..')) return null
                            try { return fs.readFileSync(full) } catch { return null }
                        }
                        return null
                    }

                    const { html: out, modified, errors } = await injectSri(html, resolveAsset, { algorithm })
                    errors.forEach(e => allErrors.push(`${htmlName}: ${e}`))
                    if (modified) item.source = out
                }

                if (allErrors.length) {
                    const msg = `sri-injector: ${allErrors.length} resource(s) could not be processed:\n  - ${allErrors.join('\n  - ')}`
                    if (strict) this.error(msg)
                    else allErrors.forEach(e => this.warn(`sri-injector: ${e}`))
                }
            }
        }
    }
}

module.exports = sriPlugin
module.exports.default = sriPlugin
