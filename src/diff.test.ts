import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parsePatch, splitRows, wordDiff, type Row } from './diff.ts'

const HEADER = ['diff --git a/a.txt b/a.txt', 'index 111..222 100644', '--- a/a.txt', '+++ b/a.txt']
const patch = (...lines: string[]) => [...HEADER, ...lines, ''].join('\n')
const cells = (rows: Row[]) =>
  rows.map((r) => (r.gap ? 'gap' : `${r.left ? `${r.left.kind}${r.left.no}:${r.left.text}` : '-'} | ${r.right ? `${r.right.kind}${r.right.no}:${r.right.text}` : '-'}`))

test('parses hunks and skips the file header', () => {
  const { binary, hunks } = parsePatch(patch('@@ -1,3 +1,3 @@', ' one', '-two', '+TWO', ' three'))
  assert.equal(binary, false)
  assert.equal(hunks.length, 1)
  assert.deepEqual(hunks[0], {
    oldStart: 1,
    newStart: 1,
    lines: [
      { kind: ' ', text: 'one' },
      { kind: '-', text: 'two' },
      { kind: '+', text: 'TWO' },
      { kind: ' ', text: 'three' }
    ]
  })
})

test('a removed line that looks like a file header stays content', () => {
  const { hunks } = parsePatch(patch('@@ -1,2 +1 @@', '--- a/x', ' keep'))
  assert.deepEqual(hunks[0].lines, [
    { kind: '-', text: '-- a/x' },
    { kind: ' ', text: 'keep' }
  ])
})

test('drops the no-newline marker and the trailing empty line', () => {
  const { hunks } = parsePatch(patch('@@ -1 +1 @@', '-old', '\\ No newline at end of file', '+new', '\\ No newline at end of file'))
  assert.deepEqual(hunks[0].lines, [
    { kind: '-', text: 'old' },
    { kind: '+', text: 'new' }
  ])
  assert.deepEqual(cells(splitRows(hunks)), ['del1:old | add1:new'])
})

test('recognises binary files and empty patches', () => {
  assert.equal(parsePatch('diff --git a/x b/x\nBinary files a/x and b/x differ\n').binary, true)
  assert.equal(parsePatch('diff --git a/x b/x\nGIT binary patch\nliteral 3\n').binary, true)
  assert.deepEqual(parsePatch(''), { binary: false, hunks: [] })
})

test('strips a carriage return from line ends', () => {
  const { hunks } = parsePatch(patch('@@ -1 +1 @@', '-a\r', '+b\r'))
  assert.deepEqual(hunks[0].lines.map((l) => l.text), ['a', 'b'])
})

test('pairs removed and added runs row by row', () => {
  const { hunks } = parsePatch(patch('@@ -1,5 +1,4 @@', ' a', '-b', '-c', '-d', '+B', ' e', '+f'))
  assert.deepEqual(cells(splitRows(hunks)), [
    'context1:a | context1:a',
    'del2:b | add2:B',
    'del3:c | -',
    'del4:d | -',
    'context5:e | context3:e',
    '- | add4:f'
  ])
})

test('an added file has only a right side, a deleted one only a left side', () => {
  assert.deepEqual(cells(splitRows(parsePatch(patch('@@ -0,0 +1,2 @@', '+x', '+y')).hunks)), ['- | add1:x', '- | add2:y'])
  assert.deepEqual(cells(splitRows(parsePatch(patch('@@ -1,2 +0,0 @@', '-x', '-y')).hunks)), ['del1:x | -', 'del2:y | -'])
})

test('puts a gap between hunks that are not contiguous and before a late first hunk', () => {
  const { hunks } = parsePatch(patch('@@ -5,2 +5,2 @@', ' a', '-b', '+B', '@@ -20 +20 @@', '-x', '+X'))
  assert.deepEqual(cells(splitRows(hunks)), ['gap', 'context5:a | context5:a', 'del6:b | add6:B', 'gap', 'del20:x | add20:X'])
})

test('wordDiff marks the middle that changed', () => {
  assert.deepEqual(wordDiff('const a = foo(1)', 'const a = bar(1)'), {
    left: [
      { text: 'const a = ', changed: false },
      { text: 'foo', changed: true },
      { text: '(1)', changed: false }
    ],
    right: [
      { text: 'const a = ', changed: false },
      { text: 'bar', changed: true },
      { text: '(1)', changed: false }
    ]
  })
})

test('wordDiff handles a pure insertion', () => {
  assert.deepEqual(wordDiff('call(a)', 'call(a, b)'), {
    left: [{ text: 'call(a)', changed: false }],
    right: [
      { text: 'call(a', changed: false },
      { text: ', b', changed: true },
      { text: ')', changed: false }
    ]
  })
})

test('wordDiff gives up when lines share nothing but whitespace, or are equal', () => {
  assert.equal(wordDiff('  foo()', '  bar.baz'), null)
  assert.equal(wordDiff('same', 'same'), null)
  assert.equal(wordDiff('abc', 'xyz'), null)
})
