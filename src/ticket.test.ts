import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isSafeRelPath, parseTicket, staleTickets, ticketPath, ticketText } from './ticket.ts'

const HASH = '94b8f63aa0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5'

test('names a ticket after the file and the commit', () => {
  assert.match(ticketPath(HASH, 'src/graph/main.ts'), /^\.finline\/[0-9a-f]{8}\/main\.ts \(94b8f63\)\.finline-diff$/)
  assert.match(ticketPath('worktree', 'README.md'), /^\.finline\/[0-9a-f]{8}\/README\.md \(changes\)\.finline-diff$/)
})

test('files with the same base name get different tickets', () => {
  assert.notEqual(ticketPath(HASH, 'a/index.ts'), ticketPath(HASH, 'b/index.ts'))
  assert.notEqual(ticketPath(HASH, 'a/index.ts'), ticketPath('worktree', 'a/index.ts'))
  assert.equal(ticketPath(HASH, 'a/index.ts'), ticketPath(HASH, 'a/index.ts'))
})

test('replaces characters a file name cannot hold on Windows', () => {
  assert.match(ticketPath(HASH, 'dir/a:b?c*.txt'), /\/a_b_c_\.txt \(94b8f63\)\.finline-diff$/)
})

test('refuses paths that leave the repository', () => {
  for (const bad of ['', '../x', 'a/../../x', '/etc/passwd', 'C:\\x', '\\\\server\\share', 'a\0b', 'a\\..\\b']) {
    assert.equal(isSafeRelPath(bad), false, JSON.stringify(bad))
  }
  for (const good of ['a', 'src/[id].tsx', 'dir with space/file..name', '.hidden/..x']) {
    assert.equal(isSafeRelPath(good), true, good)
  }
})

test('round-trips a ticket and rejects anything else', () => {
  const ticket = { v: 1 as const, repo: '/r', rev: HASH, file: 'a/b.ts', from: 'a/old.ts' }
  assert.deepEqual(parseTicket(ticketText(ticket)), ticket)
  const plain = { v: 1 as const, repo: '/r', rev: 'worktree', file: 'x' }
  assert.deepEqual(parseTicket(ticketText(plain)), plain)
  assert.equal(parseTicket('not json'), null)
  assert.equal(parseTicket('{"v":2,"repo":"/r","rev":"abcd","file":"x"}'), null)
  assert.equal(parseTicket('{"v":1,"repo":"/r","rev":"abcd","file":"../x"}'), null)
  assert.equal(parseTicket('{"v":1,"repo":"/r","rev":"abcd; rm","file":"x"}'), null)
  assert.equal(parseTicket('null'), null)
})

test('keeps the newest tickets', () => {
  const entries = [1, 5, 3, 4, 2].map((n) => ({ path: `t${n}`, mtimeMs: n }))
  assert.deepEqual(staleTickets(entries, 3).sort(), ['t1', 't2'])
  assert.deepEqual(staleTickets(entries), [])
})
