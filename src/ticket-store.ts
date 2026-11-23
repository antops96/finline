// Writes diff tickets (see ./ticket.ts) into a workspace. With `git.run`, this is the only place
// the worker writes into a repository: the ticket folder, and one line in the repository's local
// exclude file so git never lists that folder.
import { constants } from 'node:fs'
import { appendFile, lstat, mkdir, open, readdir, readFile, rmdir, stat, unlink, utimes } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { staleTickets, TICKET_DIR, TICKET_EXT, ticketPath, ticketText, type Ticket } from './ticket.ts'

const EXCLUDE_LINE = `${TICKET_DIR}/`

/** Adds the ticket folder to `<commonDir>/info/exclude`, which is local and never committed. */
async function excludeTickets(commonDir: string): Promise<void> {
  const file = join(commonDir, 'info', 'exclude')
  const current = await readFile(file, 'utf8').catch(() => '')
  if (current.split(/\r?\n/).includes(EXCLUDE_LINE)) return
  await mkdir(dirname(file), { recursive: true })
  await appendFile(file, `${current === '' || current.endsWith('\n') ? '' : '\n'}${EXCLUDE_LINE}\n`)
}

/** Deletes all but the `keep` newest tickets, never `spare`, and the folders that empties. */
async function prune(root: string, spare: string, keep: number): Promise<void> {
  const base = join(root, TICKET_DIR)
  const entries: { path: string; mtimeMs: number }[] = []
  // Only real folders and real files: a symbolic link here could point anywhere.
  for (const dir of await readdir(base, { withFileTypes: true }).catch(() => [])) {
    if (!dir.isDirectory()) continue
    for (const file of await readdir(join(base, dir.name), { withFileTypes: true }).catch(() => [])) {
      if (!file.isFile() || !file.name.endsWith(TICKET_EXT)) continue
      const path = join(base, dir.name, file.name)
      const info = await stat(path).catch(() => null)
      if (info) entries.push({ path, mtimeMs: info.mtimeMs })
    }
  }
  for (const path of staleTickets(entries, keep)) {
    if (path === spare) continue
    await unlink(path).catch(() => {})
    await rmdir(dirname(path)).catch(() => {}) // fails while other tickets remain, as it should
  }
}

/**
 * Throws unless `path` is missing or is a real folder or file. A repository can carry the ticket
 * folder, or anything in it, as a symbolic link, and writing through one would land outside the
 * workspace.
 */
async function refuseLink(path: string, kind: 'folder' | 'file'): Promise<void> {
  const info = await lstat(path).catch(() => null)
  if (!info) return
  if (info.isSymbolicLink()) throw new Error(`${path} is a symbolic link; Finline won't write a diff ticket through it.`)
  if (kind === 'folder' ? !info.isDirectory() : !info.isFile()) throw new Error(`${path} is not a ${kind}; Finline can't write a diff ticket there.`)
}

/**
 * Writes `ticket` under `root` (the workspace folder, as `fs` opens it) and returns its path
 * relative to `root` with forward slashes, which is what `editor.open` takes.
 */
export async function writeTicket(root: string, commonDir: string, ticket: Ticket, keep = 20): Promise<string> {
  await excludeTickets(commonDir)
  const relative = ticketPath(ticket.rev, ticket.file)
  const full = join(root, ...relative.split('/'))
  const text = ticketText(ticket)
  const base = join(root, TICKET_DIR)
  await refuseLink(base, 'folder')
  await mkdir(base, { recursive: true })
  await refuseLink(dirname(full), 'folder')
  await mkdir(dirname(full), { recursive: true })
  await refuseLink(full, 'file')
  // An open tab watches the file: rewrite it only when it says something else.
  if ((await readFile(full, 'utf8').catch(() => null)) === text) {
    const now = new Date()
    await utimes(full, now, now)
  } else {
    // O_NOFOLLOW (absent on Windows) closes the gap between the check above and this write.
    const handle = await open(full, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0))
    try {
      await handle.writeFile(text)
    } finally {
      await handle.close()
    }
  }
  await prune(root, full, keep)
  return relative
}
