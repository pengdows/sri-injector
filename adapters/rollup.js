const path = require('path')
const { injectSri, toFilePath, isInsideDir, normalizeBase, relativeToBase, isExternal, calculateBase64Hash, validateAlgorithm, buildIntegrityPolicyHeader, normalizeIntegrityPolicy, mergeHeadersFile } = require('../core')
const { createExternalResolver } = require('../external')

/**
 * Rollup/Vite plugin: injects SRI into every .html asset in the output bundle.
 * Runs in generateBundle with order 'post', so hashes cover the final emitted bytes.
 * Place it after any plugin that emits or rewrites HTML or assets.
 *
 * Options:
 *  - algorithm: 'sha256' | 'sha384' (default) | 'sha512'
 *  - strict:    throw (fail the build) if a local resource cannot be resolved or the bundle has no HTML
 *  - base:      public base path or URL; defaults to Vite's resolved `base`, else '/'. When it is a
 *               full URL (CDN deployment), assets under it are hashed instead of being skipped as external.
 *  - publicDir: extra dir checked for files not in the bundle (defaults to Vite's publicDir)
 *  - external:  also fetch third-party resources (https://..., //host/...) at build time and pin
 *               them. Servers without CORS headers are skipped with a warning. Off by default so
 *               builds do not depend on the network unless asked.
 *  - externalTimeout: per-request timeout in ms for `external` (default 10000)
 *  - importMap:  add an import map "integrity" section covering every chunk reachable from the page's
 *                scripts through static and dynamic imports (code-split chunks never appear in the
 *                HTML, so this is the only way to give them integrity). Default true.
 *  - integrityPolicy: true | 'report-only' | { reportOnly, endpoints, headersFile }. Prepares the
 *                Integrity-Policy response header, which makes browsers block any script without
 *                integrity. Every uncovered <script> therefore becomes a build error; the header is
 *                set on Vite's preview server (not dev, which serves unhashed source modules) and,
 *                with `headersFile`, written in Netlify/Cloudflare `_headers` format. The header is
 *                HTTP-only: for other hosts, copy the value logged at the end of the build.
 */
/**
 * Rollup asset sources are `string | Uint8Array`; String() on a Uint8Array yields "60,104,...".
 */
function sourceToString(source) {
    return typeof source === 'string' ? source : Buffer.from(source).toString('utf8')
}

function sriPlugin(options = {}) {
    const { algorithm = 'sha384', strict = false, external = false, externalTimeout, importMap = true } = options
    const policy = normalizeIntegrityPolicy(options.integrityPolicy)
    const policyHeader = policy ? buildIntegrityPolicyHeader(policy) : null
    let base = options.base
    let publicDir = options.publicDir

    return {
        name: 'sri-injector',
        enforce: 'post',
        config() {
            if (!policyHeader) return undefined
            return { preview: { headers: { [policyHeader.name]: policyHeader.value } } }
        },
        configResolved(config) {
            if (base === undefined) base = config.base
            if (publicDir === undefined && config.publicDir) publicDir = config.publicDir
        },
        generateBundle: {
            order: 'post',
            async handler(_outputOptions, bundle) {
                const fs = require('fs')
                const prefix = normalizeBase(base)
                const algo = validateAlgorithm(algorithm)
                const resolveExternal = external ? createExternalResolver({ timeout: externalTimeout }) : undefined
                const allErrors = []
                const unprotected = []
                let htmlCount = 0

                for (const [htmlName, item] of Object.entries(bundle)) {
                    if (item.type !== 'asset' || !htmlName.endsWith('.html')) continue
                    htmlCount++
                    const html = sourceToString(item.source)
                    const htmlDir = path.posix.dirname(htmlName)

                    const resolveAsset = async (url) => {
                        // Under the public base (e.g. "/app/x.js" or "https://cdn.example.com/x.js") the
                        // remainder is the bundle path; otherwise root-relative URLs map to the bundle root
                        // and relative URLs resolve from the HTML file.
                        let p = relativeToBase(url, prefix)
                        if (p === null) {
                            p = toFilePath(url)
                            p = p.startsWith('/') ? p.replace(/^\/+/, '') : path.posix.join(htmlDir, p)
                        }
                        p = path.posix.normalize(p)
                        // Bundle keys are posix paths relative to the output root. Check on a segment
                        // boundary so a file literally named "..foo.js" is not treated as traversal.
                        if (p === '..' || p.startsWith('..' + path.posix.sep)) {
                            throw new Error('potential path traversal, skipping')
                        }

                        const found = bundle[p]
                        if (found) return found.type === 'chunk' ? found.code : found.source
                        if (publicDir) {
                            const full = path.resolve(publicDir, p)
                            if (!isInsideDir(path.resolve(publicDir), full)) return null
                            try { return fs.readFileSync(full) } catch { return null }
                        }
                        return null
                    }

                    // Maps a URL as written in this HTML to its bundle key, or null.
                    const toBundlePath = (url) => {
                        let p = relativeToBase(url, prefix)
                        if (p === null) {
                            p = toFilePath(url)
                            p = p.startsWith('/') ? p.replace(/^\/+/, '') : path.posix.join(htmlDir, p)
                        }
                        p = path.posix.normalize(p)
                        return bundle[p] ? p : null
                    }
                    // Public URL of a bundle path as this page's import map must spell it: under an
                    // absolute base (path or CDN URL) that is base + path; under a relative base it is
                    // relative to the HTML file. Import map keys must be URL-like, hence the "./".
                    const toPublicUrl = (bundlePath) => {
                        if (prefix.startsWith('/') || isExternal(prefix)) return prefix + bundlePath
                        const rel = path.posix.relative(htmlDir, bundlePath)
                        return rel.startsWith('.') ? rel : './' + rel
                    }

                    // Walk imports/dynamicImports from the page's scripts; hash every chunk the HTML
                    // does not reference itself (those already carry integrity on their tag).
                    const importMapIntegrity = importMap ? (scriptUrls) => {
                        const roots = new Set(scriptUrls.map(toBundlePath).filter(Boolean))
                        const seen = new Set(roots)
                        const queue = [...roots]
                        const entries = {}
                        while (queue.length) {
                            const item = bundle[queue.shift()]
                            if (!item || item.type !== 'chunk') continue
                            for (const dep of [...(item.imports || []), ...(item.dynamicImports || [])]) {
                                if (seen.has(dep) || !bundle[dep]) continue
                                seen.add(dep)
                                queue.push(dep)
                                const chunk = bundle[dep]
                                if (chunk.type !== 'chunk') continue
                                entries[toPublicUrl(dep)] = `${algo}-${calculateBase64Hash(chunk.code, algo)}`
                            }
                        }
                        return entries
                    } : undefined

                    const { html: out, modified, errors, warnings, unprotectedScripts } = await injectSri(html, resolveAsset, { algorithm, base: prefix, resolveExternal, importMapIntegrity })
                    errors.forEach(e => allErrors.push(`${htmlName}: ${e}`))
                    unprotectedScripts.forEach(u => unprotected.push(`${htmlName}: ${u}`))
                    warnings.forEach(w => this.warn(`sri-injector: ${htmlName}: ${w}`))
                    if (modified) item.source = out
                }

                if (htmlCount === 0) {
                    // Nothing was protected. A build that produces no HTML has nothing for SRI to do, which
                    // is almost always a misconfiguration (e.g. plugin placed before the HTML is emitted).
                    const msg = 'sri-injector: No HTML files found in the bundle; no integrity attributes were injected.'
                    if (strict) this.error(msg)
                    else this.warn(msg)
                    return
                }

                if (policyHeader) {
                    if (unprotected.length) {
                        // The header would make browsers block these; shipping both is a broken site.
                        this.error(`sri-injector: ${unprotected.length} script(s) have no integrity and would be blocked by the Integrity-Policy header:\n  - ${unprotected.join('\n  - ')}`)
                    }
                    if (policy.headersFile) {
                        // Start from whatever the user already ships: an asset another plugin emitted, or
                        // the copy in publicDir (Vite copies publicDir to the output, where our emitted
                        // asset would otherwise replace it and drop the user's own rules).
                        const existing = bundle[policy.headersFile]
                        const publicCopy = publicDir && path.join(publicDir, policy.headersFile)
                        const current = existing ? sourceToString(existing.source)
                            : publicCopy && fs.existsSync(publicCopy) ? fs.readFileSync(publicCopy, 'utf8')
                            : ''
                        const merged = mergeHeadersFile(current, policyHeader)
                        if (existing) existing.source = merged
                        else this.emitFile({ type: 'asset', fileName: policy.headersFile, source: merged })
                    }
                    const info = typeof this.info === 'function' ? this.info.bind(this) : this.warn.bind(this)
                    info(`sri-injector: send this response header with your HTML (set on the Vite preview server automatically):\n  ${policyHeader.name}: ${policyHeader.value}`)
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
