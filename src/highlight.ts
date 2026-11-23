// Syntax colours for the diff editor. A small scanner written for Finline, with no dependencies:
// it knows comments, strings, numbers, keywords and a few shapes (calls, types, keys, tags), which
// is what makes code readable at a glance. It is not a parser and doesn't try to be exact.
//
// A diff arrives as lines, so the scanner works a line at a time and hands back the state the
// next line starts in (inside a block comment, a multi-line string, an open tag).
// Pure and free of DOM and Node APIs: the editor frame runs it and `node --test` covers it.
import type { Segment } from './diff.ts'

export type TokenKind = 'comment' | 'string' | 'number' | 'keyword' | 'literal' | 'type' | 'function' | 'attr' | 'tag'

export interface Token {
  text: string
  /** Null for plain text. */
  kind: TokenKind | null
}

/** What a line starts inside of; null at the top level. */
export type LineState =
  | null
  /** A block comment or multi-line string, until `close`. */
  | { close: string; kind: 'comment' | 'string'; escape: boolean }
  /** Between `<name` and its `>`. */
  | { tag: true }
  /** Inside a fenced code block of a Markdown file. */
  | { fence: true }

interface StringSpec {
  open: string
  close: string
  /** May run over several lines. */
  multi?: boolean
  /** A backslash takes the next character with it. */
  escape?: boolean
}

interface Spec {
  mode?: 'code' | 'markup' | 'markdown'
  /** Line comment starters. `#` only counts at the line start or after a space. */
  line?: string[]
  block?: [string, string][]
  strings?: StringSpec[]
  keywords?: string
  literals?: string
  /** Keywords match whatever their case (SQL). */
  ignoreCase?: boolean
  /** A word or string right before `:` is a key (JSON, YAML, CSS properties). */
  keys?: boolean
  /** What `@word` is: an at-rule or a decorator. */
  at?: TokenKind
  /** Words may contain `-` (CSS, YAML). */
  hyphens?: boolean
  /** `#fff` is a colour. */
  hexColors?: boolean
  /** A capitalised word is a type. */
  types?: boolean
}

export interface Language {
  name: string
  spec: Spec
  keywords: Set<string>
  literals: Set<string>
  /** String openers, longest first, so `"""` wins over `"`. */
  strings: StringSpec[]
}

const DQ: StringSpec = { open: '"', close: '"', escape: true }
const SQ: StringSpec = { open: "'", close: "'", escape: true }
const C_COMMENTS = { line: ['//'], block: [['/*', '*/']] as [string, string][] }
const C_LIKE: Spec = { ...C_COMMENTS, strings: [DQ, SQ], types: true, literals: 'true false null' }

const JS_KEYWORDS =
  'abstract any as asserts async await break case catch class const constructor continue debugger declare default delete do else enum export extends finally for from function get if implements import in infer instanceof interface is keyof let module namespace never new of override package private protected public readonly return satisfies set static switch throw try type typeof unique unknown var void while with yield boolean number string symbol bigint object'

const SPECS: Record<string, Spec> = {
  typescript: {
    ...C_COMMENTS,
    strings: [DQ, SQ, { open: '`', close: '`', multi: true, escape: true }],
    keywords: JS_KEYWORDS,
    literals: 'true false null undefined NaN Infinity this super',
    at: 'attr',
    types: true
  },
  json: { ...C_COMMENTS, strings: [DQ], literals: 'true false null', keys: true },
  css: {
    line: [],
    block: [['/*', '*/']],
    strings: [DQ, SQ],
    keys: true,
    at: 'keyword',
    hyphens: true,
    hexColors: true,
    literals: 'inherit initial unset revert none auto'
  },
  scss: {
    ...C_COMMENTS,
    strings: [DQ, SQ],
    keys: true,
    at: 'keyword',
    hyphens: true,
    hexColors: true,
    literals: 'inherit initial unset revert none auto true false null'
  },
  python: {
    line: ['#'],
    strings: [
      { open: '"""', close: '"""', multi: true, escape: true },
      { open: "'''", close: "'''", multi: true, escape: true },
      DQ,
      SQ
    ],
    keywords:
      'and as assert async await break case class continue def del elif else except finally for from global if import in is lambda match nonlocal not or pass raise return try while with yield',
    literals: 'True False None self cls',
    at: 'attr',
    types: true
  },
  ruby: {
    line: ['#'],
    strings: [DQ, SQ],
    keywords:
      'alias and begin break case class def defined do else elsif end ensure for if in module next not or redo rescue retry return then undef unless until when while yield require require_relative include extend attr_accessor attr_reader attr_writer private protected public',
    literals: 'true false nil self',
    types: true
  },
  shell: {
    line: ['#'],
    strings: [DQ, { open: "'", close: "'", multi: true }],
    keywords: 'if then else elif fi for while until do done case esac function in select return exit export local readonly declare set unset source',
    literals: 'true false'
  },
  yaml: { line: ['#'], strings: [DQ, SQ], keys: true, hyphens: true, literals: 'true false null yes no on off' },
  toml: { line: ['#'], strings: [{ open: '"""', close: '"""', multi: true, escape: true }, DQ, SQ], literals: 'true false' },
  ini: { line: ['#', ';'], strings: [DQ], literals: 'true false yes no on off' },
  sql: {
    line: ['--'],
    block: [['/*', '*/']],
    strings: [{ open: "'", close: "'" }],
    ignoreCase: true,
    keywords:
      'add all alter and as asc begin between by case check column commit constraint create cross database default delete desc distinct drop else end exists foreign from full function group having if in index inner insert into is join key left like limit not offset on or order outer primary procedure references returning right rollback select set table then transaction trigger union unique update values view when where with',
    literals: 'null true false'
  },
  go: {
    ...C_COMMENTS,
    strings: [DQ, SQ, { open: '`', close: '`', multi: true }],
    keywords:
      'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var any bool byte error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr',
    literals: 'true false nil iota',
    types: true
  },
  rust: {
    ...C_COMMENTS,
    // No quote strings: `'a` is a lifetime far more often than a char.
    strings: [DQ],
    keywords:
      'as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return static struct super trait type unsafe use where while bool char str u8 u16 u32 u64 u128 usize i8 i16 i32 i64 i128 isize f32 f64',
    literals: 'true false self Self None Some Ok Err',
    types: true
  },
  java: {
    ...C_LIKE,
    keywords:
      'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new package private protected public record return sealed short static strictfp super switch synchronized this throw throws transient try var void volatile while yield',
    at: 'attr'
  },
  kotlin: {
    ...C_LIKE,
    strings: [{ open: '"""', close: '"""', multi: true }, DQ, SQ],
    keywords:
      'abstract as break by catch class companion const constructor continue data do else enum final finally for fun if import in init inline interface internal is lateinit object open operator out override package private protected public return sealed super suspend this throw try typealias val var when while',
    at: 'attr'
  },
  c: {
    ...C_LIKE,
    keywords:
      'alignas alignof auto bool break case catch char class const constexpr continue decltype default delete do double dynamic_cast else enum explicit extern float for friend goto if inline int long mutable namespace new noexcept operator private protected public register return short signed sizeof static static_cast struct switch template this throw try typedef typename union unsigned using virtual void volatile while',
    literals: 'true false NULL nullptr'
  },
  csharp: {
    ...C_LIKE,
    keywords:
      'abstract as async await base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern finally fixed float for foreach get goto if implicit in init int interface internal is lock long namespace new object operator out override params partial private protected public readonly record ref return sbyte sealed set short sizeof static string struct switch this throw try typeof uint ulong unchecked unsafe ushort using var virtual void volatile where while yield'
  },
  swift: {
    ...C_LIKE,
    strings: [{ open: '"""', close: '"""', multi: true, escape: true }, DQ],
    keywords:
      'actor as associatedtype async await break case catch class continue default defer deinit do else enum extension fallthrough fileprivate final for func guard if import in indirect init inout internal is lazy let mutating open operator override private protocol public repeat rethrows return self static struct subscript super switch throw throws try typealias var weak where while',
    literals: 'true false nil',
    at: 'attr'
  },
  php: {
    ...C_LIKE,
    line: ['//', '#'],
    keywords:
      'abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enum extends final finally fn for foreach function global if implements include include_once instanceof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield'
  },
  dart: {
    ...C_LIKE,
    keywords:
      'abstract as assert async await break case catch class const continue covariant default deferred do dynamic else enum export extends extension external factory final finally for get if implements import in interface is late library mixin new on operator part required rethrow return sealed set static super switch sync this throw try typedef var void while with yield',
    at: 'attr'
  },
  lua: {
    line: ['--'],
    block: [['--[[', ']]']],
    strings: [DQ, SQ],
    keywords: 'and break do else elseif end for function goto if in local not or repeat return then until while',
    literals: 'true false nil'
  },
  dockerfile: {
    line: ['#'],
    strings: [DQ, SQ],
    ignoreCase: true,
    keywords: 'add arg as cmd copy entrypoint env expose from healthcheck label onbuild run shell stopsignal user volume workdir'
  },
  makefile: { line: ['#'], strings: [], keywords: 'ifeq ifneq ifdef ifndef else endif include define endef export unexport override' },
  markup: { mode: 'markup' },
  markdown: { mode: 'markdown' }
}

const EXTENSIONS: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'typescript', jsx: 'typescript', mjs: 'typescript', cjs: 'typescript',
  json: 'json', jsonc: 'json', json5: 'json', webmanifest: 'json', map: 'json',
  css: 'css', scss: 'scss', sass: 'scss', less: 'scss',
  py: 'python', pyi: 'python', rb: 'ruby', rake: 'ruby', gemspec: 'ruby',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell', env: 'shell',
  yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'ini', editorconfig: 'ini',
  sql: 'sql', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'java', groovy: 'java', gradle: 'java',
  c: 'c', h: 'c', cc: 'c', cpp: 'c', cxx: 'c', hpp: 'c', hh: 'c', m: 'c', mm: 'c',
  cs: 'csharp', swift: 'swift', php: 'php', dart: 'dart', lua: 'lua', mk: 'makefile',
  html: 'markup', htm: 'markup', xhtml: 'markup', xml: 'markup', svg: 'markup', vue: 'markup', svelte: 'markup', plist: 'markup', xsl: 'markup',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown'
}

const FILE_NAMES: Record<string, string> = {
  dockerfile: 'dockerfile', containerfile: 'dockerfile',
  makefile: 'makefile', gnumakefile: 'makefile',
  gemfile: 'ruby', rakefile: 'ruby', '.bashrc': 'shell', '.zshrc': 'shell', '.profile': 'shell', '.gitignore': 'ini', '.gitattributes': 'ini'
}

const languages = new Map<string, Language>()

function language(name: string): Language {
  let found = languages.get(name)
  if (!found) {
    const spec = SPECS[name]
    const words = (list?: string) => new Set(list ? list.split(' ') : [])
    found = {
      name,
      spec,
      keywords: words(spec.keywords),
      literals: words(spec.literals),
      strings: [...(spec.strings ?? [])].sort((a, b) => b.open.length - a.open.length)
    }
    languages.set(name, found)
  }
  return found
}

/** The language to colour `path` with, from its name; null when Finline has none for it. */
export function languageOf(path: string): Language | null {
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  // `Dockerfile.dev` is a Dockerfile: try the name before the first dot too.
  const byName = FILE_NAMES[base] ?? FILE_NAMES[base.slice(0, base.indexOf('.') > 0 ? base.indexOf('.') : base.length)]
  if (byName) return language(byName)
  const dot = base.lastIndexOf('.')
  const name = dot > 0 ? EXTENSIONS[base.slice(dot + 1)] : undefined
  return name ? language(name) : null
}

/** Collects tokens, joining plain text that comes in pieces. */
class Line {
  tokens: Token[] = []
  push(text: string, kind: TokenKind | null): void {
    if (text === '') return
    const last = this.tokens[this.tokens.length - 1]
    if (kind === null && last && last.kind === null) last.text += text
    else this.tokens.push({ text, kind })
  }
}

/** Index just past `close` at or after `from`, or -1. With `escape`, a backslash skips a character. */
function findClose(line: string, from: number, close: string, escape: boolean): number {
  for (let i = from; i < line.length; i++) {
    if (escape && line[i] === '\\') i++
    else if (line.startsWith(close, i)) return i + close.length
  }
  return -1
}

const NUMBER = /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)[A-Za-z%]*/y
const WORD = /[A-Za-z_$][\w$]*/y
const HYPHEN_WORD = /[A-Za-z_][\w-]*/y
const HEX_COLOR = /#[\da-fA-F]{3,8}\b/y
const KEY_AHEAD = /\s*:(?!:)/y
const TYPE_NAME = /^[A-Z][A-Za-z\d]*[a-z][A-Za-z\d]*$/

const matchAt = (pattern: RegExp, line: string, at: number): string | null => {
  pattern.lastIndex = at
  return pattern.exec(line)?.[0] ?? null
}

function scanCode(lang: Language, line: string, start: LineState): { tokens: Token[]; state: LineState } {
  const { spec } = lang
  const out = new Line()
  let state: LineState = null
  let i = 0
  if (start && 'close' in start) {
    const end = findClose(line, 0, start.close, start.escape)
    if (end === -1) {
      out.push(line, start.kind)
      return { tokens: out.tokens, state: start }
    }
    out.push(line.slice(0, end), start.kind)
    i = end
  }
  const word = spec.hyphens ? HYPHEN_WORD : WORD
  scan: while (i < line.length) {
    for (const mark of spec.line ?? []) {
      // `#` starts a comment only on its own: `a#b`, `$#` and `${#x}` are not comments.
      if (line.startsWith(mark, i) && (mark !== '#' || i === 0 || /\s/.test(line[i - 1]))) {
        out.push(line.slice(i), 'comment')
        break scan
      }
    }
    for (const [open, close] of spec.block ?? []) {
      if (!line.startsWith(open, i)) continue
      const end = findClose(line, i + open.length, close, false)
      if (end === -1) {
        out.push(line.slice(i), 'comment')
        state = { close, kind: 'comment', escape: false }
        break scan
      }
      out.push(line.slice(i, end), 'comment')
      i = end
      continue scan
    }
    for (const string of lang.strings) {
      if (!line.startsWith(string.open, i)) continue
      const end = findClose(line, i + string.open.length, string.close, string.escape === true)
      if (end === -1) {
        out.push(line.slice(i), 'string')
        if (string.multi) state = { close: string.close, kind: 'string', escape: string.escape === true }
        break scan
      }
      const key = spec.keys === true && matchAt(KEY_AHEAD, line, end) !== null
      out.push(line.slice(i, end), key ? 'attr' : 'string')
      i = end
      continue scan
    }
    const char = line[i]
    if (spec.hexColors && char === '#') {
      const color = matchAt(HEX_COLOR, line, i)
      if (color) {
        out.push(color, 'number')
        i += color.length
        continue
      }
    }
    if (spec.at && char === '@') {
      const name = matchAt(word, line, i + 1)
      if (name) {
        out.push(`@${name}`, spec.at)
        i += name.length + 1
        continue
      }
    }
    if (char >= '0' && char <= '9') {
      const number = matchAt(NUMBER, line, i)
      if (number) {
        out.push(number, 'number')
        i += number.length
        continue
      }
    }
    const name = matchAt(word, line, i)
    if (name) {
      const end = i + name.length
      const lookup = spec.ignoreCase ? name.toLowerCase() : name
      let kind: TokenKind | null = null
      if (lang.keywords.has(lookup)) kind = 'keyword'
      else if (lang.literals.has(lookup)) kind = 'literal'
      else if (spec.keys && matchAt(KEY_AHEAD, line, end) !== null) kind = 'attr'
      else if (line[end] === '(') kind = 'function'
      else if (spec.types && TYPE_NAME.test(name)) kind = 'type'
      out.push(name, kind)
      i = end
      continue
    }
    out.push(char, null)
    i++
  }
  return { tokens: out.tokens, state }
}

const TAG_OPEN = /<[/!?]?[A-Za-z][\w:.-]*/y
const ATTR_NAME = /[^\s=<>/"']+/y

function scanMarkup(line: string, start: LineState): { tokens: Token[]; state: LineState } {
  const out = new Line()
  let inTag = start !== null && 'tag' in start
  let i = 0
  if (start && 'close' in start) {
    const end = findClose(line, 0, start.close, false)
    if (end === -1) {
      out.push(line, 'comment')
      return { tokens: out.tokens, state: start }
    }
    out.push(line.slice(0, end), 'comment')
    i = end
  }
  while (i < line.length) {
    const char = line[i]
    if (inTag) {
      const close = line.startsWith('/>', i) || line.startsWith('?>', i) ? 2 : char === '>' ? 1 : 0
      if (close > 0) {
        out.push(line.slice(i, i + close), 'tag')
        i += close
        inTag = false
      } else if (char === '"' || char === "'") {
        const end = findClose(line, i + 1, char, false)
        out.push(line.slice(i, end === -1 ? line.length : end), 'string')
        i = end === -1 ? line.length : end
      } else {
        const name = matchAt(ATTR_NAME, line, i)
        out.push(name ?? char, name ? 'attr' : null)
        i += (name ?? char).length
      }
    } else if (line.startsWith('<!--', i)) {
      const end = findClose(line, i + 4, '-->', false)
      if (end === -1) {
        out.push(line.slice(i), 'comment')
        return { tokens: out.tokens, state: { close: '-->', kind: 'comment', escape: false } }
      }
      out.push(line.slice(i, end), 'comment')
      i = end
    } else {
      const tag = char === '<' ? matchAt(TAG_OPEN, line, i) : null
      if (tag) {
        out.push(tag, 'tag')
        i += tag.length
        inTag = true
      } else {
        out.push(char, null)
        i++
      }
    }
  }
  return { tokens: out.tokens, state: inTag ? { tag: true } : null }
}

const INLINE_CODE = /`[^`]+`/y

function scanMarkdown(line: string, start: LineState): { tokens: Token[]; state: LineState } {
  const inFence = start !== null && 'fence' in start
  if (/^\s*(```|~~~)/.test(line)) return { tokens: [{ text: line, kind: 'comment' }], state: inFence ? null : { fence: true } }
  if (line === '') return { tokens: [], state: start }
  if (inFence) return { tokens: [{ text: line, kind: null }], state: start }
  if (/^#{1,6}\s/.test(line)) return { tokens: [{ text: line, kind: 'keyword' }], state: null }
  if (/^\s*>/.test(line)) return { tokens: [{ text: line, kind: 'comment' }], state: null }
  const out = new Line()
  for (let i = 0; i < line.length; ) {
    const code = line[i] === '`' ? matchAt(INLINE_CODE, line, i) : null
    out.push(code ?? line[i], code ? 'string' : null)
    i += (code ?? line[i]).length
  }
  return { tokens: out.tokens, state: null }
}

/**
 * Colours one line. `state` is what the previous line of the same file returned (null for the
 * first, or after lines were skipped). The tokens' text always adds up to `line`.
 */
export function highlightLine(lang: Language, line: string, state: LineState): { tokens: Token[]; state: LineState } {
  if (lang.spec.mode === 'markup') return scanMarkup(line, state)
  if (lang.spec.mode === 'markdown') return scanMarkdown(line, state)
  return scanCode(lang, line, state && 'close' in state ? state : null)
}

export interface Piece extends Token {
  /** Inside the part of a modified line that changed. */
  changed: boolean
}

/**
 * Lays a line's syntax tokens over its changed parts (`wordDiff`), cutting a token where a
 * changed part starts or ends. Both lists cover the same text.
 */
export function mergeSegments(tokens: readonly Token[], segments: readonly Segment[] | null): Piece[] {
  if (!segments) return tokens.map((token) => ({ ...token, changed: false }))
  const pieces: Piece[] = []
  let s = 0
  let left = segments[0]?.text.length ?? 0
  for (const token of tokens) {
    let rest = token.text
    while (rest.length > 0) {
      while (left === 0 && s < segments.length - 1) left = segments[++s].text.length
      const take = left > 0 ? Math.min(left, rest.length) : rest.length
      pieces.push({ text: rest.slice(0, take), kind: token.kind, changed: segments[s]?.changed ?? false })
      rest = rest.slice(take)
      left = Math.max(0, left - take)
    }
  }
  return pieces
}
