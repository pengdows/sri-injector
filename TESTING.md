# Testing sri-injector

Two layers: an automated suite that runs offline in a few seconds, and manual checks for the
things only a real bundler, a real network or a real browser can confirm.

---

## 1. Automated suite

    pnpm install --frozen-lockfile
    pnpm test                      # or: npx jest --verbose

Expected: all suites green, ~5 s. No network is used: third-party fetches run
against an `http` server started inside the test.

| file | covers |
|---|---|
| `__tests__/core.test.js` | pure logic: path containment (`..foo.js` vs `../x`), `rel`/`as` token matching, CDN `base`, verification of existing `integrity` values, `resolveExternal` contract, import-map merging, `Integrity-Policy` header + `_headers` merging |
| `__tests__/index.test.js` | filesystem injector end to end on a temp `dist/` |
| `__tests__/cli.test.js` | spawns the real binary; pins **exit codes** and summary output for every branch |
| `__tests__/rollup.test.js` | plugin against a mocked Rollup `generateBundle` context: bundle lookup, `publicDir`, `base`, chunk graph → import map, `_headers` emission |
| `__tests__/rollup.win32.test.js` | same adapter with `path` mocked to `path.win32`, to reach the `publicDir` guard that is unreachable on POSIX |
| `__tests__/external.test.js` | HTTP resolver: CORS check, gzip, redirects, 404/5xx, timeout, de-duplication, `//host` → `https:` |
| `__tests__/examples.test.js` | golden files: `examples/site` (CLI, before/after of a realistic page) and `examples/rollup-bundle` (plugin, import map + `_headers`) compared byte for byte — see `examples/README.md` |
| `__tests__/hashalgo.test.js` | algorithm enum |

### Confirm the tests have teeth

Every bug-fix test has been observed failing against the code it fixes. To re-check that after
a change, revert only the **source files you changed** (keep the tests) and look for red:

    git stash push -- core.js adapters/rollup.js        # the tracked source files you touched
    npx jest 2>&1 | grep -E "✕|Tests:"                  # expect failures; if it is all green, the tests do not cover the change
    git stash pop

`git stash push -- <paths>` only accepts tracked files; if you added a new source file, stash it
with `git stash push -u -- <path>` or simply `git mv` it aside. Check the stash actually happened
(`git stash list`) before trusting a green result.

Or break one guard deliberately, e.g. delete the `isInsideDir` line in `adapters/rollup.js` and
confirm `rollup.win32.test.js` fails, then restore it.

---

## 2. Manual: CLI on a real build directory

    mkdir -p /tmp/t && cd /tmp/t
    echo 'var x=1;' > app.js
    echo 'body{}'   > app.css
    cat > index.html <<'EOF'
    <html><head>
      <link rel="stylesheet" href="app.css">
      <script src="app.js"></script>
      <script src="missing.js"></script>
    </head><body></body></html>
    EOF

    npx sri-injector . ; echo "exit=$?"

Expect: `integrity`+`crossorigin` on `app.css` and `app.js`, an error line for `missing.js`,
a `❌ … 1 resource(s) could not be processed` summary and **exit 1**. Remove the `missing.js`
line, re-run: `✅` and exit 0. Run a third time: the file must be byte-identical (idempotent).

Verify a hash independently (never trust the tool to check itself):

    echo "sha384-$(openssl dgst -sha384 -binary app.js | base64)"
    grep -o 'app.js"[^>]*integrity="[^"]*"' index.html

Edge cases worth one run each:

    echo 'x' > ..weird.js  && sed -i 's|app.js"|..weird.js"|' index.html && npx sri-injector .
    # must hash it, not report "traversal"; expect one warning: the tag still carried app.js's hash,
    # which is now stale for ..weird.js and gets verified and replaced
    npx sri-injector /tmp/empty-dir ; echo $?            # ⚠️ nothing to do, exit 0
    npx sri-injector /tmp/empty-dir --strict ; echo $?   # ❌ exit 1

---

## 3. Manual: bundlers

Install from a packed tarball, exactly as a consumer would (a symlinked folder hides
missing-dependency and `exports`-map mistakes):

    cd /path/to/sri-injector && npm pack --pack-destination /tmp

### Vite (incl. CDN base, code-splitting, Integrity-Policy)

    mkdir -p /tmp/v/src /tmp/v/public && cd /tmp/v
    npm i vite /tmp/sri-injector-1.0.0.tgz
    echo '<!doctype html><html><head><script type="module" src="/src/main.js"></script></head><body><button id="b">go</button></body></html>' > index.html
    echo 'document.getElementById("b").onclick = () => import("./lazy.js")' > src/main.js
    echo 'export const x = 1' > src/lazy.js
    echo 'window.legacy = 1' > public/legacy.js
    cat > vite.config.mjs <<'EOF'
    import sri from 'sri-injector/vite'
    export default {
      base: 'https://cdn.example.com/',
      plugins: [sri({ strict: true, integrityPolicy: { headersFile: '_headers' } })],
    }
    EOF
    npx vite build && cat dist/index.html && cat dist/_headers

Check, in order:
1. The module script has `integrity` and its URL starts with `https://cdn.example.com/` (CDN
   base is recognised as yours, not skipped as external).
2. A `<script type="importmap">` appears **before** the module script and lists
   `https://cdn.example.com/assets/lazy-*.js` with a hash.
3. `dist/_headers` contains `Integrity-Policy: blocked-destinations=(script), sources=(inline)`.
4. Hashes match disk:

       cd dist && for f in assets/*.js; do echo "$f sha384-$(openssl dgst -sha384 -binary $f | base64)"; done

5. `npx vite preview` then `curl -sI http://localhost:4173/ | grep -i integrity-policy` shows
   the header. (`vite dev` must **not** send it.)
6. Negative: add `<script src="https://www.google-analytics.com/analytics.js"></script>` to
   `index.html` and rebuild — the build must **fail** naming that script, because the header
   would block it.

### Rollup

    mkdir -p /tmp/r/src && cd /tmp/r && npm i rollup @rollup/plugin-html /tmp/sri-injector-1.0.0.tgz
    echo 'console.log(1)' > src/main.js
    cat > rollup.config.mjs <<'EOF'
    import html from '@rollup/plugin-html'
    import sri from 'sri-injector/rollup'
    export default {
      input: 'src/main.js',
      output: { dir: 'dist', format: 'es', entryFileNames: '[name]-[hash].js' },
      plugins: [html(), sri({ strict: true })],
    }
    EOF
    npx rollup -c && cat dist/index.html

Expect `integrity` on the script tag. Remove `html()` and rebuild with `strict: true`: the build
must fail with "No HTML files found in the bundle".

### Webpack (CLI as post-build step)

    # after `webpack` with html-webpack-plugin has written dist/
    npx sri-injector dist --strict
    # if output.publicPath is a CDN URL:
    npx sri-injector dist --strict --base https://cdn.example.com/static/

Without `--base` on a CDN build, count the attributes — it will be 0. (A follow-up to make the
CLI warn on "0 resources protected" is pending.)

---

## 4. Manual: third-party resources (`--external`)

Needs real internet. jsDelivr publishes SRI hashes, so the result can be checked against an
independent source:

    mkdir -p /tmp/e && cd /tmp/e
    echo '<html><head><script src="https://cdn.jsdelivr.net/npm/lodash@4.17.21/lodash.min.js"></script></head></html>' > index.html
    npx sri-injector . --external && grep -o 'integrity="[^"]*"' index.html

Compare with the hash shown at <https://www.jsdelivr.com/package/npm/lodash?version=4.17.21>
(choose "SRI" in the copy menu) — they must be identical.

Then the three behaviours that matter:

| edit `index.html` to reference… | expect |
|---|---|
| a host that sends no CORS header (e.g. `https://www.google-analytics.com/analytics.js`) | tag **unchanged**, `Warning: … Access-Control-Allow-Origin`, exit 0 |
| the lodash URL with a wrong `integrity="sha384-AAAA"` | replaced, `Warning: … did not match` |
| a 404 URL on a real host | `Error: … HTTP 404` / `could not be found`, exit 1 |

---

## 5. Manual: does the browser actually enforce it?

Everything above proves the *attributes* are right. Only a browser proves they *block*.

    cd /tmp/v && npx vite preview --port 4173        # from section 3

1. Open `http://localhost:4173/` in Chrome with DevTools → Console. No errors; button works.
2. **Tamper a top-level asset**: append a space to `dist/assets/index-*.js`, reload. Expect the
   console error *"Failed to find a valid digest in the 'integrity' attribute for resource …"*
   and a dead page. Restore the file.
3. **Tamper a lazy chunk** (import-map coverage; Chrome 127+): append a space to
   `dist/assets/lazy-*.js`, reload, click the button. Expect the same digest error on the dynamic
   import. Restore.
4. **Integrity-Policy** (Chrome 138+): add `<script src="/legacy.js"></script>` **without**
   integrity to `dist/index.html` by hand (simulating a runtime-inserted or forgotten script).
   With the header served (preview does), expect *"… blocked by Integrity-Policy"* in the
   console. Switch the config to `integrityPolicy: 'report-only'`, rebuild: the script loads and
   a report is generated instead.
5. Repeat 2 in Firefox and Safari; repeat 3 and 4 there only if their current versions support
   import-map `integrity` / `Integrity-Policy` (check caniuse; older versions must simply ignore
   them — the page must still work).

---

## 6. Windows

`rollup.win32.test.js` simulates `\` separators by mocking `path`. It is not a substitute for a
real run. On a Windows machine:

    pnpm test
    npx sri-injector dist --strict          # on a real Vite/webpack dist/

and additionally confirm a file named `..foo.js` in `dist/` is hashed rather than rejected.

---

## 7. Release checklist

- [ ] `pnpm test` green
- [ ] `npm pack` → tarball lists no `node_modules`, includes `external.js`, `adapters/`, `bin/`
- [ ] Section 3 Vite run: CDN base hashed, import map present and before the module script, preview sends the header
- [ ] Section 5 step 2 and 3 block in Chrome
- [ ] One run of the CLI over an empty dir with `--strict` exits 1
