const { validateAlgorithm } = require('./integrity')
const { normalizeIntegrityPolicy, buildIntegrityPolicyHeader } = require('./policy')


const CROSSORIGIN_VALUES = ['anonymous', 'use-credentials']

function validateCrossorigin(value) {
    if (value === undefined) return 'anonymous'
    if (!CROSSORIGIN_VALUES.includes(value)) {
        throw new Error(`Invalid crossorigin value ${JSON.stringify(value)}. Use one of: ${CROSSORIGIN_VALUES.join(', ')}`)
    }
    return value
}

const KNOWN_OPTIONS = new Set([
    'enabled', 'strict', 'algorithm', 'crossorigin', 'base', 'publicDir',
    'external', 'externalTimeout', 'importMap', 'integrityPolicy'
])

/**
 * The one place user options are validated and defaulted, shared by the CLI, the Rollup/Vite plugin
 * and the webpack plugin. Unknown keys are rejected so a typo (`strcit: true`) cannot silently
 * switch off a safeguard. Returns a frozen object; `policy` and `policyHeader` are derived from
 * `integrityPolicy`.
 */
function resolveOptions(user = {}) {
    const unknown = Object.keys(user).filter(k => !KNOWN_OPTIONS.has(k))
    if (unknown.length) {
        throw new Error(`Unknown option${unknown.length > 1 ? 's' : ''} ${unknown.map(k => JSON.stringify(k)).join(', ')}. Valid options: ${[...KNOWN_OPTIONS].join(', ')}`)
    }
    const timeout = user.externalTimeout
    if (timeout !== undefined && !(Number.isInteger(timeout) && timeout > 0)) {
        throw new Error(`Invalid externalTimeout ${JSON.stringify(timeout)}: must be a positive integer (milliseconds)`)
    }
    const policy = normalizeIntegrityPolicy(user.integrityPolicy)
    return Object.freeze({
        enabled: user.enabled !== false,
        strict: !!user.strict,
        algorithm: validateAlgorithm(user.algorithm === undefined ? 'sha384' : user.algorithm),
        crossorigin: validateCrossorigin(user.crossorigin),
        base: user.base,
        publicDir: user.publicDir,
        external: !!user.external,
        externalTimeout: timeout === undefined ? 10000 : timeout,
        importMap: user.importMap !== false,
        policy,
        policyHeader: policy ? buildIntegrityPolicyHeader(policy) : null
    })
}

module.exports = { validateCrossorigin, resolveOptions }
