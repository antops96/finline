// Writes diff tickets (see ./ticket.ts) into a workspace. With `git.run`, this is the only place
// the worker writes into a repository: the ticket folder, and one line in the repository's local
// exclude file so git never lists that folder.
import { appendFile, mkdir, readdir, readFile, rmdir, stat, unlink, utimes, writeFile } from 'node:fs/promises'
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
  for (const dir of await readdir(base).catch(() => [])) {
    for (const name of await readdir(join(base, dir)).catch(() => [])) {
      if (!name.endsWith(TICKET_EXT)) continue
      const path = join(base, dir, name)
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
 * Writes `ticket` under `root` (the workspace folder, as `fs` opens it) and returns its path
 * relative to `root` with forward slashes, which is what `editor.open` takes.
 */
export async function writeTicket(root: string, commonDir: string, ticket: Ticket, keep = 20): Promise<string> {
  await excludeTickets(commonDir)
  const relative = ticketPath(ticket.rev, ticket.file)
  const full = join(root, ...relative.split('/'))
  const text = ticketText(ticket)
  await mkdir(dirname(full), { recursive: true })
  // An open tab watches the file: rewrite it only when it says something else.
  if ((await readFile(full, 'utf8').catch(() => null)) === text) {
    const now = new Date()
    await utimes(full, now, now)
  } else {
    await writeFile(full, text)
  }
  await prune(root, full, keep)
  return relative
}
