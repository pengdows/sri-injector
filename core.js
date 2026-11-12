// Public entry for the host-agnostic building blocks (`@pengdows/sri-injector/core`). The implementation
// lives in lib/, one module per concern; this barrel keeps the import path stable.
const url = require('./lib/url')
const integrity = require('./lib/integrity')
const policy = require('./lib/policy')
const { injectSri } = require('./lib/html')
const { SkipResource } = require('./lib/errors')
const { validateCrossorigin, resolveOptions } = require('./lib/options')
const diagnostics = require('./lib/diagnostics')
const { processPages } = require('./lib/pipeline')

module.exports = {
    injectSri,
    SkipResource,
    validateCrossorigin,
    resolveOptions,
    processPages,
    ...diagnostics,
    ...url,
    ...integrity,
    ...policy,
}
