# Changelog

## 1.0.0

First stable release. The public API (the CLI flags, the plugin options, the `index`, `core` and `external` exports and their types, and the diagnostic codes) now follows semantic versioning.

### Behaviour changes since 0.9.0

- **The CLI no longer writes an enforcing `Integrity-Policy` header over uncovered `import()` calls.** With `--integrity-policy`, a JS file whose `import()` targets are not all covered by a page's import map `integrity` section is an error (exit 1, no headers file written). With `--integrity-policy-report-only` it is a warning and the header is still written. The CLI prints a caveat whenever it emits an enforcing header, since it cannot see loaders that never write a literal `import(`.
- **The `import()` scan reads tokens** (with `acorn`, a new runtime dependency), so `import(` in a string, template text, regex or comment, or a method call such as `obj.import(`, is not a dynamic import.
- **CLI flag conflicts are errors.** `--integrity-policy` with `--integrity-policy-report-only`, and `--headers-file` without a policy flag, now fail instead of being silently reinterpreted or ignored.
- **The library no longer writes to the console.** `SubresourceIntegrityInjector` returns `errors` and `warnings`; the CLI prints them. With `strict`, the thrown error carries `warnings`.
- **Existing `integrity` values are judged the way browsers do:** several tokens of one algorithm are alternatives (any may match), and base64url digests are accepted. A stale token of a different algorithm is still replaced.

### Fixes

- External tags with `crossorigin="use-credentials"`, and external servers that send `Vary: User-Agent` (such as Google Fonts CSS), are skipped with a warning instead of being pinned with a hash the browser would reject. `--check` treats the first the same way.
- webpack: the plugin runs one stage before `PROCESS_ASSETS_STAGE_OPTIMIZE_TRANSFER`, so `.gz` and `.br` copies made by compression plugins carry the SRI whichever plugin is listed first. `new Worker(new URL(...))` entry chunks are no longer reported as unprotected.
- `<script>` elements that never execute (`type="application/ld+json"`, `text/template`, and so on) are not treated as subresources.
- URL attributes are read as the URL parser reads them: surrounding whitespace, embedded tabs and newlines, and backslashes.
- Prototype names such as `constructor` are rejected as hash algorithms with the usual "Unsupported hash algorithm" error.
- Root-relative `import()` targets are resolved from the output root and respect `base`.

### Added since 0.9.0

- `--check`: validates the integrity already in the output without writing anything.
- `--manifest-file`: writes the hash of every output file for shells and backends that load a build at runtime.
- Vite manifest integrity and a warning for lazy stylesheets in the Rollup/Vite plugin.
