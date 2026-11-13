# Microfrontend shell and remote

A shell that loads a remote at runtime and checks it with SRI. There is no HTML for the tool to rewrite
(the shell creates the tags itself), so the build writes the hashes to a file and the shell applies them.

- `remote/`: a plain-JS remote with a lazy chunk nested inside a lazy chunk (no build step).
- `shell/shell.js`: about 15 lines that read `sri-manifest.json` and set `integrity` on the tags it creates,
  plus an import map `integrity` section for the remote's own `import()` chunks.
- `server.js`: serves the shell on :5000 and the remote on :5001 (cross-origin, with CORS).

Run it:

    cp -r examples/microfrontend/remote /tmp/remote
    node bin/cli.js /tmp/remote --manifest-file sri-manifest.json
    node examples/microfrontend/server.js /tmp/remote

Open http://localhost:5000/ and click "Load remote". Then change `/tmp/remote/assets/leaf.js` and reload: the
browser blocks it ("Failed to find a valid digest in the 'integrity' attribute") and the leaf never renders.

What it does not cover: the manifest is only as trustworthy as where it is served from. If one compromised
host serves both the scripts and the manifest, an attacker can change both. The remote must send
`Access-Control-Allow-Origin`, and import map `integrity` needs Chrome/Edge 127, Safari 18 or Firefox 138.
The remote has no HTML, so the CLI reports "No HTML files found" (a warning, exit 0) and still writes the manifest.
