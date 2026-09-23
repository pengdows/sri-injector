# SRI Injector

## Mandatory Workflow And Reviews

- TDD is mandatory for every behavior change, bug fix, regression fix, and public-contract change.
- Start by writing or updating an automated test that fails for the intended reason before changing implementation.
- Do not start implementation until the test is red; after implementation, rerun the relevant automated tests and do not consider the work complete until they pass with no skipped tests introduced.
- If automated coverage is genuinely not possible, say so explicitly and document the verification gap.
- All reviews are done against [REVIEW_POLICY.md](./REVIEW_POLICY.md).
- Review output, merge guidance, blocker/major/minor classification, required evidence, and minimal patch guidance must follow [REVIEW_POLICY.md](./REVIEW_POLICY.md).
- If instructions overlap, follow the more stringent requirement. If this file conflicts with [REVIEW_POLICY.md](./REVIEW_POLICY.md) on review behavior, follow [REVIEW_POLICY.md](./REVIEW_POLICY.md).

A Node.js utility for injecting Subresource Integrity (SRI) attributes into HTML files. It scans for `<script>` and `<link>` tags, calculates the base64 hash of the linked resources, and appends the `integrity` and `crossorigin` attributes.

## Project Overview

- **Core Logic:** `SubresourceIntegrityInjector.js` contains the main class for processing HTML files.
- **Entry Point:** `index.js` provides an example of how to use the injector.
- **Configuration:** `HashAlgo.js` defines supported hash algorithms (currently `sha384` and `sha512`).
- **Dependencies:** Uses `fs-extra` for file operations and Node's built-in `crypto` module for hashing.

## Building and Running

### Prerequisites

- Node.js (v16+ recommended)
- pnpm (or npm/yarn)

### Installation

```bash
pnpm install
```

### Running the Example

```bash
node index.js
```
*Note: Ensure you have a `dist/index.html` file and corresponding assets before running the example.*

### Testing

```bash
npm test
```
*Note: The project uses Jest for testing. Currently, one test case for link tags is known to fail due to regex limitations and mismatched expectations.*

## Development Conventions

### Coding Style
- Uses CommonJS modules (`require`/`module.exports`).
- Employs a class-based structure for the injector.
- Regex-based HTML parsing (Note: This is currently brittle and does not preserve existing attributes other than the one being targeted).

### Testing Practices
- Tests are located in the `__tests__` directory.
- Jest is used as the test runner.
- Mocking is done by creating temporary file structures in `__tests__/test_dist`.

## Roadmap to Version 1.0

The project is approximately 75% complete. The core hashing logic is solid, but the HTML manipulation needs to be made "production-ready" to avoid breaking existing websites.

### Phase 1: Critical Fixes (High Priority)
- [ ] **Preserve Existing Attributes:** Currently, `replaceTags` overwrites the entire tag, causing the loss of critical attributes like `async`, `defer`, `type="module"`, or custom `data-*` attributes. 
    - *Goal:* Capture all existing attributes and re-insert them alongside the new `integrity` and `crossorigin` fields.
- [ ] **Fix Test Suite:** Resolve the mismatch in `__tests__/index.test.js` where the test expects `<link src="..."` but the code (correctly) uses `<link href="..."`.
- [ ] **Handle Self-Closing Tags:** Improve regex or parsing to handle variations in self-closing tags (e.g., `<script src="..."/>` vs `<script src="..."></script>`) and varying whitespace.

### Phase 2: Feature Completion (Medium Priority)
- [ ] **Multi-file Support:** Instead of only targeting `index.html`, scan the entire `outputDir` for all `.html` files.
- [ ] **CLI Interface:** Implement a basic CLI using `process.argv` or a library like `commander` so the tool can be run directly from the terminal (e.g., `sri-injector ./dist --algo sha512`).
- [ ] **Skip Already Hashed Tags:** Add logic to detect if a tag already has an `integrity` attribute and skip it (or update it) to avoid duplicate attributes.

### Phase 3: Robustness (Low Priority)
- [ ] **Switch to HTML Parser:** Evaluate replacing the regex-based replacement with a dedicated, lightweight HTML parser (like `cheerio` or `linkedom`) to eliminate "brittle" string matching entirely.
- [ ] **Enhanced Error Logging:** Provide clearer feedback if a linked file is missing from the `outputDir` instead of throwing a generic file-not-found error.
