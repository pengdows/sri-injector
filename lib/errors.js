
/**
 * Thrown by a resolver to say "this resource cannot be given integrity, but that is not a failure"
 * (e.g. a third-party server without CORS headers). Recorded as a warning; the tag is left untouched.
 */
class SkipResource extends Error {
    constructor(reason) {
        super(reason)
        this.name = 'SkipResource'
    }
}

module.exports = { SkipResource }
