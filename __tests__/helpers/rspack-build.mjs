// Runs a real Rspack build in a child process (Rspack 2 is ESM-only, which Jest's CommonJS runtime cannot import).
// Usage: node rspack-build.mjs <root> <json options for the sri plugin>
// Prints the build's errors and warnings as JSON on stdout.
import { createRequire } from 'node:module'
import path from 'node:path'
import { rspack } from '@rspack/core'
import HtmlRspackPlugin from 'html-rspack-plugin'

const require = createRequire(import.meta.url)
const Sri = require('../../adapters/webpack.js')
const [root, optionsJson = '{}'] = process.argv.slice(2)

const compiler = rspack({
  mode: 'production',
  context: root,
  entry: './src/index.js',
  devtool: false,
  output: { path: path.join(root, 'dist'), filename: '[name].[contenthash].js', publicPath: '/' },
  plugins: [new HtmlRspackPlugin({ inject: 'head' }), new Sri(JSON.parse(optionsJson))],
})

compiler.run((err, stats) => {
  if (err) {
    console.error('BUILD FAILED: ' + err.message)
    process.exit(1)
  }
  const { errors, warnings } = stats.toJson({ all: false, errors: true, warnings: true })
  console.log(JSON.stringify({ errors: errors.map(e => e.message), warnings: warnings.map(w => w.message) }))
  compiler.close(() => {})
})
