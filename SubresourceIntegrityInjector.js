const fs = require('fs/promises')
const fsSync = require('fs')
const crypto = require('crypto')
const path = require('path')
const { parse } = require('node-html-parser')
const HashAlgo = require('./HashAlgo')

const SRI_LINK_RELS = new Set(['stylesheet', 'preload', 'modulepreload', 'prefetch'])

function isExternalResource(src) {
    if (!src) {
        return true
    }
    if (src.startsWith('data:')) {
        return true
    }
    if (src.startsWith('//')) {
        return true
    }
    return /^[a-z][a-z0-9+.-]*:/i.test(src)
}

class SubresourceIntegrityInjector {
    constructor(options = {}) {
        const algorithm = options.algorithm || 'sha384'
        if (!HashAlgo[algorithm]) {
            throw new Error(`Unsupported SRI hash algorithm "${algorithm}". Supported: ${Object.keys(HashAlgo).join(', ')}`)
        }
        this.algorithm = algorithm
        this.crossorigin = options.crossorigin ?? 'anonymous'
    }

    calculateBase64Hash(content) {
        const hash = crypto.createHash(this.algorithm)
        hash.update(content)
        return hash.digest('base64')
    }

    // Recursively scans outputDir for *.html files and injects SRI attributes into each.
    async insertSRIInDirectory(outputDir) {
        const htmlFiles = await this._findHtmlFiles(outputDir)
        const report = { processed: [], skippedExternal: [], errors: [] }
        for (const htmlFile of htmlFiles) {
            const fileReport = await this.insertSRIInFile(htmlFile, outputDir)
            for (const entry of fileReport.processed) {
                report.processed.push({ file: htmlFile, ...entry })
            }
            for (const entry of fileReport.skippedExternal) {
                report.skippedExternal.push({ file: htmlFile, ...entry })
            }
            for (const entry of fileReport.errors) {
                report.errors.push({ file: htmlFile, ...entry })
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

        const report = { processed: [], skippedExternal: [], errors: [] }

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
        return report
    }

    async _processElement(el, attribute, baseDir, report) {
        const src = el.getAttribute(attribute)

        if (isExternalResource(src)) {
            report.skippedExternal.push({ src })
            return
        }

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

        const integrity = `${this.algorithm}-${this.calculateBase64Hash(content)}`
        el.setAttribute('integrity', integrity)
        el.setAttribute('crossorigin', this.crossorigin)
        report.processed.push({ src, integrity })
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
