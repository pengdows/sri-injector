export function render(el) {
  el.innerHTML = '<p>widget (lazy chunk)</p><div id="leaf"></div>'
  import('./leaf.js').then(m => m.render(el.querySelector('#leaf')))
}
