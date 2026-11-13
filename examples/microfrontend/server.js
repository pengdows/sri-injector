// Serves the shell on :5000 and a built remote on :5001 (a different origin, with CORS, like a real remote).
//   cp -r examples/microfrontend/remote /tmp/remote
//   node bin/cli.js /tmp/remote --manifest-file sri-manifest.json
//   node examples/microfrontend/server.js /tmp/remote
const http = require('http'), fs = require('fs'), path = require('path')
const types = { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.html': 'text/html' }
const remoteDir = path.resolve(process.argv[2] || path.join(__dirname, 'remote'))
for (const [port, dir] of [[5000, path.join(__dirname, 'shell')], [5001, remoteDir]]) {
  http.createServer((req, res) => {
    const file = path.join(dir, decodeURIComponent(req.url.split('?')[0]).replace(/\/$/, '/index.html'))
    if (!file.startsWith(dir)) { res.writeHead(403); return res.end() }
    fs.readFile(file, (err, body) => {
      if (err) { res.writeHead(404); return res.end() }
      res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'access-control-allow-origin': '*' })
      res.end(body)
    })
  }).listen(port, () => console.log(`${path.basename(dir)} on http://localhost:${port}/`))
}
