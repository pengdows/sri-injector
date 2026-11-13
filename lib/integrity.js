const crypto = require('crypto')
const HashAlgos = require('../HashAlgo')

function validateAlgorithm(name) {
    if (typeof name !== 'string' || !Object.hasOwn(HashAlgos, name)) {
        throw new Error(`Unsupported hash algorithm "${name}". Use one of: ${Object.keys(HashAlgos).join(', ')}`)
    }
    return HashAlgos[name]
}

function calculateBase64Hash(content, algorithm) {
    return crypto.createHash(algorithm).update(content).digest('base64')
}

/**
 * Parses an SRI attribute value ("sha384-abc sha512-def?opt") into [{ algorithm, digest }].
 * Returns [] for an empty value and null if any token is malformed or uses an unsupported algorithm.
 */
function parseIntegrity(value) {
    const tokens = (value || '').trim().split(/\s+/).filter(Boolean)
    const parsed = []
    for (const token of tokens) {
        const m = /^(sha256|sha384|sha512)-([A-Za-z0-9+/_-]+={0,2})(\?.*)?$/.exec(token)
        if (!m) return null
        parsed.push({ algorithm: m[1], digest: m[2] })
    }
    return parsed
}

/** Digests may be base64 or base64url, padded or not; compares on the canonical base64 form. */
const canonicalDigest = (digest) => digest.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/')

/**
 * True when `value` is a non-empty SRI attribute that holds up against `content`: for every
 * algorithm that appears, at least one of its tokens matches (several tokens of one algorithm are
 * alternatives, as in browsers). Stricter than browsers, which only consult the strongest
 * algorithm present: a stale token of another algorithm means the attribute is wrong and should
 * be regenerated.
 */
function verifyIntegrity(value, content) {
    const parsed = parseIntegrity(value)
    if (!parsed || parsed.length === 0) return false
    const matched = new Map()
    for (const { algorithm, digest } of parsed) {
        const hit = canonicalDigest(calculateBase64Hash(content, algorithm)) === canonicalDigest(digest)
        matched.set(algorithm, matched.get(algorithm) || hit)
    }
    return [...matched.values()].every(Boolean)
}

module.exports = { validateAlgorithm, calculateBase64Hash, parseIntegrity, verifyIntegrity }
