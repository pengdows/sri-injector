const fs = require('fs')
const path = require('path')
const { resolveOptions } = require('../lib/options')
const { processPages } = require('../lib/pipeline')
const { classify, formatFatal, formatDiagnostic, noHtmlDiagnostic, warning, CODES } = require('../lib/diagnostics')
const { normalizeBase, outputPathFor, isInsideDir, isExternal } = require('../lib/url')
const { calculateBase64Hash } = require('../lib/integrity')
const { sourceToString } = require('../lib/source')
const { createExternalResolver } = require('../external')

/**
 * Rollup plugin: injects SRI into every .html asset in the output bundle.
 * Runs in generateBundle with order 'post', so hashes cover the final emitted bytes.
 * Place it after any plugin that emits or rewrites HTML or assets. For Vite use `@pengdows/sri-injector/vite`,
 * which adds Vite's `base`/`publicDir` handling and the preview-server header on top of this.
 *
 * Options (validated in lib/options; unknown keys are rejected):
 *  - enabled:   set to false to turn the plugin off (e.g. for a watch/dev build). Default true.
 *  - algorithm: 'sha256' | 'sha384' (default) | 'sha512'
 *  - crossorigin: 'anonymous' (default) | 'use-credentials', written to tags that have none
 *  - strict:    also fail the build when no output contained HTML. (Unresolvable resources always fail
 *               the build, as in the CLI and the webpack plugin; mark a tag `data-skip-sri` to opt it out.)
 *  - base:      public base path or URL (default '/'). When it is a full URL (CDN deployment), assets
 *               under it are hashed instead of being skipped as external.
 *  - publicDir: extra dir checked for files not in the bundle
 *  - external:  also fetch third-party resources (https://..., //host/...) at build time and pin
 *               them. Servers without CORS headers are skipped with a warning. Off by default so
 *               builds do not depend on the network unless asked.
 *  - externalTimeout: per-request timeout in ms for `external` (default 10000)
 *  - importMap:  add an import map "integrity" section covering every chunk reachable from the page's
 *                scripts through static and dynamic imports (code-split chunks never appear in the
 *                HTML, so this is the only way to give them integrity). Default true.
 *  - manifest:   add an `integrity` field to every entry of a Vite build manifest (`build.manifest`),
 *                for backends that render the tags themselves. Default true.
 *  - integrityPolicy: true | 'report-only' | { reportOnly, endpoints, headersFile }. Prepares the
 *                Integrity-Policy response header, which makes browsers block any script without
 *                integrity. Every uncovered <script> therefore becomes a build error; with
 *                `headersFile` it is written in Netlify/Cloudflare `_headers` format. The header is
 *                HTTP-only: for other hosts, copy the value logged at the end of the build.
 */
function sriPlugin(options = {}) {
    return createBundlePlugin(resolveOptions(options))
}

/**
 * The plugin body, shared with the Vite wrapper. `getEnv()` supplies values only the host learns late
 * (Vite's resolved `base` and `publicDir`); it is read at generate time and falls back to `config`.
 */
function createBundlePlugin(config, getEnv = () => ({}), { headerNote = '' } = {}) {
    // A build can have several outputs (e.g. @vitejs/plugin-legacy builds its legacy chunks in a
    // separate output *before* the output that contains the HTML). Files from earlier outputs are
    // remembered so the HTML can still resolve them, third-party files are fetched once per build,
    // and whether any output had HTML is judged once, at closeBundle, rather than per output.
    const earlierOutputs = new Map()
    let resolveExternal
    let outputsSeen = 0
    let htmlSeen = 0

    // One rule for every adapter: errors fail the build, warnings are reported.
    const report = (ctx, diagnostics) => {
        const { fatal, warnings } = classify(diagnostics, config)
        warnings.forEach(d => ctx.warn(`sri-injector: ${formatDiagnostic(d)}`))
        if (fatal.length) ctx.error(`sri-injector: ${formatFatal(fatal)}`)
    }

    return {
        name: 'sri-injector',
        closeBundle() {
            const noHtml = config.enabled && outputsSeen > 0 && htmlSeen === 0
            earlierOutputs.clear()
            resolveExternal = undefined
            outputsSeen = 0
            htmlSeen = 0
            // A build that produces no HTML has nothing for SRI to do, which is almost always a
            // misconfiguration (e.g. plugin placed before the HTML is emitted).
            if (noHtml) report(this, [noHtmlDiagnostic('any output')])
        },
        generateBundle: {
            order: 'post',
            async handler(_outputOptions, bundle) {
                if (!config.enabled) return
                const env = getEnv()
                const base = normalizeBase(env.base !== undefined ? env.base : config.base)
                const publicDir = env.publicDir !== undefined ? env.publicDir : config.publicDir
                if (config.external && !resolveExternal) resolveExternal = createExternalResolver({ timeout: config.externalTimeout })
                outputsSeen++
                if (config.manifest) addManifestIntegrity(this, bundle, config.algorithm)

                const pages = Object.entries(bundle)
                    .filter(([name, item]) => item.type === 'asset' && name.endsWith('.html'))
                    .map(([name, item]) => pageFor(name, item, bundle, { base, publicDir, earlierOutputs, algorithm: config.algorithm, importMap: config.importMap }))
                htmlSeen += pages.length

                // Remember this output's files for HTML in a later output (HTML itself is rewritten, so skip it)
                const rememberOutput = () => {
                    for (const [name, item] of Object.entries(bundle)) {
                        if (item.type === 'asset' && name.endsWith('.html')) continue
                        earlierOutputs.set(name, item.type === 'chunk' ? item.code : item.source)
                    }
                }

                const headersFile = config.policy && config.policy.headersFile
                const result = await processPages(pages, config, {
                    base,
                    resolveExternal,
                    extraDiagnostics: pages.length ? lazyStylesheetDiagnostics(bundle, pages) : [],
                    headersFile: headersFile && {
                        // Start from whatever the user already ships: an asset another plugin emitted, or
                        // the copy in publicDir (Vite copies publicDir to the output, where our emitted
                        // asset would otherwise replace it and drop the user's own rules).
                        read: async () => {
                            if (bundle[headersFile]) return sourceToString(bundle[headersFile].source)
                            const publicCopy = publicDir && path.join(publicDir, headersFile)
                            return publicCopy && fs.existsSync(publicCopy) ? fs.readFileSync(publicCopy, 'utf8') : null
                        },
                        write: async (content) => {
                            if (bundle[headersFile]) bundle[headersFile].source = content
                            else this.emitFile({ type: 'asset', fileName: headersFile, source: content })
                        }
                    }
                })
                for (const page of result.pages) {
                    if (page.modified) bundle[page.name].source = page.html
                }
                rememberOutput()
                if (pages.length === 0) return

                report(this, result.diagnostics)

                if (config.policyHeader) {
                    const info = typeof this.info === 'function' ? this.info.bind(this) : this.warn.bind(this)
                    info(`sri-injector: send this response header with your HTML${headerNote}:\n  ${config.policyHeader.name}: ${config.policyHeader.value}`)
                }
            }
        }
    }
}

/** Vite's build manifest: `manifest.json` or `.vite/manifest.json` (also `ssr-manifest.json`, which has no `file` entries and is skipped). */
const isManifest = (name) => /(^|\/)(\.vite\/)?manifest\.json$/.test(name)

/**
 * For backends that render the <script>/<link> tags themselves from the manifest: adds `integrity` to
 * every entry whose `file` is in the bundle, right after `file`. The hash is of the emitted file,
 * so it is what the tag must carry. Re-running only refreshes the value.
 */
function addManifestIntegrity(ctx, bundle, algorithm) {
    for (const [name, item] of Object.entries(bundle)) {
        if (item.type !== 'asset' || !isManifest(name)) continue
        let manifest
        try { manifest = JSON.parse(sourceToString(item.source)) } catch (err) {
            ctx.warn(`sri-injector: ${name} is not valid JSON, so no integrity was added to it: ${err.message}`)
            continue
        }
        if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) continue
        let changed = false
        for (const [key, entry] of Object.entries(manifest)) {
            const file = entry && typeof entry === 'object' ? entry.file : undefined
            const emitted = typeof file === 'string' ? bundle[file] : undefined
            if (!emitted) continue
            const hash = `${algorithm}-${calculateBase64Hash(emitted.type === 'chunk' ? emitted.code : emitted.source, algorithm)}`
            if (entry.integrity === hash) continue
            const { integrity, ...rest } = entry
            manifest[key] = Object.fromEntries(Object.entries(rest).flatMap(([k, v]) => (k === 'file' ? [[k, v], ['integrity', hash]] : [[k, v]])))
            changed = true
        }
        if (changed) item.source = JSON.stringify(manifest, null, 2)
    }
}

/**
 * Vite records the CSS each chunk needs in `viteMetadata.importedCss`. For a lazy chunk that CSS is
 * loaded at runtime by a <link> element created from JS, which no HTML tag stands for, so it cannot
 * get integrity (import maps only govern module scripts). Warn about every such file; the fix is
 * `build.cssCodeSplit: false`, which puts all CSS in one stylesheet linked from the HTML.
 */
function lazyStylesheetDiagnostics(bundle, pages) {
    const referenced = (css) => pages.some(p => p.html.includes(css))
    const lazy = new Set()
    for (const item of Object.values(bundle)) {
        if (item.type !== 'chunk' || !item.viteMetadata) continue
        for (const css of item.viteMetadata.importedCss || []) {
            if (!referenced(css)) lazy.add(css)
        }
    }
    return [...lazy].map(css => warning(CODES.LAZY_STYLESHEET,
        `Stylesheet "${css}" is loaded at runtime by a lazy chunk, so it has no integrity (no HTML tag references it). Set build.cssCodeSplit to false to link all CSS from the HTML.`,
        { url: css }))
}

/**
 * Describes one HTML asset for processPages: how to find the assets it references (the current
 * bundle, then earlier outputs, then publicDir) and how to hash the chunks it can only reach
 * through imports.
 */
function pageFor(htmlName, item, bundle, { base, publicDir, earlierOutputs, algorithm, importMap }) {
    const htmlDir = path.posix.dirname(htmlName)

    const resolveAsset = async (url) => {
        const p = outputPathFor(url, base, htmlDir)
        if (p === null) throw new Error('potential path traversal, skipping')

        const found = bundle[p]
        if (found) return found.type === 'chunk' ? found.code : found.source
        if (earlierOutputs.has(p)) return earlierOutputs.get(p)
        if (publicDir) {
            const full = path.resolve(publicDir, p)
            if (!isInsideDir(path.resolve(publicDir), full)) return null
            try { return fs.readFileSync(full) } catch { return null }
        }
        return null
    }

    // Maps a URL as written in this HTML to its bundle key, or null.
    const toBundlePath = (url) => {
        const p = outputPathFor(url, base, htmlDir)
        return p !== null && bundle[p] ? p : null
    }
    // Public URL of a bundle path as this page's import map must spell it: under an absolute base
    // (path or CDN URL) that is base + path; under a relative base it is relative to the HTML file.
    // Import map keys must be URL-like, hence the "./".
    const toPublicUrl = (bundlePath) => {
        if (base.startsWith('/') || isExternal(base)) return base + bundlePath
        const rel = path.posix.relative(htmlDir, bundlePath)
        return rel.startsWith('.') ? rel : './' + rel
    }

    // Walk imports/dynamicImports from the page's scripts; hash every chunk the HTML does not
    // reference itself (those already carry integrity on their tag).
    const importMapIntegrity = importMap ? (scriptUrls) => {
        const roots = new Set(scriptUrls.map(toBundlePath).filter(Boolean))
        const seen = new Set(roots)
        const queue = [...roots]
        const entries = {}
        while (queue.length) {
            const chunk = bundle[queue.shift()]
            if (!chunk || chunk.type !== 'chunk') continue
            for (const dep of [...(chunk.imports || []), ...(chunk.dynamicImports || [])]) {
                if (seen.has(dep) || !bundle[dep]) continue
                seen.add(dep)
                queue.push(dep)
                if (bundle[dep].type !== 'chunk') continue
                entries[toPublicUrl(dep)] = `${algorithm}-${calculateBase64Hash(bundle[dep].code, algorithm)}`
            }
        }
        return entries
    } : undefined

    return { name: htmlName, html: sourceToString(item.source), resolveAsset, importMapIntegrity }
}

module.exports = sriPlugin
module.exports.default = sriPlugin
module.exports.createBundlePlugin = createBundlePlugin
