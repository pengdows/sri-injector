const parse5 = require('parse5')

/**
 * A parsed HTML page that is edited as text. The page is parsed once, with source positions, to find
 * elements and attributes; changes are recorded as replacements of exact character ranges of the
 * original string and applied together at the end. Everything not named by an edit (case, quoting,
 * whitespace, comments, entities, line endings, doctype) therefore stays byte-for-byte as written,
 * which re-serializing a parsed tree cannot guarantee.
 */
class HtmlDocument {
    constructor(html) {
        this.html = html
        // scriptingEnabled: false parses <noscript> content as elements, so <link>s inside it are found
        this.root = parse5.parse(html, { sourceCodeLocationInfo: true, scriptingEnabled: false })
        this.edits = []
        this.seq = 0
    }

    /** Every element, in document order (including the contents of <template>). */
    elements() {
        const found = []
        const visit = (node) => {
            if (node.tagName) found.push(new Tag(this, node))
            for (const child of node.childNodes || []) visit(child)
            if (node.content) visit(node.content)
        }
        visit(this.root)
        return found
    }

    /** Replaces html[start, end) with `text` (start === end inserts). */
    edit(start, end, text) {
        this.edits.push({ start, end, text, seq: this.seq++ })
    }

    get modified() {
        return this.edits.length > 0
    }

    /** Where to put new markup at the end of <head>: before </head>, else as early in the page as is valid. */
    headEndOffset() {
        const tags = this.elements()
        const head = tags.find(t => t.name === 'head' && t.loc)
        if (head && head.loc.endTag) return head.loc.endTag.startOffset
        if (head && head.loc.startTag) return head.loc.startTag.endOffset
        const root = tags.find(t => t.name === 'html' && t.loc && t.loc.startTag)
        return root ? root.loc.startTag.endOffset : this.startOffset()
    }

    /** The start of the page's content: after the doctype and the whitespace following it, else 0. */
    startOffset() {
        const doctype = this.root.childNodes.find(n => n.nodeName === '#documentType')
        if (!doctype || !doctype.sourceCodeLocation) return 0
        let offset = doctype.sourceCodeLocation.endOffset
        while (offset < this.html.length && /\s/.test(this.html[offset])) offset++
        return offset
    }

    /** The page with all recorded edits applied. */
    toString() {
        const edits = [...this.edits].sort((a, b) => a.start - b.start || a.seq - b.seq)
        let out = ''
        let at = 0
        for (const e of edits) {
            if (e.start < at) throw new Error(`Overlapping HTML edits at offset ${e.start}`)
            out += this.html.slice(at, e.start) + e.text
            at = e.end
        }
        return out + this.html.slice(at)
    }
}

const escapeAttr = (value) => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;')

class Tag {
    constructor(doc, node) {
        this.doc = doc
        this.node = node
        this.name = node.tagName
        this.loc = node.sourceCodeLocation
        this.pending = new Map() // attribute name -> new value, or null when removed
    }

    /** The attribute's value as of the edits so far (undefined if absent). Names are lower-case. */
    attr(name) {
        if (this.pending.has(name)) {
            const value = this.pending.get(name)
            return value === null ? undefined : value
        }
        const found = this.node.attrs.find(a => a.name === name)
        return found ? found.value : undefined
    }

    /** Sets an attribute: rewrites it where it is, or appends it after the tag's last attribute. */
    set(name, value) {
        const span = this.loc && this.loc.attrs && this.loc.attrs[name]
        const text = `${name}="${escapeAttr(value)}"`
        if (span && !this.pending.has(name)) {
            this.doc.edit(span.startOffset, span.endOffset, text)
        } else {
            const at = this.lastAttrEnd()
            this.doc.edit(at, at, ` ${text}`)
        }
        this.pending.set(name, String(value))
    }

    /** Removes an attribute together with the whitespace before it. */
    remove(name) {
        const span = this.loc && this.loc.attrs && this.loc.attrs[name]
        if (!span) return
        let start = span.startOffset
        while (start > 0 && /\s/.test(this.doc.html[start - 1])) start--
        this.doc.edit(start, span.endOffset, '')
        this.pending.set(name, null)
    }

    /** The offset just after the last attribute (new attributes go there, ahead of any `/` or `>`). */
    lastAttrEnd() {
        const spans = Object.values(this.loc.attrs || {})
        return spans.length ? Math.max(...spans.map(s => s.endOffset)) : this.loc.startTag.endOffset - 1
    }

    /** The range of the element's text content, or null if it has no closing tag. */
    innerRange() {
        const { startTag, endTag } = this.loc || {}
        return startTag && endTag ? { start: startTag.endOffset, end: endTag.startOffset } : null
    }

    /** Where this tag begins in the source. */
    get startOffset() {
        return this.loc.startTag.startOffset
    }
}

module.exports = { HtmlDocument }
