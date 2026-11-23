// A unified diff as rows for a side-by-side view. Pure and dependency-free, so the diff editor
// frame runs it and `node --test` covers it.

export interface Hunk {
  oldStart: number
  newStart: number
  lines: { kind: ' ' | '-' | '+'; text: string }[]
}

export interface Patch {
  /** git had no text to compare ("Binary files … differ"). */
  binary: boolean
  hunks: Hunk[]
}

export interface Cell {
  /** 1-based line number in its own file. */
  no: number
  text: string
  kind: 'context' | 'del' | 'add'
}

/** One line of the view: both files side by side, or a gap where unchanged lines were left out. */
export type Row = { gap: true } | { gap?: false; left: Cell | null; right: Cell | null }

export interface Segment {
  text: string
  changed: boolean
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/**
 * Parses `git diff` output for one file. A hunk's length comes from its header, so a removed
 * line that reads `--- a/x` is never taken for the next file's header.
 */
export function parsePatch(patch: string): Patch {
  const hunks: Hunk[] = []
  let binary = false
  let hunk: Hunk | null = null
  let oldLeft = 0
  let newLeft = 0
  const lines = patch.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      const mark = line[0]
      if (mark === '\\') continue // "\ No newline at end of file"
      const text = line.slice(1)
      if (mark === '-') {
        hunk.lines.push({ kind: '-', text })
        oldLeft--
      } else if (mark === '+') {
        hunk.lines.push({ kind: '+', text })
        newLeft--
      } else {
        // A context line; some tools drop the leading space of an empty one.
        hunk.lines.push({ kind: ' ', text })
        oldLeft--
        newLeft--
      }
      continue
    }
    const header = HUNK.exec(line)
    if (header) {
      hunk = { oldStart: Number(header[1]), newStart: Number(header[3]), lines: [] }
      oldLeft = header[2] === undefined ? 1 : Number(header[2])
      newLeft = header[4] === undefined ? 1 : Number(header[4])
      hunks.push(hunk)
    } else if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      binary = true
    }
  }
  return { binary, hunks }
}

/**
 * Lays hunks out in two columns. Inside a hunk a run of removed lines followed by a run of added
 * ones is one change: its lines pair up row by row, and the longer side runs on beside nothing.
 */
export function splitRows(hunks: readonly Hunk[]): Row[] {
  const rows: Row[] = []
  let oldNext = 1
  let newNext = 1
  for (const hunk of hunks) {
    const oldStart = Math.max(hunk.oldStart, 1)
    const newStart = Math.max(hunk.newStart, 1)
    if (oldStart !== oldNext || newStart !== newNext) rows.push({ gap: true })
    let oldNo = oldStart
    let newNo = newStart
    let dels: Cell[] = []
    let adds: Cell[] = []
    const flush = () => {
      for (let i = 0; i < Math.max(dels.length, adds.length); i++) {
        rows.push({ left: dels[i] ?? null, right: adds[i] ?? null })
      }
      dels = []
      adds = []
    }
    for (const { kind, text } of hunk.lines) {
      if (kind === '-') {
        if (adds.length > 0) flush()
        dels.push({ no: oldNo++, text, kind: 'del' })
      } else if (kind === '+') {
        adds.push({ no: newNo++, text, kind: 'add' })
      } else {
        flush()
        rows.push({ left: { no: oldNo++, text, kind: 'context' }, right: { no: newNo++, text, kind: 'context' } })
      }
    }
    flush()
    oldNext = oldNo
    newNext = newNo
  }
  return rows
}

const TOKEN = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu

/**
 * What changed inside a modified line: the tokens two lines share at their start and end stay
 * plain, the middle is marked. Null when they share nothing worth showing (only whitespace, or
 * nothing at all), since the row's colour already says the whole line changed.
 */
export function wordDiff(a: string, b: string): { left: Segment[]; right: Segment[] } | null {
  if (a === b) return null
  const ta = a.match(TOKEN) ?? []
  const tb = b.match(TOKEN) ?? []
  const max = Math.min(ta.length, tb.length)
  let prefix = 0
  while (prefix < max && ta[prefix] === tb[prefix]) prefix++
  let suffix = 0
  while (suffix < max - prefix && ta[ta.length - 1 - suffix] === tb[tb.length - 1 - suffix]) suffix++
  const shared = [...ta.slice(0, prefix), ...ta.slice(ta.length - suffix)].join('')
  if (shared.trim() === '') return null
  const side = (tokens: string[]): Segment[] => {
    const parts: Segment[] = [
      { text: tokens.slice(0, prefix).join(''), changed: false },
      { text: tokens.slice(prefix, tokens.length - suffix).join(''), changed: true },
      { text: tokens.slice(tokens.length - suffix).join(''), changed: false }
    ].filter((part) => part.text !== '')
    // An empty middle leaves two plain parts side by side: make them one.
    return parts.reduce<Segment[]>((out, part) => {
      const last = out[out.length - 1]
      if (last && last.changed === part.changed) last.text += part.text
      else out.push(part)
      return out
    }, [])
  }
  return { left: side(ta), right: side(tb) }
}

/**
 * The side that holds every line when the other has none: 'new' for an added file (or one shown
 * whole after a rename), 'old' for a deleted one. Null when both sides have lines to compare.
 */
export function onlySide(rows: readonly Row[]): 'old' | 'new' | null {
  let left = false
  let right = false
  for (const row of rows) {
    if (row.gap) continue
    left ||= row.left !== null
    right ||= row.right !== null
    if (left && right) return null
  }
  return left ? 'old' : right ? 'new' : null
}

/** A run of consecutive changed rows: removed, added, or both side by side (`mod`). */
export interface Run {
  kind: 'del' | 'add' | 'mod'
  /** Index of its first row, and the index after its last. */
  from: number
  to: number
}

/** Where the changes are, as runs of rows of one kind, for the overview beside the scrollbar. */
export function changeRuns(rows: readonly Row[]): Run[] {
  const runs: Run[] = []
  rows.forEach((row, index) => {
    if (row.gap) return
    const del = row.left?.kind === 'del'
    const add = row.right?.kind === 'add'
    if (!del && !add) return
    const kind = del && add ? 'mod' : del ? 'del' : 'add'
    const last = runs[runs.length - 1]
    if (last && last.kind === kind && last.to === index) last.to = index + 1
    else runs.push({ kind, from: index, to: index + 1 })
  })
  return runs
}
