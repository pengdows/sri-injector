const fs = require('fs-extra')
const path = require('path')
const core = require('./core')

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
     * Processes a single HTML file to inject SRI attributes. Returns the list of errors.
     */
    async processFile(filePath, algorithm, outputDir = this.outputDir) {
        const html = await fs.readFile(filePath, 'utf8')

        // Root-relative URLs resolve against the output dir, others against the HTML file
        const resolveAsset = async (url) => {
            const base = url.startsWith('/') ? outputDir : path.dirname(filePath)
            const fullPath = path.resolve(base, core.toFilePath(url).replace(/^\/+/, ''))

            // Security: Prevent path traversal
            const rel = path.relative(outputDir, fullPath)
            if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
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

        const { html: out, modified, errors } = await core.injectSri(html, resolveAsset, { algorithm })
        errors.forEach(e => console.error(`Error: ${filePath}: ${e}`))
        if (modified) {
            await fs.writeFile(filePath, out)
        }
        return errors
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
     * With options.strict, any unresolved or rejected resource causes a rejection.
     */
    async insertSRIInHTML(outputDir, algorithm = 'sha384', options = {}) {
        const resolvedDir = path.resolve(outputDir)
        const selected = this.validateHashName(algorithm)
        this.outputDir = resolvedDir
        this.algorithm = selected

        if (!fs.existsSync(resolvedDir)) {
            throw new Error(`Output directory not found: ${outputDir}`)
        }

        const htmlFiles = await this.findHtmlFiles(resolvedDir)

        if (htmlFiles.length === 0) {
            console.warn('No HTML files found in output directory.')
            return
        }

        const results = await Promise.all(htmlFiles.map(file => this.processFile(file, selected, resolvedDir)))
        const errors = results.flat()
        if (options.strict && errors.length > 0) {
            throw new Error(`${errors.length} resource(s) could not be processed:\n  - ${errors.join('\n  - ')}`)
        }
    }
}

module.exports = SubresourceIntegrityInjector
