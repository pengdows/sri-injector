const path = require('path')
const { injectSri, normalizeBase, validateAlgorithm, validateCrossorigin, buildIntegrityPolicyHeader, normalizeIntegrityPolicy, mergeHeadersFile } = require('../core')
const { createExternalResolver } = require('../external')
const { outputPathFor, sourceToString } = require('./shared')

const PLUGIN_NAME = 'sri-injector'

/**
 * webpack plugin: injects SRI into every .html asset in the compilation (e.g. from
 * html-webpack-plugin). Runs in processAssets at PROCESS_ASSETS_STAGE_OPTIMIZE_TRANSFER, after
 * html-webpack-plugin emits the page (OPTIMIZE_INLINE) and after content hashing, so hashes cover
 * the final emitted bytes and plugin order in `plugins` does not matter.
 *
 * Options mirror the Rollup/Vite plugin where they apply:
 *  - enabled:   set to false to turn the plugin off. Default true.
 *  - algorithm: 'sha256' | 'sha384' (default) | 'sha512'
 *  - crossorigin: 'anonymous' (default) | 'use-credentials', written to tags that have none
 *  - strict:    fail the build (instead of warning) if a local resource cannot be resolved or there is no HTML
 *  - base:      public base path or URL; defaults to output.publicPath (when it is a string, not 'auto')
 *  - external / externalTimeout: also fetch and pin third-party resources
 *  - integrityPolicy: true | 'report-only' | { reportOnly, endpoints, headersFile }
 *
 * No import map: webpack's classic chunk loader creates <script> elements at runtime, which import
 * maps do not govern. Use webpack-subresource-integrity for lazy chunks.
 */
class SriWebpackPlugin {
    constructor(options = {}) {
        this.options = options
        this.algorithm = validateAlgorithm(options.algorithm || 'sha384')
        this.crossorigin = validateCrossorigin(options.crossorigin)
        this.policy = normalizeIntegrityPolicy(options.integrityPolicy)
        this.policyHeader = this.policy ? buildIntegrityPolicyHeader(this.policy) : null
    }

    apply(compiler) {
        const { webpack } = compiler
        const { RawSource } = webpack.sources
        const { strict = false, external = false, externalTimeout, enabled = true } = this.options
        if (!enabled) return

        compiler.hooks.thisCompilation.tap(PLUGIN_NAME, (compilation) => {
            compilation.hooks.processAssets.tapPromise(
                { name: PLUGIN_NAME, stage: webpack.Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_TRANSFER },
                async () => {
                    const fail = (msg) => compilation.errors.push(new webpack.WebpackError(`${PLUGIN_NAME}: ${msg}`))
                    const warn = (msg) => compilation.warnings.push(new webpack.WebpackError(`${PLUGIN_NAME}: ${msg}`))

                    const publicPath = compilation.outputOptions.publicPath
                    const configured = typeof publicPath === 'string' && publicPath !== 'auto'
                        ? compilation.getPath(publicPath, { hash: compilation.hash })
                        : undefined
                    const prefix = normalizeBase(this.options.base !== undefined ? this.options.base : configured)
                    const resolveExternal = external ? createExternalResolver({ timeout: externalTimeout }) : undefined

                    const allErrors = []
                    const unprotected = []
                    let htmlCount = 0

                    for (const { name: htmlName, source } of compilation.getAssets()) {
                        if (!htmlName.endsWith('.html')) continue
                        htmlCount++
                        const htmlDir = path.posix.dirname(htmlName)

                        const resolveAsset = (url) => {
                            const p = outputPathFor(url, prefix, htmlDir)
                            if (p === null) throw new Error('potential path traversal, skipping')
                            const found = compilation.getAsset(p)
                            return found ? found.source.buffer() : null
                        }

                        const { html: out, modified, errors, warnings, unprotectedScripts } = await injectSri(
                            sourceToString(source.source()), resolveAsset,
                            { algorithm: this.algorithm, crossorigin: this.crossorigin, base: prefix, resolveExternal }
                        )
                        errors.forEach(e => allErrors.push(`${htmlName}: ${e}`))
                        unprotectedScripts.forEach(u => unprotected.push(`${htmlName}: ${u}`))
                        warnings.forEach(w => warn(`${htmlName}: ${w}`))
                        if (modified) compilation.updateAsset(htmlName, new RawSource(out))
                    }

                    if (htmlCount === 0) {
                        const msg = 'No HTML files found in the compilation; no integrity attributes were injected.'
                        if (strict) fail(msg)
                        else warn(msg)
                        return
                    }

                    if (this.policyHeader) {
                        if (unprotected.length) {
                            fail(`${unprotected.length} script(s) have no integrity and would be blocked by the Integrity-Policy header:\n  - ${unprotected.join('\n  - ')}`)
                        }
                        if (this.policy.headersFile) {
                            const existing = compilation.getAsset(this.policy.headersFile)
                            const merged = mergeHeadersFile(existing ? sourceToString(existing.source.source()) : '', this.policyHeader)
                            if (existing) compilation.updateAsset(this.policy.headersFile, new RawSource(merged))
                            else compilation.emitAsset(this.policy.headersFile, new RawSource(merged))
                        }
                        compilation.getLogger(PLUGIN_NAME).info(`send this response header with your HTML:\n  ${this.policyHeader.name}: ${this.policyHeader.value}`)
                    }

                    if (allErrors.length) {
                        const msg = `${allErrors.length} resource(s) could not be processed:\n  - ${allErrors.join('\n  - ')}`
                        if (strict) fail(msg)
                        else allErrors.forEach(e => warn(e))
                    }
                }
            )
        })
    }
}

module.exports = SriWebpackPlugin
module.exports.default = SriWebpackPlugin
