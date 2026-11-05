const path = require('path')
const { resolveOptions } = require('../lib/options')
const { processPages } = require('../lib/pipeline')
const { classify, formatFatal, formatDiagnostic, noHtmlDiagnostic, error, warning, CODES } = require('../lib/diagnostics')
const { normalizeBase, outputPathFor } = require('../lib/url')
const { sourceToString } = require('../lib/source')
const { createExternalResolver } = require('../external')

const PLUGIN_NAME = 'sri-injector'

/**
 * webpack's chunk loader creates the <script> for a lazy chunk at runtime, with no integrity, so an
 * Integrity-Policy header would make browsers block every one of them. Reports each such JS file:
 * an error when the policy is enforced, a warning when it is report-only (nothing is blocked).
 */
function lazyChunkDiagnostics(compilation, { reportOnly }) {
    const make = reportOnly ? warning : error
    const files = []
    for (const chunk of compilation.chunks) {
        if (chunk.canBeInitial()) continue
        for (const file of chunk.files) if (/\.[cm]?js$/.test(file)) files.push(file)
    }
    return files.map(file => make(
        CODES.UNPROTECTED_CHUNK,
        `Chunk "${file}" is loaded at runtime without integrity and would be blocked by the Integrity-Policy header. webpack's chunk loader cannot carry integrity: use webpack-subresource-integrity for lazy chunks, or Integrity-Policy-Report-Only while you evaluate.`,
        { file }
    ))
}

/**
 * webpack plugin: injects SRI into every .html asset in the compilation (e.g. from
 * html-webpack-plugin). Runs in processAssets at PROCESS_ASSETS_STAGE_OPTIMIZE_TRANSFER, after
 * html-webpack-plugin emits the page (OPTIMIZE_INLINE) and after content hashing, so hashes cover
 * the final emitted bytes and plugin order in `plugins` does not matter.
 *
 * Options are those of the Rollup/Vite plugin (validated in lib/options; unknown keys are rejected),
 * except that `base` defaults to output.publicPath (when it is a string other than 'auto') and
 * `publicDir` and `importMap` do not apply:
 *  - enabled, algorithm, crossorigin, strict, base, external, externalTimeout, integrityPolicy
 *
 * Unresolvable resources are webpack errors, as in the CLI and the Rollup/Vite plugin; mark a tag
 * `skip-sri` to opt it out. No import map: webpack's classic chunk loader creates <script> elements
 * at runtime, which import maps do not govern. Use webpack-subresource-integrity for lazy chunks.
 */
class SriWebpackPlugin {
    constructor(options = {}) {
        this.config = resolveOptions(options)
    }

    apply(compiler) {
        const { webpack } = compiler
        const { RawSource } = webpack.sources
        const config = this.config
        if (!config.enabled) return

        compiler.hooks.thisCompilation.tap(PLUGIN_NAME, (compilation) => {
            compilation.hooks.processAssets.tapPromise(
                { name: PLUGIN_NAME, stage: webpack.Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_TRANSFER },
                async () => {
                    const publicPath = compilation.outputOptions.publicPath
                    const configured = typeof publicPath === 'string' && publicPath !== 'auto'
                        ? compilation.getPath(publicPath, { hash: compilation.hash })
                        : undefined
                    const base = normalizeBase(config.base !== undefined ? config.base : configured)
                    const resolveExternal = config.external ? createExternalResolver({ timeout: config.externalTimeout }) : undefined

                    const pages = compilation.getAssets()
                        .filter(({ name }) => name.endsWith('.html'))
                        .map(({ name, source }) => {
                            const htmlDir = path.posix.dirname(name)
                            const resolveAsset = (url) => {
                                const p = outputPathFor(url, base, htmlDir)
                                if (p === null) throw new Error('potential path traversal, skipping')
                                const found = compilation.getAsset(p)
                                return found ? found.source.buffer() : null
                            }
                            return { name, html: sourceToString(source.source()), resolveAsset }
                        })

                    const headersFile = config.policy && config.policy.headersFile
                    const result = await processPages(pages, config, {
                        base,
                        resolveExternal,
                        extraDiagnostics: config.policy ? lazyChunkDiagnostics(compilation, config.policy) : [],
                        headersFile: headersFile && {
                            read: async () => {
                                const existing = compilation.getAsset(headersFile)
                                return existing ? sourceToString(existing.source.source()) : null
                            },
                            write: async (content) => {
                                if (compilation.getAsset(headersFile)) compilation.updateAsset(headersFile, new RawSource(content))
                                else compilation.emitAsset(headersFile, new RawSource(content))
                            }
                        }
                    })
                    for (const page of result.pages) {
                        if (page.modified) compilation.updateAsset(page.name, new RawSource(page.html))
                    }

                    const diagnostics = pages.length === 0 ? [noHtmlDiagnostic('the compilation')] : result.diagnostics
                    // One rule for every adapter: errors fail the build, warnings are reported.
                    const { fatal, warnings } = classify(diagnostics, config)
                    warnings.forEach(d => compilation.warnings.push(new webpack.WebpackError(`${PLUGIN_NAME}: ${formatDiagnostic(d)}`)))
                    if (fatal.length) {
                        compilation.errors.push(new webpack.WebpackError(`${PLUGIN_NAME}: ${formatFatal(fatal)}`))
                    } else if (config.policyHeader && pages.length > 0) {
                        compilation.getLogger(PLUGIN_NAME).info(`send this response header with your HTML:\n  ${config.policyHeader.name}: ${config.policyHeader.value}`)
                    }
                }
            )
        })
    }
}

module.exports = SriWebpackPlugin
module.exports.default = SriWebpackPlugin
