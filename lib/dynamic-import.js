const acorn = require('acorn')

// Fallback for code the tokenizer cannot read: a method call (`obj.import(`) is not a dynamic import.
const CALL = /(?<![.\w$])import\s*\(/g
const LITERAL_CALL = /(?<![.\w$])import\s*\(\s*(["'])([^"'\\\n]*)\1\s*[,)]/g

/**
 * Blanks block comments and line comments. A `//` only starts a comment at the start of a line or after
 * whitespace, so "http://x" in a string is left alone. Not a tokenizer: used only when one cannot run.
 */
function stripComments(text) {
    return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/g, '$1')
}

function scanWithRegex(text) {
    const code = stripComments(text)
    return { count: (code.match(CALL) || []).length, literals: [...code.matchAll(LITERAL_CALL)].map(m => m[2]) }
}

/**
 * Finds the dynamic import() calls in JavaScript. `count` is every call; `literals` are the specifiers
 * of the calls whose argument is a plain string literal (the only ones that can be matched to an import
 * map entry), so `literals.length === count` means every call has a known target.
 *
 * Reads tokens, so an `import(` inside a string, template text, regex or comment is not a call, and
 * `obj.import(` (a method) is not either. If the code cannot be tokenized it falls back to a
 * conservative regex scan, which errs towards reporting.
 */
function findDynamicImports(text) {
    let tokens
    try {
        tokens = [...acorn.tokenizer(text, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true })]
    } catch {
        return scanWithRegex(text)
    }
    const literals = []
    let count = 0
    for (let i = 0; i < tokens.length - 1; i++) {
        const t = tokens[i]
        if (t.type !== acorn.tokTypes._import || tokens[i + 1].type !== acorn.tokTypes.parenL) continue
        const before = tokens[i - 1]
        if (before && (before.type === acorn.tokTypes.dot || before.type === acorn.tokTypes.questionDot)) continue
        count++
        const arg = tokens[i + 2]
        const after = tokens[i + 3]
        if (arg && arg.type === acorn.tokTypes.string && after && (after.type === acorn.tokTypes.parenR || after.type === acorn.tokTypes.comma)) {
            literals.push(arg.value)
        }
    }
    return { count, literals }
}

module.exports = { findDynamicImports }
