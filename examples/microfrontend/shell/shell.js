// How a shell applies the hashes. `entry.json` is this example's own tiny manifest (which file starts
// the remote); in your shell it is whatever manifest you already read. `sri-manifest.json` is what
// `sri-injector --manifest-file` writes.
const REMOTE = 'http://localhost:5001/'
const status = (text) => { document.getElementById('status').textContent = text }

async function loadRemote(origin) {
  const entry = await (await fetch(origin + 'entry.json')).json()
  const { files } = await (await fetch(origin + 'sri-manifest.json')).json()

  // 1. The remote's own import() chunks are in no tag: give them their hashes through an import map.
  //    It must be added before the first module from the remote loads.
  const integrity = Object.fromEntries(Object.entries(files).filter(([f]) => f.endsWith('.js')).map(([f, h]) => [origin + f, h]))
  const map = Object.assign(document.createElement('script'), { type: 'importmap', textContent: JSON.stringify({ integrity }) })
  document.head.append(map)

  // 2. Stylesheets and the entry script carry their own hash. The remote must send
  //    Access-Control-Allow-Origin, or the browser refuses to check the hash.
  for (const css of entry.css || []) {
    document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: origin + css, integrity: files[css], crossOrigin: 'anonymous' }))
  }
  await new Promise((resolve, reject) => {
    document.head.append(Object.assign(document.createElement('script'), {
      type: 'module', src: origin + entry.file, integrity: files[entry.file], crossOrigin: 'anonymous',
      onload: resolve, onerror: () => reject(new Error('blocked or failed to load ' + entry.file)),
    }))
  })
}

// "loaded" only means the entry script passed its check. The remote's lazy chunks load later, from
// inside the remote, so a blocked chunk shows up as an error there, not here.
document.getElementById('load').onclick = () => loadRemote(REMOTE).then(() => status('loaded'), (e) => status('ERROR: ' + e.message))
