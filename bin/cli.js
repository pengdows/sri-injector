#!/usr/bin/env node
const path = require('path')
const SubresourceIntegrityInjector = require('../SubresourceIntegrityInjector')

function parseArgs(argv) {
    const args = { dir: null, algorithm: 'sha384', crossorigin: 'anonymous', help: false }
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
  sri-injector --dir <outputDir> [--algorithm sha256|sha384|sha512] [--crossorigin anonymous|use-credentials]

Options:
  -d, --dir <path>          Build output directory to scan for *.html files (required)
  -a, --algorithm <name>    Hash algorithm to use (default: sha384)
  --crossorigin <value>     Value for the crossorigin attribute (default: anonymous)
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
        })
    } catch (e) {
        console.error(e.message)
        process.exitCode = 1
        return
    }

    const outputDir = path.resolve(process.cwd(), args.dir)
    const report = await injector.insertSRIInDirectory(outputDir)

    console.log(`Processed ${report.processed.length} resource(s).`)
    if (report.skippedExternal.length > 0) {
        console.log(`Skipped ${report.skippedExternal.length} external resource(s).`)
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
