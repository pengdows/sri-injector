# sri-injector

Injects [Subresource Integrity](https://developer.mozilla.org/en-US/docs/Web/Security/Subresource_Integrity)
(`integrity` + `crossorigin`) attributes into `<script>` and `<link>` tags
across a build tool's HTML output.

**Why this matters:** SRI is what stops a compromised script from silently
running in your users' browsers. If a CDN you depend on (or a self-hosted
bundle on a compromised host) gets tampered with *after* you ship a page
referencing it, a browser checking that reference against a pinned hash
will refuse to load the altered file instead of executing it. That
protection only exists for tags that actually carry an `integrity`
attribute, so the goal of this tool is to inject one everywhere the SRI
spec allows it — including third-party CDN resources, not just your own
build output.

## Install

```bash
npm install sri-injector
# or
pnpm add sri-injector
```

Requires Node.js 18+ (uses the global `fetch` API to hash external
resources).

## Quick start

### CLI

```bash
npx sri-injector --dir ./dist
```

Run it as a post-build step, e.g. in `package.json`:

```json
{
  "scripts": {
    "build": "vite build && sri-injector --dir dist"
  }
}
```

### API

```js
const SubresourceIntegrityInjector = require('sri-injector/SubresourceIntegrityInjector');

const injector = new SubresourceIntegrityInjector({ algorithm: 'sha384' });
const report = await injector.insertSRIInDirectory('./dist');

console.log(report);
// { processed: [...], skipped: [...], warnings: [...], errors: [...] }
```

`insertSRIInDirectory` recursively scans `outputDir` for every `*.html`
file. Use `insertSRIInFile(htmlFilePath, baseDir)` to process a single
file instead.

## What gets touched

Only tags where the `integrity` attribute is actually meaningful per spec:

- `<script src="...">`
- `<link href="...">` where `rel` is `stylesheet`, `preload`,
  `modulepreload`, or `prefetch`

Every other attribute on the tag is left exactly as it was — order and
all.

## Local vs. external resources

- **Local** (`src="app.js"`, resolved relative to `outputDir`): read from
  disk and hashed directly.
- **External** (`src="https://cdn.example.com/lib.js"` or
  `src="//cdn.example.com/lib.js"`): fetched over HTTP(S) and hashed. This
  is on by default (`fetchExternal: true`) because it's the primary case
  SRI protects — pass `--no-fetch-external` / `{ fetchExternal: false }`
  to skip these instead.
- **`data:` URIs**: always skipped. The content is already inline in the
  HTML, so there's nothing external to protect against.

A resource path that resolves outside `outputDir` (e.g. `src="../../etc/passwd"`)
is rejected rather than read, and reported as an error.

## Important caveat: CORS

Adding `crossorigin="anonymous"` + `integrity` to a cross-origin resource
means the browser will only load it via a CORS-checked request. If the
host serving that resource does **not** send an
`Access-Control-Allow-Origin` header, the browser refuses to load the
resource at all — once these attributes are added, that resource is
**broken for every visitor**, not just protected.

This tool detects that case (it can see the header on the response it
fetched to compute the hash) and adds an entry to `report.warnings`
instead of silently shipping a page that will fail to load in production.
If you see this warning, either confirm the host adds a permissive CORS
header, or self-host that resource instead of pinning it from the CDN.

## Options

| Option (API) | CLI flag | Default | Description |
|---|---|---|---|
| `algorithm` | `-a, --algorithm` | `sha384` | `sha256`, `sha384`, or `sha512`. An unsupported value throws immediately rather than silently falling back. |
| `crossorigin` | `--crossorigin` | `anonymous` | Value written to the `crossorigin` attribute. |
| `fetchExternal` | `--no-fetch-external` | `true` | Whether to fetch and hash external/CDN resources. |
| `defaultProtocol` | `--default-protocol` | `https:` | Protocol used to resolve protocol-relative URLs (`//cdn.example.com/...`). |
| `fetchTimeoutMs` | `--timeout` | `10000` | Timeout (ms) for fetching a single external resource. |
| `lockFilePath` | `--lock-file` | *(disabled)* | See below. |

## Lock file (resilience against CDN blips)

Every build re-fetches every external resource by default. Two problems
follow from that:

1. A transient CDN outage or network hiccup during your build fails the
   whole build, even though nothing about your own code changed.
2. There's no record of what hash you actually shipped last time, making
   it hard to notice if a CDN resource's content changed unexpectedly.

Pass a `lockFilePath` (or `--lock-file <path>`) to fix both: successful
fetches are recorded in that JSON file (keyed by algorithm + URL), and if
a later fetch fails but a cached entry exists, that last-known-good hash
is used instead of failing — with a warning in `report.warnings` so it's
visible, not silent. This never uses a hash for content that wasn't
actually fetched and verified at some point; it just tolerates the fetch
that verifies it happening on a previous run instead of this one.

```bash
npx sri-injector --dir ./dist --lock-file ./sri-lock.json
```

Commit `sri-lock.json` alongside your build config so the fallback
survives across CI runs, and diff it in review — a hash changing for a
CDN URL you didn't touch is worth a second look.

## Another caveat: CDN content must actually be immutable

SRI assumes the URL you reference always serves the same bytes. If a CDN
resource can legitimately vary between the moment you build (and hash it)
and the moment a user's browser loads it — geographic/edge variance,
A/B tests, personalization, an unversioned "latest" path that gets
updated in place — SRI will correctly-but-annoyingly block that load,
because the bytes really did change. Only pin versioned, immutable CDN
URLs (e.g. `.../lib@1.2.3/dist/lib.min.js`, not `.../lib/latest/lib.min.js`).

## Report shape

```js
{
  processed: [{ src, integrity, file?, url?, external?, usedCachedHash? }],
  skipped:   [{ src, reason, file? }], // reason: 'data-uri' | 'fetch-disabled' | 'empty-src'
  warnings:  [{ src, url?, warning, file? }],
  errors:    [{ src, error, url?, file? }],
}
```

`insertSRIInFile` returns this shape for one file; `insertSRIInDirectory`
returns the same shape aggregated across every HTML file found, with each
entry additionally carrying `file`.

The CLI exits non-zero if `report.errors` is non-empty.
