import assert from 'node:assert/strict'
import { test } from 'node:test'
import { highlightLine, languageOf, mergeSegments, type LineState, type Token } from './highlight.ts'

const lang = (path: string) => {
  const found = languageOf(path)
  assert.ok(found, `no language for ${path}`)
  return found
}
/** Tokens as `kind:text`, plain text as `-:text`. */
const show = (tokens: Token[]) => tokens.map((t) => `${t.kind ?? '-'}:${t.text}`)
const kinds = (path: string, line: string, state: LineState = null) => show(highlightLine(lang(path), line, state).tokens)
/** Highlights lines in order, carrying the state, and returns each line's tokens. */
const run = (path: string, lines: string[]) => {
  let state: LineState = null
  return lines.map((line) => {
    const out = highlightLine(lang(path), line, state)
    state = out.state
    return show(out.tokens)
  })
}

test('picks a language from the file name', () => {
  assert.equal(languageOf('src/graph/main.ts')?.name, 'typescript')
  assert.equal(languageOf('a/b/App.TSX')?.name, 'typescript')
  assert.equal(languageOf('package.json')?.name, 'json')
  assert.equal(languageOf('Dockerfile')?.name, 'dockerfile')
  assert.equal(languageOf('docker/Dockerfile.dev')?.name, 'dockerfile')
  assert.equal(languageOf('Makefile')?.name, 'makefile')
  assert.equal(languageOf('index.html')?.name, 'markup')
  assert.equal(languageOf('README.md')?.name, 'markdown')
  assert.equal(languageOf('notes.txt'), null)
  assert.equal(languageOf('LICENSE'), null)
})

test('colours keywords, strings, numbers, calls and comments in TypeScript', () => {
  assert.deepEqual(kinds('a.ts', `const n = parse("x", 42) // done`), [
    'keyword:const',
    '-: n = ',
    'function:parse',
    '-:(',
    'string:"x"',
    '-:, ',
    'number:42',
    '-:) ',
    'comment:// done'
  ])
  assert.deepEqual(kinds('a.ts', 'let x: Foo = null'), ['keyword:let', '-: x: ', 'type:Foo', '-: = ', 'literal:null'])
})

test('a string holds its escapes and comment markers', () => {
  assert.deepEqual(kinds('a.js', String.raw`s = "a \" // b" + 'c'`), ['-:s = ', String.raw`string:"a \" // b"`, '-: + ', "string:'c'"])
})

test('carries a block comment and a template literal across lines', () => {
  assert.deepEqual(run('a.ts', ['a /* one', 'two', 'three */ b', 'x = `t', 'u` + 1']), [
    ['-:a ', 'comment:/* one'],
    ['comment:two'],
    ['comment:three */', '-: b'],
    ['-:x = ', 'string:`t'],
    ['string:u`', '-: + ', 'number:1']
  ])
})

test('an empty line inside a block keeps the block open', () => {
  assert.deepEqual(run('a.css', ['/* a', '', 'b */', 'x']), [['comment:/* a'], [], ['comment:b */'], ['-:x']])
})

test('Python: triple quotes, hash comments, decorators', () => {
  assert.deepEqual(run('a.py', ['x = """doc', 'more""" # c', '@cache', 'def f(): return None']), [
    ['-:x = ', 'string:"""doc'],
    ['string:more"""', '-: ', 'comment:# c'],
    ['attr:@cache'],
    ['keyword:def', '-: ', 'function:f', '-:(): ', 'keyword:return', '-: ', 'literal:None']
  ])
})

test('a hash inside a word is not a shell comment', () => {
  assert.deepEqual(kinds('a.sh', 'echo a#b $# # real'), ['-:echo a#b $# ', 'comment:# real'])
})

test('JSON keys differ from string values', () => {
  assert.deepEqual(kinds('a.json', '  "name": "finline", "n": 1, "ok": true'), [
    '-:  ',
    'attr:"name"',
    '-:: ',
    'string:"finline"',
    '-:, ',
    'attr:"n"',
    '-:: ',
    'number:1',
    '-:, ',
    'attr:"ok"',
    '-:: ',
    'literal:true'
  ])
})

test('CSS: properties, at-rules, colours and units', () => {
  assert.deepEqual(kinds('a.css', '  color: #fff; margin-top: 10px'), ['-:  ', 'attr:color', '-:: ', 'number:#fff', '-:; ', 'attr:margin-top', '-:: ', 'number:10px'])
  assert.deepEqual(kinds('a.css', '@media (min-width: 1em) {')[0], 'keyword:@media')
})

test('SQL keywords ignore case', () => {
  assert.deepEqual(kinds('a.sql', "select a FROM t -- x"), ['keyword:select', '-: a ', 'keyword:FROM', '-: t ', 'comment:-- x'])
})

test('markup: tags, attributes, strings and comments, across lines', () => {
  assert.deepEqual(kinds('a.html', '<a href="x" hidden>hi</a> <!-- c -->'), [
    'tag:<a',
    '-: ',
    'attr:href',
    '-:=',
    'string:"x"',
    '-: ',
    'attr:hidden',
    'tag:>',
    '-:hi',
    'tag:</a',
    'tag:>',
    '-: ',
    'comment:<!-- c -->'
  ])
  assert.deepEqual(run('a.xml', ['<node', '  id="1">', '<!-- a', 'b -->x']), [
    ['tag:<node'],
    ['-:  ', 'attr:id', '-:=', 'string:"1"', 'tag:>'],
    ['comment:<!-- a'],
    ['comment:b -->', '-:x']
  ])
})

test('markdown: headings, fences and inline code', () => {
  assert.deepEqual(run('a.md', ['# Title', 'use `x` here', '```ts', 'const a = 1', '```', 'after']), [
    ['keyword:# Title'],
    ['-:use ', 'string:`x`', '-: here'],
    ['comment:```ts'],
    ['-:const a = 1'],
    ['comment:```'],
    ['-:after']
  ])
})

test('tokens always add up to the line', () => {
  const samples: [string, string[]][] = [
    ['a.ts', ['const r = /"/.test(`${a}"`) ? \'un\\', "it's // not", 'x = 0x1F + 1_000n - 1.5e-3;', '\t@dec() class A<T> {}', '']],
    ['a.py', ["s = 'it''s' \"\"\" open", 'still', 'f"{x!r}" # é ✓']],
    ['a.html', ['<div class="a b" data-x=\'1\'><br/><', '  attr', '>text & more']],
    ['a.rs', ["fn f<'a>(x: &'a str) -> u8 { b'x' }"]],
    ['a.yaml', ['key: "v" # c', '- item: yes', "  'q': 1"]],
    ['a.go', ['s := `raw', 'more` + "x"']],
    ['Makefile', ['all: build # go', '\t$(CC) -o $@ $<']]
  ]
  for (const [path, lines] of samples) {
    let state: LineState = null
    for (const line of lines) {
      const out = highlightLine(lang(path), line, state)
      assert.equal(out.tokens.map((t) => t.text).join(''), line, `${path}: ${JSON.stringify(line)}`)
      assert.ok(out.tokens.every((t) => t.text.length > 0), `${path}: empty token in ${JSON.stringify(line)}`)
      state = out.state
    }
  }
})

test('merges syntax tokens with the changed parts of a line', () => {
  const tokens: Token[] = [
    { text: 'const', kind: 'keyword' },
    { text: ' a = ', kind: null },
    { text: 'foo', kind: 'function' },
    { text: '(1)', kind: null }
  ]
  const segments = [
    { text: 'const a = ', changed: false },
    { text: 'foo(', changed: true },
    { text: '1)', changed: false }
  ]
  assert.deepEqual(mergeSegments(tokens, segments), [
    { text: 'const', kind: 'keyword', changed: false },
    { text: ' a = ', kind: null, changed: false },
    { text: 'foo', kind: 'function', changed: true },
    { text: '(', kind: null, changed: true },
    { text: '1)', kind: null, changed: false }
  ])
  assert.deepEqual(mergeSegments(tokens, null), tokens.map((t) => ({ ...t, changed: false })))
  assert.deepEqual(mergeSegments([{ text: 'plain', kind: null }], [{ text: 'plain', changed: true }]), [{ text: 'plain', kind: null, changed: true }])
})
