const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const { resolveOptions } = require('./options')
const { processPages } = require('./pipeline')
const { warning, error, noHtmlDiagnostic, formatDiagnostic, classify, integrityReplacedMessage, CODES } = require('./diagnostics')
const { checkPage, STATUSES, FAILING } = require('./check')
const { outputPathFor, isInsideDir, normalizeBase, normalizeUrl, isLocalUrl, isExternal } = require('./url')
const { calculateBase64Hash } = require('./integrity')
const { importMapIntegrityKeys } = require('./importmap')
const { findDynamicImports } = require('./dynamic-import')
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
 * Reads every .html file under `root` once, for both modes of the filesystem host. Each page gets a
 * resolver for the files it references (inside the output directory only; each file read once per
 * run). A UTF-16 page cannot be handled and becomes an UNSUPPORTED_ENCODING error instead.
 */
async function loadPages(root, htmlFiles, base) {
    const reads = new Map()
    const readOnce = (full) => {
        if (!reads.has(full)) reads.set(full, fsp.readFile(full))
        return reads.get(full)
    }
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
        return { name, html: decoded.text, encoding: decoded.encoding, resolveAsset }
    }))
    return { pages: loaded.filter(Boolean), unsupported }
}

/** Resolves the options and finds the HTML files: the start of both modes. */
async function openDirectory(outputDir, options) {
    const config = resolveOptions(options)
    const root = path.resolve(outputDir)
    if (!fs.existsSync(root)) throw new Error(`Output directory not found: ${outputDir}`)
    const htmlFiles = await findFiles(root, name => name.endsWith('.html'))
    return { config, root, htmlFiles, base: normalizeBase(config.base) }
}

/**
 * The filesystem host: runs every .html file under `outputDir` (recursively) through the shared
 * pipeline and writes the changed files back. Used by the CLI and by SubresourceIntegrityInjector.
 *
 * With `dryRun: true` (--dry-run) the run is identical (every asset is read and hashed, external
 * resources are fetched, the same diagnostics are produced, worded as what would happen) but nothing
 * is written: neither the HTML files nor the headers file. `changes` then says what a real run would
 * do. `dryRun` is specific to this host, which is why it is taken out here rather than accepted by
 * resolveOptions (the bundler plugins have no use for it and reject it).
 *
 * @param {string} outputDir
 * @param {object} [options]  see resolveOptions, plus `dryRun`
 * @returns {Promise<{files: number, dryRun: boolean, changes: object[], diagnostics: object[], errors: string[], warnings: string[], integrityPolicy: object|undefined}>}
 *          `changes` are `{ file, kind, url? }`: the edits made (or, in a dry run, that would be made)
 *          to each page, plus `update-headers-file` when the headers file's content changes. `errors`/
 *          `warnings` are the same diagnostics as `file: message` strings (NO_HTML is reported as a
 *          diagnostic only, since callers decide whether an empty directory matters).
 */
async function processDirectory(outputDir, options = {}) {
    const { dryRun = false, manifestFile, ...sriOptions } = options
    const { config, root, htmlFiles, base } = await openDirectory(outputDir, sriOptions)
    const finish = (files, diagnostics, changes = []) => {
        const text = (severity) => diagnostics.filter(d => d.severity === severity && d.code !== CODES.NO_HTML).map(formatDiagnostic)
        return {
            files, dryRun: !!dryRun, changes, diagnostics, errors: text('error'), warnings: text('warning'),
            integrityPolicy: config.policyHeader || undefined
        }
    }
    if (htmlFiles.length === 0) {
        // No pages, but the hashes may be all a backend-rendered app needs.
        const change = manifestFile !== undefined && await writeHashManifest(root, manifestFile, config.algorithm, dryRun)
        return finish(0, [noHtmlDiagnostic(`output directory: ${outputDir}`)], change ? [change] : [])
    }

    const resolveExternal = config.external ? createExternalResolver({ timeout: config.externalTimeout }) : undefined
    const { pages, unsupported } = await loadPages(root, htmlFiles, base)
    const encodings = new Map(pages.map(p => [p.name, p.encoding]))

    const headersFile = config.policy && config.policy.headersFile
    const target = headersFile && path.join(root, headersFile)
    const changes = []
    let headersBefore = null
    const result = await processPages(pages, config, {
        base,
        resolveExternal,
        extraDiagnostics: config.policy ? await dynamicImportDiagnostics(root, base, pages, config.policy) : [],
        headersFile: headersFile && {
            read: async () => {
                headersBefore = fs.existsSync(target) ? await fsp.readFile(target, 'utf8') : null
                return headersBefore
            },
            write: async (content) => {
                if (content !== headersBefore) changes.push({ file: posix(headersFile), kind: 'update-headers-file' })
                if (!dryRun) await fsp.writeFile(target, content)
            }
        }
    })
    const modified = result.pages.filter(p => p.modified)
    changes.unshift(...modified.flatMap(p => p.changes))
    if (!dryRun) {
        await Promise.all(modified.map(p => fsp.writeFile(path.join(root, p.name), Buffer.from(p.html, encodings.get(p.name)))))
    }

    if (manifestFile !== undefined) {
        const change = await writeHashManifest(root, manifestFile, config.algorithm, dryRun)
        if (change) changes.push(change)
    }

    // A dry run replaces nothing, so say what would be replaced.
    const worded = dryRun
        ? result.diagnostics.map(d => (d.code === CODES.INTEGRITY_REPLACED ? { ...d, message: integrityReplacedMessage(d.url, d.existing, { preview: true }) } : d))
        : result.diagnostics
    const diagnostics = [...unsupported, ...worded]
    return finish(htmlFiles.length, diagnostics, changes)
}

/**
 * Code-split chunks loaded with import() are in no HTML, and without an import map (which needs the
 * bundler's module graph) the Integrity-Policy header would block them. Reports each JS file whose
 * import() targets are not all covered by an import map "integrity" entry of some page: an error when
 * the policy is enforced (so no header is written), a warning when it is report-only. A target that is
 * not a string literal can never be shown to be covered. Whatever never writes a literal `import(`
 * (webpack's runtime loader) is not seen at all, which the CLI says when it emits the header.
 */
async function dynamicImportDiagnostics(root, base, pages, { reportOnly }) {
    const covered = new Set()
    for (const page of pages) {
        const htmlDir = path.posix.dirname(page.name)
        for (const key of importMapIntegrityKeys(page.html)) {
            const p = outputPathFor(normalizeUrl(key), base, htmlDir)
            if (p !== null) covered.add(p)
        }
    }
    const make = reportOnly ? warning : error
    const found = []
    for (const file of await findFiles(root, name => /\.m?js$/.test(name))) {
        const text = await fsp.readFile(file, 'utf8')
        const { count, literals } = findDynamicImports(text)
        if (count === 0) continue
        const rel = posix(path.relative(root, file))
        const allCovered = literals.length === count && literals.every(spec => {
            // "./x.js" and "../x.js" are relative to this file; "/x.js" (or a URL under `base`) to the output root.
            const p = /^\.{1,2}\//.test(spec)
                ? path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec))
                : spec.startsWith('/') && !spec.startsWith('//') || isLocalUrl(spec, base) && isExternal(spec) ? outputPathFor(spec, base, '') : null
            return p !== null && covered.has(p)
        })
        if (!allCovered) {
            found.push(make(CODES.DYNAMIC_IMPORT, 'uses dynamic import(); chunks loaded this way have no integrity here and would be blocked by Integrity-Policy. Use the Rollup/Vite plugin, which covers them with an import map.', { file: rel }))
        }
    }
    return found
}

/**
 * --manifest-file: writes `{ version, algorithm, files: { "<path relative to outputDir>": "<integrity>" } }`
 * for every file in the output except HTML pages, source maps and the manifest itself, so whatever loads
 * this build at runtime (a microfrontend shell, a backend rendering its own tags) can set `integrity`
 * from the hashes the build just produced. The hashes are of the files as they are now; pages are not
 * subresources, so they are left out. Returns the change to report, or null when the file is already
 * up to date. With `dryRun` nothing is written.
 */
async function writeHashManifest(root, manifestFile, algorithm, dryRun) {
    const target = path.resolve(root, manifestFile)
    if (!isInsideDir(root, target) || target === root) throw new Error(`--manifest-file must be a file inside the output directory: ${manifestFile}`)
    const files = {}
    for (const full of (await findFiles(root, name => !name.endsWith('.html') && !name.endsWith('.map'))).sort()) {
        if (full === target) continue
        files[posix(path.relative(root, full))] = `${algorithm}-${calculateBase64Hash(await fsp.readFile(full), algorithm)}`
    }
    const content = JSON.stringify({ version: 1, algorithm, files }, null, 2) + '\n'
    const existing = fs.existsSync(target) ? await fsp.readFile(target, 'utf8') : null
    if (existing === content) return null
    if (!dryRun) {
        await fsp.mkdir(path.dirname(target), { recursive: true })
        await fsp.writeFile(target, content)
    }
    return { file: posix(path.relative(root, target)), kind: 'update-manifest-file' }
}

/**
 * --check: validates the integrity metadata already in the output, and never writes anything.
 * Every tag a real run protects (and every import map integrity entry) gets one result; see
 * lib/check.js for what each means. Takes the options of a real run so files resolve the same way:
 * `base`, `external`/`externalTimeout` (third-party resources are fetched and verified only with
 * `external`), `integrityPolicy` (a <script> the header would block fails) and `strict` (no HTML
 * fails). `algorithm` and `crossorigin` do not affect the result; the headers file is not examined.
 * Nothing is logged: the caller reports.
 *
 * @param {string} outputDir
 * @param {object} [options]  see resolveOptions
 * @returns {Promise<{files: number, passed: boolean, integrityFound: boolean, results: object[], counts: object, diagnostics: object[]}>}
 *          `results` are checkPage's, each with the page's `file`. `integrityFound` is false when no
 *          examined tag or entry anywhere carries integrity: the tool was most likely never run.
 *          `diagnostics` are page-level problems (unreadable page, invalid import map, no HTML).
 */
async function checkDirectory(outputDir, options = {}) {
    const { config, root, htmlFiles, base } = await openDirectory(outputDir, options)
    const diagnostics = []
    const results = []
    if (htmlFiles.length === 0) {
        diagnostics.push(noHtmlDiagnostic(`output directory: ${outputDir}`))
    } else {
        const resolveExternal = config.external ? createExternalResolver({ timeout: config.externalTimeout }) : undefined
        const { pages, unsupported } = await loadPages(root, htmlFiles, base)
        diagnostics.push(...unsupported.map(d => ({ ...d, message: 'is encoded as UTF-16, which sri-injector cannot read; re-save it as UTF-8.' })))
        for (const page of pages) {
            const r = await checkPage(page.html, page.resolveAsset, { base, resolveExternal, policy: config.policy })
            r.results.forEach(x => results.push({ file: page.name, ...x }))
            r.problems.forEach(message => diagnostics.push(error(CODES.IMPORT_MAP_INVALID, message, { file: page.name })))
        }
    }
    const counts = Object.fromEntries(STATUSES.map(s => [s, results.filter(x => x.status === s).length]))
    const failed = results.some(x => FAILING.has(x.status)) || classify(diagnostics, config).fatal.length > 0
    return {
        files: htmlFiles.length,
        passed: !failed,
        integrityFound: results.some(x => x.hasIntegrity),
        results,
        counts,
        diagnostics
    }
}

module.exports = { processDirectory, checkDirectory }
