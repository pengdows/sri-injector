# Security policy

## Supported versions

Only the latest `0.9.x` release of `@pengdows/sri-injector` receives security fixes.

## Reporting a vulnerability

Please report it privately by email to **software@pengdows.com**. Do not open a public issue or pull request for a security problem, since that discloses it before there is a fix.

Include, as far as you can:

- the version of `@pengdows/sri-injector` and of the bundler (Vite, Rollup, webpack, Rspack or Rolldown) you use,
- the smallest input that reproduces it (an HTML file and the assets it references is usually enough),
- what you expected, what happened, and the impact you see.

## What to expect

This is a small project, so these are goals, not guarantees:

- an acknowledgement within 5 business days,
- an assessment and a plan, or a request for more detail, soon after,
- a fix released as quickly as the problem warrants, then public disclosure. We will credit you unless you prefer not to be named.

When a fix changes the security posture of people who use the tool, we publish a GitHub security advisory. We request a CVE only when one is warranted.

## What counts as a vulnerability

This tool runs in your build and rewrites the HTML you ship, so we treat these as security problems:

- **Wrong protection:** a hash that does not match the file the browser will fetch, or a tag that should have received `integrity` and silently did not.
- **File access outside the output directory:** path traversal, or reading or writing files it should not.
- **Network behavior of `--external` and `external: true`:** fetching URLs it should not, following redirects somewhere it should not, or accepting a response it should reject.
- **Output that changes the page's behavior** beyond adding `integrity`, `crossorigin` and the import map.

## What does not

- The limitations documented in the README, such as lazy webpack chunks, scripts inserted at runtime, workers, and browsers that ignore SRI.
- A third-party file that was already tampered with when it was pinned: SRI detects later changes, not earlier ones.
- Bugs in your bundler, your server, or a CDN, or a missing `Integrity-Policy` header you chose not to send.
- Vulnerabilities in a dependency that do not affect this package. Report those upstream.

## Verifying a release

Releases are published to npm by Pengdows LLC. Once releases are published with provenance, you can check one with `npm audit signatures`.
