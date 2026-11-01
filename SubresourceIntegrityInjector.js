const fs = require('fs-extra')
const path = require('path')
const core = require('./core')
const { createExternalResolver } = require('./external')

class SubresourceIntegrityInjector {

    validateHashName(algorithmName) {
        return core.validateAlgorithm(algorithmName)
    }

    isExternal(url) {
        return core.isExternal(url)
    }

    toFilePath(url) {
        return core.toFilePath(url)
    }

    calculateBase64Hash(content, algorithm) {
        return core.calculateBase64Hash(content, algorithm)
    }

    /**
     * Processes a single HTML file to inject SRI attributes.
     * Returns { errors, warnings }: resources that could not be protected, and existing
     * integrity values that were wrong and got replaced.
     */
    async processFile(filePath, algorithm, outputDir = this.outputDir, base = this.base, resolveExternal = this.resolveExternal, crossorigin = this.crossorigin) {
        const html = await fs.readFile(filePath, 'utf8')

        // URLs under the public base (e.g. "/app/x.js" or "https://cdn.example.com/x.js") and other
        // root-relative URLs resolve against the output dir; relative URLs against the HTML file.
        const resolveAsset = async (url) => {
            let fullPath
            const underBase = core.relativeToBase(url, base)
            if (underBase !== null) {
                fullPath = path.resolve(outputDir, underBase)
            } else {
                const root = url.startsWith('/') ? outputDir : path.dirname(filePath)
                fullPath = path.resolve(root, core.toFilePath(url).replace(/^\/+/, ''))
            }

            // Security: Prevent path traversal
            if (!core.isInsideDir(outputDir, fullPath)) {
                throw new Error('potential path traversal, skipping')
            }
            try {
                return await fs.readFile(fullPath)
            } catch (err) {
                if (err.code === 'ENOENT') {
                    throw new Error(`not found at "${fullPath}". Please verify that this file exists in your output directory.`)
                }
                throw err
            }
        }

        const { html: out, modified, errors, warnings, unprotectedScripts } = await core.injectSri(html, resolveAsset, { algorithm, crossorigin, base, resolveExternal })
        errors.forEach(e => console.error(`Error: ${filePath}: ${e}`))
        warnings.forEach(w => console.warn(`Warning: ${filePath}: ${w}`))
        if (modified) {
            await fs.writeFile(filePath, out)
        }
        return { errors, warnings, unprotectedScripts }
    }

    /**
     * Recursively collects .js/.mjs files under dir.
     */
    async findScriptFiles(dir) {
        const entries = await fs.readdir(dir, { withFileTypes: true })
        const found = []
        for (const entry of entries) {
            const full = path.join(dir, entry.name)
            if (entry.isDirectory()) found.push(...await this.findScriptFiles(full))
            else if (entry.isFile() && /\.m?js$/.test(entry.name)) found.push(full)
        }
        return found
    }

    /**
     * Recursively collects .html files under dir.
     */
    async findHtmlFiles(dir) {
        const entries = await fs.readdir(dir, { withFileTypes: true })
        const found = []
        for (const entry of entries) {
            const full = path.join(dir, entry.name)
            if (entry.isDirectory()) {
                found.push(...await this.findHtmlFiles(full))
            } else if (entry.isFile() && entry.name.endsWith('.html')) {
                found.push(full)
            }
        }
        return found
    }

    /**
     * Entry point to scan outputDir (recursively) and inject SRI attributes into HTML files.
     *
     * Resolves to `{ files, errors, warnings }`: the number of HTML files processed, every
     * per-resource error (resources that could not be protected) and every warning (existing
     * integrity values that were wrong and got replaced).
     *
     * With options.strict, finding no HTML files or failing to resolve any resource
     * causes a rejection instead.
     *
     * options.base is the public base path or URL the HTML was built for (Vite/Rollup `base`).
     * When it is a full URL, assets under it are hashed instead of being skipped as external.
     *
     * options.crossorigin ('anonymous' by default, or 'use-credentials') is written to tags that have none.
     *
     * options.external fetches third-party resources (https://..., //host/...) over the network and
     * pins them too. Resources whose server sends no CORS header are left alone with a warning.
     * options.externalTimeout (ms) bounds each request.
     *
     * options.integrityPolicy (true | 'report-only' | { reportOnly, endpoints, headersFile }) prepares
     * the Integrity-Policy response header, which makes browsers block scripts without integrity:
     * every still-unprotected <script> becomes an error, the header is returned as `integrityPolicy`
     * and, with headersFile, merged into that Netlify/Cloudflare-style file in the output directory.
     */
    async insertSRIInHTML(outputDir, algorithm = 'sha384', options = {}) {
        const resolvedDir = path.resolve(outputDir)
        const selected = this.validateHashName(algorithm)
        this.outputDir = resolvedDir
        this.algorithm = selected
        this.base = core.normalizeBase(options.base)
        this.crossorigin = core.validateCrossorigin(options.crossorigin)
        this.resolveExternal = options.external ? createExternalResolver({ timeout: options.externalTimeout }) : undefined
        const policy = core.normalizeIntegrityPolicy(options.integrityPolicy)
        const policyHeader = policy ? core.buildIntegrityPolicyHeader(policy) : undefined

        if (!fs.existsSync(resolvedDir)) {
            throw new Error(`Output directory not found: ${outputDir}`)
        }

        const htmlFiles = await this.findHtmlFiles(resolvedDir)

        if (htmlFiles.length === 0) {
            if (options.strict) {
                throw new Error(`No HTML files found in output directory: ${outputDir}`)
            }
            return { files: 0, errors: [], warnings: [], integrityPolicy: policyHeader }
        }

        const results = await Promise.all(htmlFiles.map(file => this.processFile(file, selected, resolvedDir, this.base, this.resolveExternal, this.crossorigin)))
        const errors = results.flatMap(r => r.errors)
        const warnings = results.flatMap(r => r.warnings)

        if (policyHeader) {
            // The header would make browsers block these; shipping both is a broken site.
            const unprotected = htmlFiles.flatMap((file, i) => results[i].unprotectedScripts.map(u => `${file}: ${u}`))
            if (unprotected.length) {
                const msg = `${unprotected.length} script(s) have no integrity and would be blocked by the Integrity-Policy header:\n  - ${unprotected.join('\n  - ')}`
                console.error(`Error: ${msg}`)
                errors.push(msg)
            }
            // Code-split chunks loaded with import() are not in any HTML; without an import map (which
            // needs the bundler's module graph) the header would block them too.
            for (const file of await this.findScriptFiles(resolvedDir)) {
                if (/\bimport\s*\(/.test(await fs.readFile(file, 'utf8'))) {
                    const w = `${file}: uses dynamic import(); chunks loaded this way have no integrity here and would be blocked by Integrity-Policy. Use the Rollup/Vite plugin, which covers them with an import map.`
                    console.warn(`Warning: ${w}`)
                    warnings.push(w)
                }
            }
            if (policy.headersFile) {
                const target = path.join(resolvedDir, policy.headersFile)
                const existing = fs.existsSync(target) ? await fs.readFile(target, 'utf8') : ''
                await fs.writeFile(target, core.mergeHeadersFile(existing, policyHeader))
            }
        }

        if (options.strict && errors.length > 0) {
            throw new Error(`${errors.length} resource(s) could not be processed:\n  - ${errors.join('\n  - ')}`)
        }
        return { files: htmlFiles.length, errors, warnings, integrityPolicy: policyHeader }
    }
}

module.exports = SubresourceIntegrityInjector
