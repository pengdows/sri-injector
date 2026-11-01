const crypto = require('crypto')
const HashAlgos = require('../HashAlgo')

function validateAlgorithm(name) {
    const selected = HashAlgos[name]
    if (!selected) {
        throw new Error(`Unsupported hash algorithm "${name}". Use one of: ${Object.keys(HashAlgos).join(', ')}`)
    }
    return selected
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
        const m = /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})(\?.*)?$/.exec(token)
        if (!m) return null
        parsed.push({ algorithm: m[1], digest: m[2] })
    }
    return parsed
}

/**
 * True when `value` is a non-empty SRI attribute whose every token matches `content`.
 * Stricter than browsers (which only consult the strongest algorithm present): a stale token
 * anywhere means the attribute is wrong and should be regenerated.
 */
function verifyIntegrity(value, content) {
    const parsed = parseIntegrity(value)
    if (!parsed || parsed.length === 0) return false
    return parsed.every(({ algorithm, digest }) => calculateBase64Hash(content, algorithm) === digest)
}

module.exports = { validateAlgorithm, calculateBase64Hash, parseIntegrity, verifyIntegrity }
