// The remote's entry. It renders itself, then lazy-loads a nested widget with import():
// that chunk is in no HTML, so only the import map the shell builds can protect it.
const mount = document.getElementById('remote-root')
mount.innerHTML = '<h2>Remote loaded</h2><div id="widget">loading widget…</div>'
import('./widget.js').then(({ render }) => render(document.getElementById('widget')))
