const { SkipResource } = require('./lib/errors')

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

        // One timer covers headers *and* body: a server that sends headers and then stalls must
        // not hang the build. The race also guards implementations whose body read ignores `signal`.
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeout)
        const aborted = new Promise((_, reject) => {
            controller.signal.addEventListener('abort', () => reject(new Error('aborted')))
        })
        aborted.catch(() => {}) // never leave this rejection unhandled
        try {
            const res = await Promise.race([
                doFetch(target, {
                    redirect: 'follow',
                    signal: controller.signal,
                    headers: { Origin: PROBE_ORIGIN, Accept: '*/*' }
                }),
                aborted
            ])

            if (res.status === 404) return null
            if (!res.ok) throw new Error(`server responded with HTTP ${res.status}`)

            // Servers that tailor the body to the client (fonts.googleapis.com sends different CSS per
            // browser) would pin what Node was sent, which no real browser receives.
            if (/(^|,)\s*user-agent\s*(,|$)/i.test(res.headers.get('vary') || '')) {
                throw new SkipResource('server varies its response by User-Agent, so the bytes Node receives are not what browsers receive; tag left unchanged')
            }

            const acao = res.headers.get('access-control-allow-origin')
            if (acao !== '*' && acao !== PROBE_ORIGIN) {
                throw new SkipResource(
                    'server sends no usable Access-Control-Allow-Origin header, so browsers could not verify integrity; tag left unchanged'
                )
            }

            return Buffer.from(await Promise.race([res.arrayBuffer(), aborted]))
        } catch (err) {
            if (controller.signal.aborted) throw new Error(`request timed out after ${timeout} ms`)
            // Node reports every network failure as a bare "fetch failed"; the reason is in `cause`.
            const cause = err && err.cause
            if (cause) throw new Error(`${err.message} (${cause.message || cause.code || cause})`)
            throw err
        } finally {
            clearTimeout(timer)
        }
    }

    return (url) => {
        if (!inflight.has(url)) inflight.set(url, fetchOnce(url))
        return inflight.get(url)
    }
}

module.exports = { createExternalResolver }
