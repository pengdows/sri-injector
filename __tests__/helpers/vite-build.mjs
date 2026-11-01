// Runs a real Vite build in a child process (Vite 8 is ESM-only, which Jest's CommonJS runtime cannot import).
// Usage: node vite-build.mjs <root> <mode>   mode: "legacy" | "plain" | "lib"
import { createRequire } from 'node:module'
import path from 'node:path'
import { build } from 'vite'
import legacy from '@vitejs/plugin-legacy'

const require = createRequire(import.meta.url)
const sri = require('../../adapters/rollup.js')
const [root, mode] = process.argv.slice(2)

const config = {
  root,
  logLevel: 'warn',
  build: { outDir: 'dist', emptyOutDir: true },
  plugins: [sri({ strict: true })],
}
if (mode === 'legacy') config.plugins.unshift(legacy({ targets: ['defaults', 'ie >= 11'] }))
if (mode === 'lib') config.build.lib = { entry: path.join(root, 'src/main.js'), formats: ['es'], fileName: 'lib' }

try {
  await build(config)
} catch (err) {
  console.error('BUILD FAILED: ' + err.message)
  process.exit(1)
}
