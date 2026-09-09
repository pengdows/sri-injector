const fs = require('fs/promises')
const fsSync = require('fs')
const crypto = require('crypto')
const path = require('path')
const { parse } = require('node-html-parser')
const HashAlgo = require('./HashAlgo')

const SRI_LINK_RELS = new Set(['stylesheet', 'preload', 'modulepreload', 'prefetch'])

function classifyResource(src) {
    if (!src) {
        return { type: 'empty' }
    }
    if (src.startsWith('data:')) {
        return { type: 'data' }
    }
    if (src.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(src)) {
        return { type: 'external' }
    }
    return { type: 'local' }
}

class SubresourceIntegrityInjector {
    constructor(options = {}) {
        const algorithm = options.algorithm || 'sha384'
        if (!HashAlgo[algorithm]) {
            throw new Error(`Unsupported SRI hash algorithm "${algorithm}". Supported: ${Object.keys(HashAlgo).join(', ')}`)
        }
        this.algorithm = algorithm
        this.crossorigin = options.crossorigin ?? 'anonymous'
        // The whole point of SRI is to protect against a third-party resource
        // (CDN, analytics script, etc.) being compromised after this build
        // references it, so external resources are fetched and hashed by
        // default rather than skipped.
        this.fetchExternal = options.fetchExternal ?? true
        this.defaultProtocol = options.defaultProtocol ?? 'https:'
        this.fetchTimeoutMs = options.fetchTimeoutMs ?? 10000
        // Persists last-known-good hashes for external resources across runs,
        // keyed by algorithm+URL. When a fetch fails and a cached entry
        // exists, that hash is used instead of failing the whole build --
        // the browser is still protected by a real previously-verified hash,
        // just not this run's freshest one.
        this.lockFilePath = options.lockFilePath ? path.resolve(options.lockFilePath) : null
        this._lock = null
        this._lockDirty = false
        this._externalCache = new Map()
    }

    calculateBase64Hash(content) {
        const hash = crypto.createHash(this.algorithm)
        hash.update(content)
        return hash.digest('base64')
    }

    // Recursively scans outputDir for *.html files and injects SRI attributes into each.
    async insertSRIInDirectory(outputDir) {
        const htmlFiles = await this._findHtmlFiles(outputDir)
        const report = { processed: [], skipped: [], warnings: [], errors: [] }
        for (const htmlFile of htmlFiles) {
            const fileReport = await this.insertSRIInFile(htmlFile, outputDir)
            for (const key of ['processed', 'skipped', 'warnings', 'errors']) {
                for (const entry of fileReport[key]) {
                    report[key].push({ file: htmlFile, ...entry })
                }
            }
        }
        return report
    }

    // Injects SRI attributes into a single HTML file. baseDir is used to resolve
    // relative resource paths and defaults to the file's own directory.
    async insertSRIInFile(htmlFilePath, baseDir = path.dirname(htmlFilePath)) {
        if (!fsSync.existsSync(htmlFilePath)) {
            throw new Error(`HTML file not found: ${htmlFilePath}`)
        }
        const htmlContent = await fs.readFile(htmlFilePath, 'utf8')
        const root = parse(htmlContent, { voidTag: { closingSlash: true } })

        const report = { processed: [], skipped: [], warnings: [], errors: [] }

        const scripts = root.querySelectorAll('script[src]')
        const links = root.querySelectorAll('link[href]').filter((el) => {
            const rel = (el.getAttribute('rel') || '').toLowerCase()
            return SRI_LINK_RELS.has(rel)
        })

        for (const el of scripts) {
            await this._processElement(el, 'src', baseDir, report)
        }
        for (const el of links) {
            await this._processElement(el, 'href', baseDir, report)
        }

        if (report.processed.length > 0) {
            await fs.writeFile(htmlFilePath, root.toString())
        }
        await this._saveLockIfDirty()
        return report
    }

    async _processElement(el, attribute, baseDir, report) {
        const src = el.getAttribute(attribute)
        const classification = classifyResource(src)

        if (classification.type === 'empty') {
            report.skipped.push({ src, reason: 'empty-src' })
            return
        }

        if (classification.type === 'data') {
            // Inline content: nothing external to protect against, and an
            // attacker who could swap the data: URI could swap any integrity
            // attribute too.
            report.skipped.push({ src, reason: 'data-uri' })
            return
        }

        if (classification.type === 'external') {
            await this._processExternal(el, src, report)
            return
        }

        await this._processLocal(el, src, baseDir, report)
    }

    async _processLocal(el, src, baseDir, report) {
        const resolvedBase = path.resolve(baseDir)
        const resolvedPath = path.resolve(resolvedBase, src)
        if (resolvedPath !== resolvedBase && !resolvedPath.startsWith(resolvedBase + path.sep)) {
            report.errors.push({ src, error: `Resource path escapes output directory: ${src}` })
            return
        }

        let content
        try {
            content = await fs.readFile(resolvedPath)
        } catch (e) {
            report.errors.push({ src, error: e.message })
            return
        }

        this._applyIntegrity(el, content)
        report.processed.push({ src, integrity: el.getAttribute('integrity') })
    }

    async _processExternal(el, src, report) {
        if (!this.fetchExternal) {
            report.skipped.push({ src, reason: 'fetch-disabled' })
            return
        }

        const url = src.startsWith('//') ? `${this.defaultProtocol}${src}` : src
        await this._ensureLockLoaded()
        const lockKey = this._lockKey(url)
        const cached = this.lockFilePath ? this._lock.entries[lockKey] : null

        let result
        try {
            result = await this._fetchExternalContent(url)
        } catch (e) {
            if (cached) {
                el.setAttribute('integrity', cached.integrity)
                el.setAttribute('crossorigin', this.crossorigin)
                report.processed.push({ src, url, integrity: cached.integrity, external: true, usedCachedHash: true })
                report.warnings.push({
                    src,
                    url,
                    warning:
                        `Fetch failed (${e.message}); used a cached integrity value from ${this.lockFilePath} ` +
                        `last recorded ${cached.fetchedAt}. Re-run once the resource is reachable to refresh it.`,
                })
                return
            }
            report.errors.push({ src, url, error: e.message })
            return
        }

        this._applyIntegrity(el, result.content)
        const integrity = el.getAttribute('integrity')
        report.processed.push({ src, url, integrity, external: true })

        if (this.lockFilePath) {
            this._lock.entries[lockKey] = { integrity, fetchedAt: new Date().toISOString() }
            this._lockDirty = true
        }

        if (!result.hasCorsHeader) {
            report.warnings.push({
                src,
                url,
                warning:
                    'Response did not include an Access-Control-Allow-Origin header. ' +
                    'Browsers will refuse to load this resource once crossorigin+integrity are added ' +
                    '(SRI requires a CORS-enabled fetch for cross-origin resources). ' +
                    'Consider self-hosting this resource instead.',
            })
        }
    }

    _lockKey(url) {
        return `${this.algorithm}::${url}`
    }

    async _ensureLockLoaded() {
        if (!this.lockFilePath || this._lock) {
            return
        }
        try {
            const raw = await fs.readFile(this.lockFilePath, 'utf8')
            this._lock = JSON.parse(raw)
        } catch (e) {
            if (e.code !== 'ENOENT') {
                throw new Error(`Failed to read lock file ${this.lockFilePath}: ${e.message}`)
            }
            this._lock = { entries: {} }
        }
        if (!this._lock.entries) {
            this._lock.entries = {}
        }
    }

    async _saveLockIfDirty() {
        if (!this.lockFilePath || !this._lockDirty) {
            return
        }
        await fs.writeFile(this.lockFilePath, JSON.stringify(this._lock, null, 2) + '\n')
        this._lockDirty = false
    }

    _applyIntegrity(el, content) {
        const integrity = `${this.algorithm}-${this.calculateBase64Hash(content)}`
        el.setAttribute('integrity', integrity)
        el.setAttribute('crossorigin', this.crossorigin)
    }

    async _fetchExternalContent(url) {
        if (!this._externalCache.has(url)) {
            this._externalCache.set(url, this._doFetch(url))
        }
        return this._externalCache.get(url)
    }

    async _doFetch(url) {
        if (typeof fetch !== 'function') {
            throw new Error('Fetching external resources requires a Node.js runtime with global fetch (Node 18+).')
        }
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), this.fetchTimeoutMs)
        try {
            const response = await fetch(url, { signal: controller.signal })
            if (!response.ok) {
                throw new Error(`Request to ${url} failed with HTTP ${response.status} ${response.statusText}`)
            }
            const arrayBuffer = await response.arrayBuffer()
            return {
                content: Buffer.from(arrayBuffer),
                hasCorsHeader: Boolean(response.headers.get('access-control-allow-origin')),
            }
        } catch (e) {
            if (e.name === 'AbortError') {
                throw new Error(`Request to ${url} timed out after ${this.fetchTimeoutMs}ms`)
            }
            throw e
        } finally {
            clearTimeout(timer)
        }
    }

    async _findHtmlFiles(dir) {
        const results = []
        const entries = await fs.readdir(dir, { withFileTypes: true })
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name)
            if (entry.isDirectory()) {
                results.push(...await this._findHtmlFiles(fullPath))
            } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.html')) {
                results.push(fullPath)
            }
        }
        return results
    }
}

module.exports = SubresourceIntegrityInjector
