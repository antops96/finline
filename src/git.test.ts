import assert from 'node:assert/strict'
import { test } from 'node:test'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parsePatch } from './diff.ts'
import { git, parseDiffTree, parseRefList, parseStatus, readCommitDetails, readFileDiff, readCommits, readRefList, readStashes, readUntrackedOfStash, readWorktreeChanges, stashAt } from './git.ts'

const Z = '0000000000000000000000000000000000000000'
const raw = (status: string) => `:100644 100644 ${Z} ${Z} ${status}`

test('pairs raw records with numstat, including renames and binaries', () => {
  const out = [
    raw('A'), 'added.txt',
    raw('M'), 'bin.dat',
    raw('R087'), 'old.txt', 'new.txt',
    '1\t0\tadded.txt',
    '-\t-\tbin.dat',
    '1\t0\t', 'old.txt', 'new.txt',
    ''
  ].join('\0')
  assert.deepEqual(parseDiffTree(out), [
    { status: 'A', path: 'added.txt', added: 1, deleted: 0 },
    { status: 'M', path: 'bin.dat', added: null, deleted: null },
    { status: 'R', from: 'old.txt', path: 'new.txt', added: 1, deleted: 0 }
  ])
})

test('keeps paths with tabs and spaces whole', () => {
  const out = [raw('D'), 'dir with space/a\tb.txt', '0\t3\tdir with space/a\tb.txt', ''].join('\0')
  assert.deepEqual(parseDiffTree(out), [{ status: 'D', path: 'dir with space/a\tb.txt', added: 0, deleted: 3 }])
})

test('an empty diff has no files', () => {
  assert.deepEqual(parseDiffTree(''), [])
})

test('status counts staged, unstaged, untracked and conflicted paths', () => {
  const Z = '0000000000000000000000000000000000000000'
  const out = [
    '# branch.oid abc', '# branch.head feat', '# branch.upstream origin/feat', '# branch.ab +2 -3',
    `1 M. N... 100644 100644 100644 ${Z} ${Z} staged.txt`,
    `1 .M N... 100644 100644 100644 ${Z} ${Z} unstaged.txt`,
    `1 MM N... 100644 100644 100644 ${Z} ${Z} both.txt`,
    `2 R. N... 100644 100644 100644 ${Z} ${Z} R100 new.txt`, 'old.txt',
    `u UU N... 100644 100644 100644 100644 ${Z} ${Z} ${Z} conflict.txt`,
    '? untracked.txt',
    ''
  ].join('\0')
  assert.deepEqual(parseStatus(out), {
    branch: 'feat', head: 'abc', upstream: 'origin/feat', ahead: 2, behind: 3,
    staged: 3, unstaged: 2, untracked: 1, conflicts: 1
  })
  const detached = parseStatus(['# branch.oid abc', '# branch.head (detached)', ''].join('\0'))
  assert.equal(detached.branch, null)
  assert.equal(detached.upstream, null)
})

test('worktree changes list staged, unstaged and untracked files against HEAD', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'finline-wt-'))
  try {
    const run = (...args: string[]) => git(dir, args)
    await run('init', '-q')
    await run('config', 'user.email', 'test@example.com')
    await run('config', 'user.name', 'Test')
    await writeFile(join(dir, 'kept.txt'), 'a\nb\n')
    await writeFile(join(dir, 'gone.txt'), 'x\n')
    await writeFile(join(dir, '.gitignore'), 'ignored.txt\n')
    await run('add', '.')
    await run('commit', '-q', '-m', 'init')
    await writeFile(join(dir, 'kept.txt'), 'a\nb\nc\n') // unstaged edit
    await writeFile(join(dir, 'staged.txt'), 'one\n')
    await run('add', 'staged.txt')
    await rm(join(dir, 'gone.txt'))
    await mkdir(join(dir, 'sub'))
    await writeFile(join(dir, 'sub', 'new.txt'), '1\n2\n3') // untracked, no final newline
    await writeFile(join(dir, 'ignored.txt'), 'nope\n')

    const changes = await readWorktreeChanges(join(dir, 'sub'), 100) // from a subfolder too
    const byPath = Object.fromEntries(changes.files.map((f) => [f.path, f]))
    assert.deepEqual(Object.keys(byPath).sort(), ['gone.txt', 'kept.txt', 'staged.txt', 'sub/new.txt'])
    assert.deepEqual(byPath['kept.txt'], { status: 'M', path: 'kept.txt', added: 1, deleted: 0 })
    assert.deepEqual(byPath['staged.txt'], { status: 'A', path: 'staged.txt', added: 1, deleted: 0 })
    assert.deepEqual(byPath['gone.txt'], { status: 'D', path: 'gone.txt', added: 0, deleted: 1 })
    assert.deepEqual(byPath['sub/new.txt'], { status: 'A', path: 'sub/new.txt', added: 3, deleted: 0, untracked: true })
    assert.match(changes.head, /^[0-9a-f]{40}$/)
    assert.equal(changes.filesTruncated, false)

    const capped = await readWorktreeChanges(dir, 2)
    assert.equal(capped.files.length, 2)
    assert.equal(capped.filesTruncated, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('parseRefList splits branches from tags and caps the tags', () => {
  const out = ['refs/heads/main\0/repo', 'refs/tags/v2\0', 'refs/heads/feat/x\0', 'refs/tags/v1\0', ''].join('\n')
  assert.deepEqual(parseRefList(out, 10), {
    branches: [
      { name: 'main', worktree: '/repo' },
      { name: 'feat/x', worktree: null }
    ],
    tags: ['v2', 'v1'],
    tagsTruncated: false
  })
  assert.deepEqual(parseRefList(out, 1).tags, ['v2'])
  assert.equal(parseRefList(out, 1).tagsTruncated, true)
  // Without %(worktreepath) (git before 2.23) a line is the ref name alone.
  assert.deepEqual(parseRefList('refs/heads/main\n', 10).branches, [{ name: 'main', worktree: null }])
})

test('readRefList reads local branches with their worktree, and tags', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'finline-refs-'))
  try {
    const run = (...args: string[]) => git(dir, args)
    await run('init', '-q', '-b', 'main')
    await run('config', 'user.email', 'test@example.com')
    await run('config', 'user.name', 'Test')
    await writeFile(join(dir, 'a.txt'), 'a\n')
    await run('add', '.')
    await run('commit', '-q', '-m', 'init')
    await run('branch', 'feat/x')
    await run('tag', 'v1.0')
    await run('update-ref', 'refs/remotes/origin/main', 'HEAD') // remote branches stay out

    const refs = await readRefList(dir, 100)
    assert.deepEqual(refs.branches.map((b) => b.name).sort(), ['feat/x', 'main'])
    assert.ok(refs.branches.find((b) => b.name === 'main')?.worktree)
    assert.equal(refs.branches.find((b) => b.name === 'feat/x')?.worktree, null)
    assert.deepEqual(refs.tags, ['v1.0'])

    await run('switch', '-q', '--detach', 'refs/tags/v1.0') // what checkoutTag runs
    assert.equal((await run('rev-parse', '--abbrev-ref', 'HEAD')).trim(), 'HEAD')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/** A repo with: a root commit, then a commit that edits, renames and touches glob-named files. */
async function diffRepo(): Promise<{ dir: string; root: string; head: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'finline-diff-'))
  const run = (...args: string[]) => git(dir, args)
  await run('init', '-q')
  await run('config', 'user.email', 'test@example.com')
  await run('config', 'user.name', 'Test')
  const body = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`)
  await mkdir(join(dir, 'sub'))
  await writeFile(join(dir, 'sub', 'big.txt'), body.join('\n') + '\n')
  await writeFile(join(dir, 'old-name.txt'), 'one\ntwo\nthree\nfour\n')
  await writeFile(join(dir, '[id].tsx'), 'bracket\n')
  await writeFile(join(dir, 'i.tsx'), 'plain\n')
  await run('add', '.')
  await run('commit', '-q', '-m', 'root')
  const root = (await run('rev-parse', 'HEAD')).trim()
  body[99] = 'line one hundred'
  await writeFile(join(dir, 'sub', 'big.txt'), body.join('\n') + '\n')
  await run('mv', 'old-name.txt', 'new-name.txt')
  await writeFile(join(dir, 'new-name.txt'), 'one\ntwo\nthree\nFOUR\n')
  await writeFile(join(dir, '[id].tsx'), 'bracket 2\n')
  await writeFile(join(dir, 'i.tsx'), 'plain 2\n')
  await run('add', '-A')
  await run('commit', '-q', '-m', 'second')
  const head = (await run('rev-parse', 'HEAD')).trim()
  return { dir, root, head }
}

const files = (patch: string) => (patch.match(/^diff --git /gm) ?? []).length
const changed = (patch: string) => parsePatch(patch).hunks.flatMap((h) => h.lines.filter((l) => l.kind !== ' '))

test('file diff of a commit is the whole file against its first parent', async () => {
  const { dir, root, head } = await diffRepo()
  try {
    const diff = await readFileDiff(dir, { rev: head, file: 'sub/big.txt' })
    assert.equal(diff.oldRev, root)
    assert.equal(diff.newRev, head)
    assert.equal(diff.partial, false)
    assert.equal(diff.truncated, false)
    const { hunks } = parsePatch(diff.patch)
    assert.equal(hunks.length, 1)
    assert.equal(hunks[0].lines.length, 201) // 199 unchanged, one removed, one added
    assert.deepEqual(changed(diff.patch), [
      { kind: '-', text: 'line 100' },
      { kind: '+', text: 'line one hundred' }
    ])
    // Paths are relative to the repository root, wherever the workspace sits inside it.
    const fromSub = await readFileDiff(join(dir, 'sub'), { rev: head, file: 'sub/big.txt' })
    assert.equal(fromSub.patch, diff.patch)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('file diff of a root commit has nothing on the left', async () => {
  const { dir, root } = await diffRepo()
  try {
    const diff = await readFileDiff(dir, { rev: root, file: 'i.tsx' })
    assert.equal(diff.oldRev, null)
    assert.equal(diff.newRev, root)
    assert.deepEqual(changed(diff.patch), [{ kind: '+', text: 'plain' }])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('file diff follows a rename', async () => {
  const { dir, head } = await diffRepo()
  try {
    const diff = await readFileDiff(dir, { rev: head, file: 'new-name.txt', from: 'old-name.txt' })
    assert.equal(files(diff.patch), 1)
    assert.match(diff.patch, /^rename from old-name\.txt$/m)
    assert.deepEqual(changed(diff.patch), [
      { kind: '-', text: 'four' },
      { kind: '+', text: 'FOUR' }
    ])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('file diff shows a file renamed without a change as all added', async () => {
  const { dir } = await diffRepo()
  try {
    await git(dir, ['mv', 'i.tsx', 'moved.tsx'])
    await git(dir, ['commit', '-q', '-m', 'move'])
    const head = (await git(dir, ['rev-parse', 'HEAD'])).trim()
    const diff = await readFileDiff(dir, { rev: head, file: 'moved.tsx', from: 'i.tsx' })
    assert.equal(diff.from, 'i.tsx')
    assert.deepEqual(changed(diff.patch), [{ kind: '+', text: 'plain 2' }])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('file diff takes a name with glob characters literally', async () => {
  const { dir, head } = await diffRepo()
  try {
    const diff = await readFileDiff(dir, { rev: head, file: '[id].tsx' })
    assert.equal(files(diff.patch), 1)
    assert.deepEqual(changed(diff.patch), [
      { kind: '-', text: 'bracket' },
      { kind: '+', text: 'bracket 2' }
    ])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('file diff of the working tree covers edits and untracked files', async () => {
  const { dir, head } = await diffRepo()
  try {
    await writeFile(join(dir, 'i.tsx'), 'plain 3\n')
    await writeFile(join(dir, 'fresh.txt'), 'a\nb') // untracked, no final newline
    await writeFile(join(dir, 'blob.bin'), Buffer.from([1, 0, 2]))
    const edit = await readFileDiff(dir, { rev: 'worktree', file: 'i.tsx' })
    assert.equal(edit.oldRev, head)
    assert.equal(edit.newRev, null)
    assert.deepEqual(changed(edit.patch), [
      { kind: '-', text: 'plain 2' },
      { kind: '+', text: 'plain 3' }
    ])
    const fresh = await readFileDiff(dir, { rev: 'worktree', file: 'fresh.txt' })
    assert.equal(fresh.oldRev, null)
    assert.deepEqual(changed(fresh.patch), [
      { kind: '+', text: 'a' },
      { kind: '+', text: 'b' }
    ])
    assert.equal(parsePatch((await readFileDiff(dir, { rev: 'worktree', file: 'blob.bin' })).patch).binary, true)
    // A file with no changes at all has an empty patch.
    assert.equal((await readFileDiff(dir, { rev: 'worktree', file: 'new-name.txt' })).patch, '')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('file diff too big for one answer falls back to changed regions, then is cut', async () => {
  const { dir, head } = await diffRepo()
  try {
    const partial = await readFileDiff(dir, { rev: head, file: 'sub/big.txt' }, undefined, 800)
    assert.equal(partial.partial, true)
    assert.equal(partial.truncated, false)
    assert.equal(parsePatch(partial.patch).hunks[0].lines.length, 8) // 3 + 2 + 3
    const cut = await readFileDiff(dir, { rev: head, file: 'sub/big.txt' }, undefined, 150)
    assert.equal(cut.partial, true)
    assert.equal(cut.truncated, true)
    assert.ok(cut.patch.length <= 150)
    assert.ok(cut.patch.endsWith('\n'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// A ticket is a file anyone can commit, so its `rev` is untrusted: a hex string can name a blob,
// and `git show` prints a blob's content, which must never become git arguments.
test('refuses a rev that is not a commit, whatever the object holds', async () => {
  const { dir } = await diffRepo()
  const target = join(dir, 'PWNED')
  try {
    await writeFile(join(dir, 'payload'), `--output=${target} HEAD`)
    const blob = (await git(dir, ['hash-object', '-w', 'payload'])).trim()
    await assert.rejects(readFileDiff(dir, { rev: blob, file: 'i.tsx' }))
    await assert.rejects(readCommitDetails(dir, blob, 100))
    await assert.rejects(access(target))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the size limit counts the bytes of the answer, not characters', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'finline-cjk-'))
  try {
    const run = (...args: string[]) => git(dir, args)
    await run('init', '-q')
    await run('config', 'user.email', 'test@example.com')
    await run('config', 'user.name', 'Test')
    const body = Array.from({ length: 300 }, () => 'あ'.repeat(20))
    await writeFile(join(dir, 'ja.txt'), body.join('\n') + '\n')
    await run('add', '.')
    await run('commit', '-q', '-m', 'one')
    body[150] = 'い'.repeat(20)
    await writeFile(join(dir, 'ja.txt'), body.join('\n') + '\n')
    await run('commit', '-q', '-am', 'two')
    const head = (await run('rev-parse', 'HEAD')).trim()
    // About 6,700 characters whole, but about 19,000 bytes as JSON.
    const diff = await readFileDiff(dir, { rev: head, file: 'ja.txt' }, undefined, 10_000)
    assert.equal(diff.partial, true)
    assert.equal(diff.truncated, false)
    const cut = await readFileDiff(dir, { rev: head, file: 'ja.txt' }, undefined, 400)
    assert.equal(cut.truncated, true)
    assert.ok(Buffer.byteLength(JSON.stringify(cut.patch)) <= 400)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('stashes are listed apart from the graph, with their base and untracked files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'finline-stash-'))
  try {
    const run = (...args: string[]) => git(dir, args)
    await run('init', '-q', '-b', 'main')
    await run('config', 'user.email', 'test@example.com')
    await run('config', 'user.name', 'Test')
    await writeFile(join(dir, 'a.txt'), 'a\n')
    await run('add', '.')
    await run('commit', '-q', '-m', 'init')
    const head = (await run('rev-parse', 'HEAD')).trim()
    assert.deepEqual(await readStashes(dir, 10), [])

    await writeFile(join(dir, 'a.txt'), 'a\nb\n')
    await run('stash', 'push', '-q')
    await writeFile(join(dir, 'a.txt'), 'a\nc\n')
    await writeFile(join(dir, 'new.txt'), 'n\n')
    await run('stash', 'push', '-q', '--include-untracked', '-m', 'with: a colon')

    const stashes = await readStashes(dir, 10)
    assert.deepEqual(
      stashes.map((s) => [s.index, s.message, s.branch, s.base, Boolean(s.untracked)]),
      [
        [0, 'with: a colon', 'main', head, true],
        [1, 'WIP on main', 'main', head, false]
      ]
    )
    assert.equal(await stashAt(dir, 1), stashes[1].hash)
    assert.equal(await stashAt(dir, 2), null)
    assert.deepEqual(await readUntrackedOfStash(dir, stashes[0].untracked!), [
      { status: 'A', path: 'new.txt', added: 1, deleted: 0, untracked: true, rev: stashes[0].untracked }
    ])
    // The graph has the real commit only: no stash, no helper commits.
    assert.deepEqual((await readCommits(dir, { skip: 0, limit: 10, remotes: [] })).map((c) => c.hash), [head])
    assert.equal((await readStashes(dir, 1)).length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
