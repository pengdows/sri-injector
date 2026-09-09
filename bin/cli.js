#!/usr/bin/env node
const path = require('path')
const SubresourceIntegrityInjector = require('../SubresourceIntegrityInjector')

function parseArgs(argv) {
    const args = {
        dir: null,
        algorithm: 'sha384',
        crossorigin: 'anonymous',
        fetchExternal: true,
        defaultProtocol: 'https:',
        fetchTimeoutMs: 10000,
        help: false,
    }
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        switch (arg) {
            case '--dir':
            case '-d':
                args.dir = argv[++i]
                break
            case '--algorithm':
            case '-a':
                args.algorithm = argv[++i]
                break
            case '--crossorigin':
                args.crossorigin = argv[++i]
                break
            case '--no-fetch-external':
                args.fetchExternal = false
                break
            case '--default-protocol':
                args.defaultProtocol = argv[++i]
                break
            case '--timeout':
                args.fetchTimeoutMs = parseInt(argv[++i], 10)
                break
            case '--help':
            case '-h':
                args.help = true
                break
            default:
                throw new Error(`Unknown argument: ${arg}`)
        }
    }
    return args
}

function printHelp() {
    console.log(`sri-injector - inject Subresource Integrity attributes into built HTML

Usage:
  sri-injector --dir <outputDir> [options]

Options:
  -d, --dir <path>          Build output directory to scan for *.html files (required)
  -a, --algorithm <name>    Hash algorithm to use: sha256, sha384, sha512 (default: sha384)
  --crossorigin <value>     Value for the crossorigin attribute (default: anonymous)
  --no-fetch-external       Do not fetch external (CDN) resources to hash them; skip them instead
  --default-protocol <p>    Protocol used to resolve protocol-relative URLs, e.g. "//cdn..." (default: https:)
  --timeout <ms>            Timeout for fetching an external resource (default: 10000)
  -h, --help                Show this help message
`)
}

async function main() {
    let args
    try {
        args = parseArgs(process.argv.slice(2))
    } catch (e) {
        console.error(e.message)
        process.exitCode = 1
        return
    }

    if (args.help || !args.dir) {
        printHelp()
        process.exitCode = args.dir ? 0 : 1
        return
    }

    let injector
    try {
        injector = new SubresourceIntegrityInjector({
            algorithm: args.algorithm,
            crossorigin: args.crossorigin,
            fetchExternal: args.fetchExternal,
            defaultProtocol: args.defaultProtocol,
            fetchTimeoutMs: args.fetchTimeoutMs,
        })
    } catch (e) {
        console.error(e.message)
        process.exitCode = 1
        return
    }

    const outputDir = path.resolve(process.cwd(), args.dir)
    const report = await injector.insertSRIInDirectory(outputDir)

    console.log(`Processed ${report.processed.length} resource(s).`)
    if (report.skipped.length > 0) {
        console.log(`Skipped ${report.skipped.length} resource(s).`)
    }
    if (report.warnings.length > 0) {
        console.warn(`${report.warnings.length} warning(s):`)
        for (const warning of report.warnings) {
            console.warn(`  ${warning.file ?? ''} ${warning.url ?? warning.src}: ${warning.warning}`)
        }
    }
    if (report.errors.length > 0) {
        console.error(`${report.errors.length} error(s):`)
        for (const err of report.errors) {
            console.error(`  ${err.file ?? ''} ${err.src}: ${err.error}`)
        }
        process.exitCode = 1
    }
}

main()
