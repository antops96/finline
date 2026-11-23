import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseTicket, ticketPath } from './ticket.ts'
import { writeTicket } from './ticket-store.ts'

const HASH = '94b8f63aa0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5'

async function scratch(): Promise<{ root: string; common: string; done: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'finline-ticket-'))
  const common = join(root, '.git')
  await mkdir(common)
  return { root, common, done: () => rm(root, { recursive: true, force: true }) }
}

test('writes the ticket where ticketPath says and hides the folder from git', async () => {
  const { root, common, done } = await scratch()
  try {
    const ticket = { v: 1 as const, repo: root, rev: HASH, file: 'src/a.ts' }
    const relative = await writeTicket(root, common, ticket)
    assert.equal(relative, ticketPath(HASH, 'src/a.ts'))
    assert.deepEqual(parseTicket(await readFile(join(root, relative), 'utf8')), ticket)
    assert.equal(await readFile(join(common, 'info', 'exclude'), 'utf8'), '.finline/\n')
  } finally {
    await done()
  }
})

test('adds the exclude line once, after whatever the file already holds', async () => {
  const { root, common, done } = await scratch()
  try {
    await mkdir(join(common, 'info'))
    await writeFile(join(common, 'info', 'exclude'), '# local\n*.log') // no final newline
    const ticket = { v: 1 as const, repo: root, rev: HASH, file: 'a.ts' }
    await writeTicket(root, common, ticket)
    await writeTicket(root, common, ticket)
    assert.equal(await readFile(join(common, 'info', 'exclude'), 'utf8'), '# local\n*.log\n.finline/\n')
  } finally {
    await done()
  }
})

test('keeps only the newest tickets and removes emptied folders', async () => {
  const { root, common, done } = await scratch()
  try {
    const files = ['a.ts', 'b.ts', 'c.ts']
    for (const [i, file] of files.entries()) {
      const relative = await writeTicket(root, common, { v: 1, repo: root, rev: HASH, file }, 2)
      // Spread the write times: the file system's clock is too coarse for three writes in a row.
      const at = new Date(Date.now() - (10 - i) * 60_000)
      if (i < 2) await utimes(join(root, relative), at, at)
    }
    const left = (await readdir(join(root, '.finline'), { recursive: true })).filter((name) => name.endsWith('.finline-diff'))
    assert.equal(left.length, 2)
    assert.ok(left.every((name) => !name.includes('a.ts')))
    assert.equal((await readdir(join(root, '.finline'))).length, 2)
  } finally {
    await done()
  }
})
