// The ticket: a small file the worker writes into the workspace and opens with `editor.open`, so
// Orca shows the diff editor in a tab. Orca only opens files inside the workspace, and the editor
// frame gets the file's content, never its path, so the content says which diff to show.
// Pure and free of Node APIs: the worker and the diff editor frame both use it.

/** Folder in the workspace that holds tickets; excluded from git through `.git/info/exclude`. */
export const TICKET_DIR = '.finline'
export const TICKET_EXT = '.finline-diff'
/** `rev` of the uncommitted changes: the working tree against HEAD. */
export const WORKTREE_REV = 'worktree'

export interface Ticket {
  v: 1
  /** The repository path, as `graph.load` returned it. */
  repo: string
  /** A commit hash, or `WORKTREE_REV`. */
  rev: string
  file: string
  /** Source path of a rename or copy. */
  from?: string
}

export const isRev = (value: string) => value === WORKTREE_REV || /^[0-9a-f]{4,64}$/i.test(value)

/** A path relative to the repository root that stays inside it. */
export function isSafeRelPath(path: string): boolean {
  if (path.length === 0 || path.includes('\0')) return false
  if (/^([\\/]|[A-Za-z]:)/.test(path)) return false
  return !path.split(/[\\/]/).includes('..')
}

/** FNV-1a, 32 bits, as 8 hex digits. Not for security: it only keeps ticket folders apart. */
function hash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/**
 * Where a diff's ticket lives, relative to the workspace, with forward slashes. The file name is
 * what Orca shows on the tab; the folder keeps two files with the same name apart.
 */
export function ticketPath(rev: string, file: string): string {
  const base = (file.split('/').pop() ?? file).replace(/[<>:"|?*\\\x00-\x1f]/g, '_')
  const label = rev === WORKTREE_REV ? 'changes' : rev.slice(0, 7)
  return `${TICKET_DIR}/${hash(`${rev}\0${file}`)}/${base} (${label})${TICKET_EXT}`
}

export function ticketText(ticket: Ticket): string {
  return JSON.stringify(ticket)
}

export function parseTicket(text: string): Ticket | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const { v, repo, rev, file, from } = value as Record<string, unknown>
  if (v !== 1 || typeof repo !== 'string' || repo.length === 0) return null
  if (typeof rev !== 'string' || !isRev(rev)) return null
  if (typeof file !== 'string' || !isSafeRelPath(file)) return null
  if (from !== undefined && (typeof from !== 'string' || !isSafeRelPath(from))) return null
  return from === undefined ? { v: 1, repo, rev, file } : { v: 1, repo, rev, file, from }
}

/** The tickets to delete: all but the `keep` most recently written. */
export function staleTickets(entries: readonly { path: string; mtimeMs: number }[], keep = 20): string[] {
  return [...entries]
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(keep)
    .map((entry) => entry.path)
}
