// Runs a real Rolldown build in a child process (Rolldown is ESM-only, which Jest's CommonJS runtime cannot import).
// Usage: node rolldown-build.mjs <root> <json options for the sri plugin> [urlPrefix]
// Prints { files: { [fileName]: text }, html } as JSON on stdout.
import { createRequire } from 'node:module'
import path from 'node:path'
import { rolldown } from 'rolldown'

const require = createRequire(import.meta.url)
const sri = require('../../adapters/rollup.js')
const [root, optionsJson = '{}', prefix = '/'] = process.argv.slice(2)

// Rolldown has no @rollup/plugin-html equivalent, so a tiny plugin emits the page.
const page = {
  name: 'emit-page',
  generateBundle(_o, bundle) {
    const entry = Object.values(bundle).find(o => o.type === 'chunk' && o.isEntry)
    this.emitFile({
      type: 'asset',
      fileName: 'index.html',
      source: `<html><head><script type="module" src="${prefix}${entry.fileName}"></script></head></html>`,
    })
  },
}

try {
  const bundle = await rolldown({ input: path.join(root, 'main.js'), plugins: [page, sri(JSON.parse(optionsJson))] })
  const { output } = await bundle.generate({ dir: path.join(root, 'dist'), format: 'es' })
  await bundle.close()
  const files = Object.fromEntries(output.map(o => [o.fileName, o.type === 'chunk' ? o.code : String(o.source)]))
  console.log(JSON.stringify({ files, html: files['index.html'] }))
} catch (err) {
  console.error('BUILD FAILED: ' + err.message)
  process.exit(1)
}
