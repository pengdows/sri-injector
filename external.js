const { SkipResource } = require('./core')

// Sent with every request so servers with dynamic CORS (Vary: Origin) answer with a header.
// The real page origin is unknown at build time; public CDNs answer "*" or echo whatever is sent.
const PROBE_ORIGIN = 'https://sri-injector.invalid'

/**
 * Builds a resolver that fetches third-party resources so they can be pinned with SRI.
 *
 * Behaviour:
 *  - http(s) and protocol-relative URLs are fetched (protocol-relative over https).
 *  - The response must carry Access-Control-Allow-Origin: browsers can only verify integrity on a
 *    cross-origin resource in CORS mode, so injecting without it would make the browser block the
 *    resource. Missing CORS => SkipResource (tag left alone, warning).
 *  - 404 => null (reported as "could not be found"); other non-2xx, network errors and timeouts throw.
 *  - Compressed bodies are decoded (browsers hash the decoded bytes).
 *  - Each URL is fetched once per resolver.
 *
 * @param {{timeout?: number, fetch?: typeof fetch}} [options]
 * @returns {(url: string) => Promise<Buffer|null>}
 */
function createExternalResolver({ timeout = 10000, fetch: fetchImpl } = {}) {
    const doFetch = fetchImpl || globalThis.fetch
    if (typeof doFetch !== 'function') {
        throw new Error('Fetching external resources requires Node 18+ (global fetch)')
    }
    const inflight = new Map()

    async function fetchOnce(url) {
        const target = url.startsWith('//') ? 'https:' + url : url
        if (!/^https?:\/\//i.test(target)) {
            throw new SkipResource(`unsupported URL scheme for external resources`)
        }

        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeout)
        let res
        try {
            res = await doFetch(target, {
                redirect: 'follow',
                signal: controller.signal,
                headers: { Origin: PROBE_ORIGIN, Accept: '*/*' }
            })
        } catch (err) {
            if (controller.signal.aborted) throw new Error(`request timed out after ${timeout} ms`)
            // Node reports every network failure as a bare "fetch failed"; the reason is in `cause`.
            const cause = err && err.cause
            throw new Error(cause ? `${err.message} (${cause.message || cause.code || cause})` : err.message)
        } finally {
            clearTimeout(timer)
        }

        if (res.status === 404) return null
        if (!res.ok) throw new Error(`server responded with HTTP ${res.status}`)

        const acao = res.headers.get('access-control-allow-origin')
        if (acao !== '*' && acao !== PROBE_ORIGIN) {
            throw new SkipResource(
                'server sends no usable Access-Control-Allow-Origin header, so browsers could not verify integrity; tag left unchanged'
            )
        }

        return Buffer.from(await res.arrayBuffer())
    }

    return (url) => {
        if (!inflight.has(url)) inflight.set(url, fetchOnce(url))
        return inflight.get(url)
    }
}

module.exports = { createExternalResolver }
