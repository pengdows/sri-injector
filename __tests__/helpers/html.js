// Small helpers shared by the adapter tests.
const crypto = require('crypto');

/** The SRI value for some bytes, e.g. integrity('sha384', buf) -> "sha384-...". */
const integrity = (algo, bytes) => `${algo}-${crypto.createHash(algo).update(bytes).digest('base64')}`;

/** Every opening <script ...> tag in an HTML string. */
const scriptTags = (html) => [...html.matchAll(/<script[^>]*>/g)].map(m => m[0]);

/** An attribute's value from one tag, quoted or not (minifiers drop the quotes). */
const attr = (tag, name) => (new RegExp(`${name}="?([^" >]*)"?`).exec(tag) || [])[1];

module.exports = { integrity, scriptTags, attr };
