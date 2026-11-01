# sri-injector

Injects Subresource Integrity (`integrity` + `crossorigin`) into local `<script>`, `<link rel=stylesheet|preload|modulepreload>` tags.

## CLI (post-build)

    npx sri-injector ./dist [--algo sha384] [--strict]

Recursively rewrites every `.html` file under the directory. `--strict` exits 1 if a local resource is missing.

## Vite / Rollup plugin

    // vite.config.js
    const sri = require('sri-injector/vite')
    module.exports = { plugins: [sri({ strict: true })] }

Runs in `generateBundle` (order `post`), hashing the final in-memory chunks/assets. Options: `algorithm`, `strict`, `base`, `publicDir`. Put it after any plugin that emits or rewrites HTML/assets.

## Core

`injectSri(html, resolveAsset, { algorithm })` is a pure function; `resolveAsset(url)` returns the served bytes (or `null`). Use it to write other adapters.

## Limitations

- Lazy chunks loaded by dynamic `import()` are not in the HTML and get no integrity.
- Inline scripts/styles are not covered (SRI does not apply to them).
- Anything that changes files after this runs (compression that alters content, banners) invalidates hashes.
- Remote hosts need CORS headers for `crossorigin` resources.
