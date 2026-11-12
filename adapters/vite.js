const { resolveOptions } = require('../lib/options')
const { createBundlePlugin } = require('./rollup')

/**
 * Vite plugin: the generic Rollup plugin plus what only Vite provides.
 *  - `base` and `publicDir` come from Vite's resolved config unless set explicitly, so files in
 *    `public/` are hashed and a full-URL `base` (CDN deployment) is recognised.
 *  - runs last (`enforce: 'post'`).
 *  - with `integrityPolicy`, the header is set on `vite preview` (not the dev server, which serves
 *    unhashed source modules and would be blocked entirely).
 * Options are those of `@pengdows/sri-injector/rollup`.
 */
function sriVitePlugin(options = {}) {
    const config = resolveOptions(options)
    const env = {}
    const plugin = createBundlePlugin(config, () => env, { headerNote: ' (set on the Vite preview server automatically)' })

    return {
        ...plugin,
        enforce: 'post',
        config() {
            if (!config.policyHeader) return undefined
            return { preview: { headers: { [config.policyHeader.name]: config.policyHeader.value } } }
        },
        configResolved(resolved) {
            if (config.base === undefined) env.base = resolved.base
            if (config.publicDir === undefined && resolved.publicDir) env.publicDir = resolved.publicDir
        }
    }
}

module.exports = sriVitePlugin
module.exports.default = sriVitePlugin
