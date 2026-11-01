# sri-injector

Injects [Subresource Integrity](https://developer.mozilla.org/en-US/docs/Web/Security/Subresource_Integrity) (`integrity` + `crossorigin`) attributes into `<script>` and `<link>` tags across a build tool's HTML output.

**Why this matters:** SRI is what stops a compromised script from silently running in your users' browsers. If a CDN you depend on (or a self-hosted bundle on a compromised host) is tampered with *after* you ship a page that references it, a browser checking that reference against a pinned hash refuses to load the altered file instead of executing it. That protection only exists for tags that actually carry an `integrity` attribute, so the goal here is to inject one everywhere the SRI spec allows it.

## Install

    npm install sri-injector
    # or
    pnpm add sri-injector

Requires Node.js 18+ when fetching third-party resources (`--external` uses the global `fetch`).

Injects Subresource Integrity (`integrity` + `crossorigin`) into local `<script>`, `<link rel=stylesheet>`, `<link rel=modulepreload>` and `<link rel=preload>` tags (all `as` destinations). `rel` is matched as case-insensitive tokens, so `rel="alternate stylesheet"` counts.

Existing `integrity` attributes are **verified** against the actual bytes and kept if every token matches (whatever the algorithm). A stale, malformed or unsupported value is replaced and reported as a warning, since it means either the asset changed after the hash was written or something rewrote it. Running the tool twice is a no-op the second time.

## CLI (post-build)

    npx sri-injector ./dist [--algo sha384] [--crossorigin anonymous|use-credentials] [--strict] [--base /app/ | https://cdn.example.com/] [--external] [--integrity-policy [enforce|report-only]] [--headers-file _headers]

Pass `--base` when the HTML was built with a non-root Vite/Rollup `base`. With a full URL, assets under it (your own CDN) are hashed instead of being skipped as third-party externals.

Recursively rewrites every `.html` file under the directory. Exits 1 if any local resource is missing or rejected (a failure count is printed; resolvable resources are still rewritten), so a post-build step in webpack/rollup/CI fails rather than shipping HTML without integrity. `--strict` additionally exits 1 when no HTML files are found at all.

## Third-party resources (`--external` / `external: true`)

By default, resources on other hosts (`https://cdn.jsdelivr.net/...`, `//fonts.googleapis.com/...`) are left alone. With `--external` (CLI) or `external: true` (plugin) they are fetched at build time and pinned too, which is the classic SRI use case: if the third party later changes or is compromised, the browser refuses the file.

- Only pin **versioned, immutable URLs** (`lodash@4.17.21/lodash.min.js`). A URL that serves changing content (analytics snippets, `@latest`) will break as soon as it updates.
- You are trusting what the server returns **at build time**. SRI detects later changes; it cannot detect a file that was already tampered with when you pinned it.
- The server must send `Access-Control-Allow-Origin`. Browsers can only verify a cross-origin resource fetched in CORS mode; without that header the tag is left unchanged and a warning is printed, rather than injecting an attribute that would make the browser block the resource.
- Existing `integrity` values on external tags are verified against the fetched bytes, so a changed third-party file shows up as a warning.
- **CORS breaks the page if you get it wrong.** Once `integrity` + `crossorigin` are on a cross-origin tag, the browser loads it only through a CORS-checked request. If the host sends no `Access-Control-Allow-Origin`, the resource is blocked for every visitor. That is why a host without the header is left unchanged with a warning.
- **The URL must be immutable.** SRI assumes the URL always serves the same bytes. Edge variance, A/B tests, personalization or an unversioned "latest" path that updates in place will be blocked, correctly but annoyingly.
- Network errors, timeouts (`--external-timeout`, default 10 s) and 404s are errors and fail a `--strict` run. Builds that must work offline should not enable this.

## Enforcing it: the `Integrity-Policy` header

SRI only protects the tags that carry it. The [`Integrity-Policy`](https://w3c.github.io/webappsec-subresource-integrity/#integrity-policy) response header closes the gap: browsers that support it (Chromium 138+) **block any script request without integrity metadata**, so a script injected without a hash can no longer load. It is an HTTP header, not something that can go in the HTML, so this tool prepares it rather than injecting it:

    npx sri-injector dist --integrity-policy                 # CLI
    sri({ integrityPolicy: true })                           # Rollup / Vite

- **Audit**: any `<script src>` still without integrity after injection (a third-party without CORS, a missing file) becomes an error, because shipping the header alongside it would break the page. The CLI also warns if output JS uses `import()`, since it cannot cover those chunks (the plugin can, via the import map).
- **Vite preview** gets the header automatically, so `vite preview` behaves like production. The dev server does not: it serves un-hashed source modules and the header would block them all.
- **`headersFile: '_headers'`** / `--headers-file _headers` writes the header into a Netlify / Cloudflare Pages `_headers` file in the output (merging with an existing one, including a copy in Vite's `public/`). For nginx, Apache, Vercel and others, copy the header value printed at the end of the run.
- **Roll out safely** with `'report-only'` (`Integrity-Policy-Report-Only`) first; pass `endpoints: ['name']` to send violation reports to a Reporting API endpoint you declare with `Reporting-Endpoints`.

The header only affects scripts the browser fetches; inline scripts are untouched. Scripts that your own JS or a third-party tag manager inserts at runtime without integrity **will** be blocked, and no build-time audit can see those, which is what report-only mode is for.

## Vite plugin

    // vite.config.js
    import sri from 'sri-injector/vite'
    export default { plugins: [sri({ strict: true })] }

`base` and `publicDir` are picked up from Vite's resolved config, so files in `public/` are hashed too. This includes a full-URL `base` (`base: 'https://cdn.example.com/'`): assets under it are recognised as yours and hashed — SRI matters most for CDN-served assets — while scripts on other hosts are still left alone.

## Rollup plugin

Rollup does not emit HTML by itself, so pair this with whatever produces your HTML (e.g. `@rollup/plugin-html`) and list `sri` **last**:

    // rollup.config.mjs
    import html from '@rollup/plugin-html'
    import sri from 'sri-injector/rollup'

    export default {
      input: 'src/main.js',
      output: { dir: 'dist', format: 'es', entryFileNames: '[name]-[hash].js' },
      plugins: [
        html(),                                  // emits index.html referencing the chunks
        sri({ algorithm: 'sha384', strict: true }) // hashes the final bytes, fails the build on problems
      ]
    }

Output:

    <script type="module" src="main-CAZRyBUa.js" integrity="sha384-ICLs…" crossorigin="anonymous"></script>

The plugin runs in `generateBundle` with `order: 'post'`, so it sees the final in-memory chunks and assets after minification and hashing; nothing is read from disk except `publicDir` fallbacks.

Options:

| option      | default    | notes |
|-------------|------------|-------|
| `enabled`   | `true`     | set to `false` to turn the plugin off (for example in a watch build) |
| `algorithm` | `'sha384'` | `sha256`, `sha384` or `sha512` |
| `crossorigin` | `'anonymous'` | `'anonymous'` or `'use-credentials'`, written to tags that have no `crossorigin` (an existing one is kept) |
| `strict`    | `false`    | fail the build if a referenced local resource cannot be resolved, or if the bundle contains no HTML. Otherwise these are Rollup warnings. |
| `base`      | `'/'`      | public base path or full URL (Vite sets this automatically). A URL base marks assets under it as local so they get hashed. |
| `publicDir` | —          | directory checked for files referenced by the HTML but not in the bundle (Vite sets this automatically) |
| `importMap` | `true`     | add an import map `integrity` section covering code-split chunks (see below) |
| `integrityPolicy` | `false` | `true` / `'report-only'` / `{ reportOnly, endpoints, headersFile }` — prepare the Integrity-Policy header (see above) |
| `external`  | `false`    | also fetch and pin third-party resources (see above) |
| `externalTimeout` | `10000` | per-request timeout in ms for `external` |

### Code-split chunks (dynamic `import()`)

Lazy chunks never appear in the HTML, so no tag can carry their hash. The plugin instead emits (or merges into) an import map with an `integrity` section listing every chunk reachable from the page's scripts through static and dynamic imports:

    <script type="importmap">{"integrity":{"/assets/feature-uj-sLryU.js":"sha384-…"}}</script>
    <script type="module" src="/assets/index-DzKX4MZU.js" integrity="sha384-…" crossorigin></script>

Browsers apply those hashes to any module fetch for that URL that has no integrity of its own — `import()`, static imports between chunks, and `modulepreload`. Keys follow `base` (CDN URLs included). The map is placed before the first module script, an existing import map is merged into rather than duplicated, and chunks the HTML already references are left to their tags. Disable with `importMap: false`.

Import-map `integrity` is supported in Chromium 127+ and recent Safari/Firefox; older browsers ignore the unknown key (no protection, no breakage). [es-module-shims](https://github.com/guybedford/es-module-shims) polyfills it if you need coverage there.

Use `strict: true` in CI.

**Multiple outputs and `@vitejs/plugin-legacy`.** A build can have several outputs; `@vitejs/plugin-legacy` builds its legacy chunks in a separate output *before* the output that contains the HTML. The plugin remembers the files of earlier outputs, so the legacy polyfill `<script>` still gets its hash, and it decides whether the build produced any HTML once, when the build closes, so an output with no HTML does not fail `strict`. (The legacy *entry* is loaded through `data-src` by an inline loader, so no tag can carry its hash.)

## webpack plugin

    // webpack.config.js
    const HtmlWebpackPlugin = require('html-webpack-plugin')
    const SriPlugin = require('sri-injector/webpack')

    module.exports = {
      output: { publicPath: '/', filename: '[name].[contenthash].js' },
      plugins: [
        new HtmlWebpackPlugin(),
        new SriPlugin({ algorithm: 'sha384', strict: true })
      ]
    }

It hashes every `.html` asset in the compilation after `html-webpack-plugin` has emitted it, in `processAssets` at `PROCESS_ASSETS_STAGE_OPTIMIZE_TRANSFER`, so the hashes cover the final emitted bytes and the order of `plugins` does not matter. Problems are webpack warnings, or errors with `strict: true`.

Options: `enabled`, `algorithm`, `crossorigin`, `strict`, `base` (defaults to `output.publicPath` when that is a string other than `'auto'`; relative and full-URL public paths work), `external`, `externalTimeout` and `integrityPolicy` (with `headersFile` it emits a `_headers` asset). There is no `importMap` option: see Limitations.

## Examples

`examples/` contains a complete input site and the exact output, with a line-by-line explanation of what happened and why, plus a Rollup bundle showing the import map for code-split chunks. They are also golden-file tests. See `examples/README.md`.

## Core

`injectSri(html, resolveAsset, { algorithm })` is a pure function; `resolveAsset(url)` returns the served bytes (or `null`). Use it to write other adapters.

`new SubresourceIntegrityInjector().insertSRIInHTML(dir, algorithm, { strict })` (the CLI's engine) resolves to `{ files, errors }` — the number of HTML files processed and the per-resource error messages.

## Limitations

- Browsers currently enforce `integrity` on `<link rel=preload>` only for `as=script` and `as=style`; on other destinations (`font`, `image`, `fetch`, …) the attribute is accepted but not checked. A preload is also only *reused* if the consuming request matches it: for `as=fetch` your `fetch()` call must pass the same `integrity` and `mode: 'cors'`; for `as=image` the `<img>` must carry `crossorigin`. Otherwise the browser fetches the resource twice.

- Lazy chunks loaded by dynamic `import()` are covered by the Rollup/Vite plugin's import map (above), not by the CLI, which has no module graph. CSS that Vite injects at runtime for lazy chunks is not covered: `<link>` elements created from JS carry no integrity, and import maps only govern module scripts.
- The webpack plugin covers the tags in your HTML only. Webpack's classic chunk loader creates `<script>` elements at runtime, which import maps do not govern; use [webpack-subresource-integrity](https://github.com/waysact/webpack-subresource-integrity) for lazy chunks, or `output.module` + `chunkLoading: 'import'` with this tool's CLI.
- Inline scripts/styles are not covered (SRI does not apply to them).
- Anything that changes files after this runs (compression that alters content, banners) invalidates hashes.
- Remote hosts need CORS headers for `crossorigin` resources.

## Development

    npm test            # unit, integration and packaging tests
    npm run coverage    # tests with a coverage gate

`npm run coverage` fails if coverage drops below the thresholds in `package.json` (in-process code, measured by Jest's V8 provider) and `.c8rc.json` (the CLI, which runs in child processes, so it is measured with `c8`). The packaging tests run `npm pack`, install the tarball into a clean project and run the installed CLI.
