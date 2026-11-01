# Worked examples (input → output)

Each directory is a complete input and the exact output the tool produces from it. They are also
golden-file tests (`__tests__/examples.test.js`): if the output changes, the test fails and the
diff shows precisely what changed.

## `site/` — CLI / filesystem injector

    npx sri-injector examples/site/input   # (run on a copy; it rewrites in place)

`input/index.html` and `input/pages/about.html` → `expected/index.html`, `expected/pages/about.html`
(`sha384`). What each line demonstrates:

| input | what happens | why |
|---|---|---|
| `<link rel="alternate stylesheet" href="/assets/site.css">` | hashed | `rel` is matched as tokens; root-relative resolves against the output dir |
| `<link rel="Stylesheet" href="assets/fonts.css?v=3#frag">` | hashed | case-insensitive `rel`; query/fragment ignored when locating the file |
| `<link rel="preload" as="font" href="/assets/x.woff2">` | hashed | all `preload` destinations |
| `<link rel="modulepreload" href="/assets/lazy.js">` | hashed | |
| `<script src="/assets/vendor.js" integrity="sha256-…">` (correct) | **kept as is** | existing value verified against the file; a valid hash is not rewritten even though the run uses sha384 |
| `<script src="/assets/app.js" integrity="sha384-STALE-VALUE" crossorigin="use-credentials">` | hash replaced, `crossorigin` kept | stale value → replaced and reported in `result.json` as a warning |
| `<script src="/assets/..odd.js">` | hashed | a name that merely starts with `..` is not path traversal |
| `<script src="https://cdn.example.net/analytics.js">` | untouched | external (no `--external`) |
| inline `<script>`, `rel="icon"`, `rel="prefetch"` | untouched | SRI does not apply |
| `pages/about.html`: `href="../assets/site.css"` | hashed, same hash as in index.html | relative URLs resolve from the HTML file's directory |

`expected/result.json` is the injector's return value: `{ files: 2, errors: [], warnings: [one stale hash] }`.

Note the serializer normalises markup (`<!DOCTYPE html>`, `defer=""`, head/html tags joined on one
line). The tool re-serialises the document; it does not patch text in place.

## `rollup-bundle/` — Rollup / Vite plugin

`bundle.json` is the in-memory bundle as `generateBundle` receives it, for a site with
`base: 'https://cdn.example.com/'`, one entry chunk that lazily imports a chunk which statically
imports another, plus an orphan chunk nothing references. Run with
`sri({ strict: true, base: 'https://cdn.example.com/', integrityPolicy: { headersFile: '_headers' } })`.

`expected.index.html` shows:

- CDN URLs under `base` are recognised as the site's own assets and hashed (not skipped as external).
- An import map is inserted **before** the module script whose `integrity` section covers
  `lazy-*.js` and `shared-*.js` — chunks that appear nowhere in the HTML — keyed by their full CDN
  URL. The entry chunk is covered by its own tag and therefore not repeated in the map; the orphan
  is not reachable and not included.
- Vite's bare `crossorigin` attribute on the module script is preserved.

`expected._headers` is the emitted Netlify/Cloudflare file carrying the `Integrity-Policy` header.

## Regenerating

    UPDATE_EXAMPLES=1 npx jest examples

Then read `git diff examples/` before committing. A golden file only certifies that output has not
changed since a person verified it; the hashes here were checked independently with
`openssl dgst -sha384 -binary <file> | base64` when they were first recorded.
