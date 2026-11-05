const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const { resolveOptions } = require('./options')
const { processPages } = require('./pipeline')
const { warning, error, noHtmlDiagnostic, formatDiagnostic, CODES } = require('./diagnostics')
const { outputPathFor, isInsideDir, normalizeBase } = require('./url')
const { createExternalResolver } = require('../external')

/** Recursively collects the files under `dir` whose name matches `test`. */
async function findFiles(dir, test) {
    const found = []
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) found.push(...await findFiles(full, test))
        else if (entry.isFile() && test(entry.name)) found.push(full)
    }
    return found
}

/**
 * Decodes an HTML file so it can be edited as text and written back byte for byte. UTF-8 (a BOM
 * is kept) is decoded as such. Anything else is decoded as Latin-1, which maps every byte to one
 * character, so the bytes around the edits survive a round trip whatever the page's charset;
 * the injected text is plain ASCII. UTF-16 cannot be handled that way and is rejected.
 */
function decodeHtml(buffer) {
    const b0 = buffer[0]
    const b1 = buffer[1]
    if ((b0 === 0xff && b1 === 0xfe) || (b0 === 0xfe && b1 === 0xff)) return null
    try {
        return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer), encoding: 'utf8' }
    } catch {
        return { text: buffer.toString('latin1'), encoding: 'latin1' }
    }
}

const posix = (p) => p.split(path.sep).join('/')

/**
 * The filesystem host: runs every .html file under `outputDir` (recursively) through the shared
 * pipeline and writes the changed files back. Used by the CLI and by SubresourceIntegrityInjector.
 *
 * @param {string} outputDir
 * @param {object} [options]  see resolveOptions
 * @returns {Promise<{files: number, diagnostics: object[], errors: string[], warnings: string[], integrityPolicy: object|undefined}>}
 *          `errors`/`warnings` are the same diagnostics as `file: message` strings (NO_HTML is
 *          reported as a diagnostic only, since callers decide whether an empty directory matters).
 */
async function processDirectory(outputDir, options = {}) {
    const config = resolveOptions(options)
    const root = path.resolve(outputDir)
    if (!fs.existsSync(root)) throw new Error(`Output directory not found: ${outputDir}`)

    const htmlFiles = await findFiles(root, name => name.endsWith('.html'))
    const finish = (files, diagnostics) => {
        const text = (severity) => diagnostics.filter(d => d.severity === severity && d.code !== CODES.NO_HTML).map(formatDiagnostic)
        return {
            files, diagnostics, errors: text('error'), warnings: text('warning'),
            integrityPolicy: config.policyHeader || undefined
        }
    }
    if (htmlFiles.length === 0) return finish(0, [noHtmlDiagnostic(`output directory: ${outputDir}`)])

    const base = normalizeBase(config.base)
    const resolveExternal = config.external ? createExternalResolver({ timeout: config.externalTimeout }) : undefined
    // Pages usually share most of their assets, so each file is read once per run.
    const reads = new Map()
    const readOnce = (full) => {
        if (!reads.has(full)) reads.set(full, fsp.readFile(full))
        return reads.get(full)
    }

    const encodings = new Map()
    const unsupported = []
    const loaded = await Promise.all(htmlFiles.map(async (file) => {
        const name = posix(path.relative(root, file))
        const htmlDir = path.posix.dirname(name)
        const resolveAsset = async (url) => {
            const p = outputPathFor(url, base, htmlDir)
            if (p === null || p === '.') throw new Error('potential path traversal, skipping')
            const full = path.join(root, p)
            if (!isInsideDir(root, full)) throw new Error('potential path traversal, skipping')
            try {
                return await readOnce(full)
            } catch (err) {
                if (err.code === 'ENOENT') {
                    throw new Error(`not found at "${full}". Please verify that this file exists in your output directory.`)
                }
                throw err
            }
        }
        const decoded = decodeHtml(await fsp.readFile(file))
        if (!decoded) {
            unsupported.push(error(CODES.UNSUPPORTED_ENCODING, 'is encoded as UTF-16, which sri-injector cannot rewrite; re-save it as UTF-8. The file was left unchanged.', { file: name }))
            return null
        }
        encodings.set(name, decoded.encoding)
        return { name, html: decoded.text, resolveAsset }
    }))
    const pages = loaded.filter(Boolean)

    const headersFile = config.policy && config.policy.headersFile
    const target = headersFile && path.join(root, headersFile)
    const result = await processPages(pages, config, {
        base,
        resolveExternal,
        headersFile: headersFile && {
            read: async () => (fs.existsSync(target) ? fsp.readFile(target, 'utf8') : null),
            write: async (content) => { await fsp.writeFile(target, content) }
        }
    })
    await Promise.all(result.pages.filter(p => p.modified).map(p => fsp.writeFile(path.join(root, p.name), Buffer.from(p.html, encodings.get(p.name)))))

    const diagnostics = [...unsupported, ...result.diagnostics]
    if (config.policy) {
        // Code-split chunks loaded with import() are not in any HTML; without an import map (which
        // needs the bundler's module graph) the header would block them too.
        for (const file of await findFiles(root, name => /\.m?js$/.test(name))) {
            if (/\bimport\s*\(/.test(await fsp.readFile(file, 'utf8'))) {
                diagnostics.push(warning(CODES.DYNAMIC_IMPORT, 'uses dynamic import(); chunks loaded this way have no integrity here and would be blocked by Integrity-Policy. Use the Rollup/Vite plugin, which covers them with an import map.', { file: posix(path.relative(root, file)) }))
            }
        }
    }
    diagnostics.forEach(d => {
        if (d.code === CODES.NO_HTML) return
        ;(d.severity === 'error' ? console.error : console.warn)(`${d.severity === 'error' ? 'Error' : 'Warning'}: ${formatDiagnostic(d)}`)
    })
    return finish(htmlFiles.length, diagnostics)
}

module.exports = { processDirectory }
