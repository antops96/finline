import assert from 'node:assert/strict'
import { test } from 'node:test'
import { excerptOf, hasAllTerms, searchTerms, splitMarks } from './search.ts'

test('searchTerms lower-cases, splits on spaces and drops repeats', () => {
  assert.deepEqual(searchTerms('  Fix  the FIX  bug '), ['fix', 'the', 'bug'])
  assert.deepEqual(searchTerms('   '), [])
  assert.equal(searchTerms('a b c d e f g h i j').length, 8)
})

test('hasAllTerms wants every term, in any case', () => {
  assert.ok(hasAllTerms('Fix the Graph layout', ['graph', 'fix']))
  assert.ok(!hasAllTerms('Fix the Graph layout', ['graph', 'diff']))
  assert.ok(hasAllTerms('anything', []))
})

test('excerptOf picks the first body line with a term and cuts long ones around it', () => {
  assert.equal(excerptOf('first line\n  the Lanes converge here\nlast', ['lanes']), 'the Lanes converge here')
  assert.equal(excerptOf('nothing here', ['lanes']), null)
  const long = `${'a'.repeat(200)} needle ${'b'.repeat(200)}`
  const cut = excerptOf(long, ['needle'], 60)!
  assert.ok(cut.includes('needle'))
  assert.ok(cut.startsWith('…') && cut.endsWith('…'))
  assert.equal(cut.length, 62)
})

test('splitMarks marks every occurrence and keeps the text whole', () => {
  assert.deepEqual(splitMarks('Fix the fix', ['fix']), [
    { text: 'Fix', hit: true },
    { text: ' the ', hit: false },
    { text: 'fix', hit: true }
  ])
  assert.deepEqual(splitMarks('feature/x', ['feat', 'feature']), [
    { text: 'feature', hit: true },
    { text: '/x', hit: false }
  ])
  assert.deepEqual(splitMarks('plain', []), [{ text: 'plain', hit: false }])
  assert.deepEqual(splitMarks('plain', ['zzz']), [{ text: 'plain', hit: false }])
  assert.deepEqual(splitMarks('', ['a']), [])
})
