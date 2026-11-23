// Finline diff editor: a custom editor for `.finline-diff` tickets (see ../ticket.ts). The ticket
// only says which file of which commit to show; the diff itself comes from the worker
// (`file.diff`) and is laid out here in two columns, old on the left and new on the right.
// Code is coloured by ../highlight.ts, in a palette for Orca's light theme and one for its dark.
// Read-only: it never edits the ticket.
import { changeRuns, onlySide, parsePatch, splitRows, wordDiff, type Cell, type Row, type Run, type Segment } from '../diff.ts'
import { highlightLine, languageOf, mergeSegments, type Language, type LineState } from '../highlight.ts'
import { el, icon } from '../graph/dom.ts'
import { orca as frame, type Disposable, type FrameOrca } from '../graph/frame.ts'
import { parseTicket, WORKTREE_REV, type Ticket } from '../ticket.ts'
import type { DiffLoad, FileDiff } from '../types.ts'

interface OrcaDocument {
  version: number
  readOnly: boolean
  content?: { kind: 'text'; text: string } | { kind: 'bytes' }
}

const orca = frame as FrameOrca & {
  document: {
    get(): Promise<OrcaDocument>
    onDidChange(handler: (doc: OrcaDocument) => void): Disposable
  }
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const pathEl = $('path')
const statEl = $('stat')
const navEl = $('nav')
const countEl = $('count')
const bannerEl = $('banner')
const sidesEl = $('sides')
const oldSideEl = $('old-side')
const newSideEl = $('new-side')
const bodyEl = $('body')
const rowsEl = $('rows')
const mapEl = $('map')
const mapTrackEl = $('map-track')
const noticeEl = $('notice')

$('prev').append(icon('M4 10l4-4 4 4'))
$('next').append(icon('M4 6l4 4 4-4'))
$('refresh').append(icon('M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3'))

let ticket: Ticket | null = null
/** The ticket text on screen, so a document Orca sends again unchanged doesn't reload. */
let shown: string | null = null
let seq = 0
/** First row of each run of changed lines, for previous/next. */
let changes: HTMLElement[] = []
let current = -1

const short = (rev: string) => rev.slice(0, 7)

function showNotice(text: string, retry = false): void {
  bodyEl.hidden = true
  sidesEl.hidden = true
  navEl.hidden = true
  noticeEl.replaceChildren(el('p', '', text))
  if (retry) {
    const button = el('button', 'button', 'Retry')
    button.type = 'button'
    button.addEventListener('click', () => void load(true))
    noticeEl.append(button)
  }
  noticeEl.hidden = false
}

function renderPath(file: string, from?: string): void {
  const parts = (path: string): Node[] => {
    const cut = path.lastIndexOf('/') + 1
    return [el('span', 'dir', path.slice(0, cut)), el('span', 'base', path.slice(cut))]
  }
  pathEl.replaceChildren(...(from ? [...parts(from), el('span', 'arrow', '→')] : []), ...parts(file))
  pathEl.title = from ? `${from} → ${file}` : file
}

// A line this long is minified or generated: colouring it costs more than it tells.
const MAX_COLOURED = 2000

/** One file's side of the diff: its language, and the state its next line starts in. */
interface Side {
  lang: Language | null
  state: LineState
}

/** The line's number and its code: syntax colours, with the changed parts of a modified line marked. */
function codeCell(cell: Cell | null, segments: Segment[] | null, side: Side): HTMLElement[] {
  if (!cell) return [el('span', 'no empty'), el('span', 'code empty')]
  const code = el('span', `code ${cell.kind}`)
  let tokens = [{ text: cell.text, kind: null }] as ReturnType<typeof highlightLine>['tokens']
  if (side.lang && cell.text.length <= MAX_COLOURED) {
    const lit = highlightLine(side.lang, cell.text, side.state)
    tokens = lit.tokens
    side.state = lit.state
  }
  for (const piece of mergeSegments(tokens, segments)) {
    const cls = `${piece.kind ? `t-${piece.kind}` : ''}${piece.changed ? ' chg' : ''}`.trim()
    code.append(cls ? el('span', cls, piece.text) : piece.text)
  }
  return [el('span', `no ${cell.kind}`, String(cell.no)), code]
}

/**
 * `only` is the side to draw alone, across the whole width: an added or deleted file has
 * nothing on the other side to stand beside.
 */
function renderRows(rows: Row[], oldLang: Language | null, newLang: Language | null, only: 'old' | 'new' | null): void {
  const fragment = document.createDocumentFragment()
  rowNodes = []
  changes = []
  let inChange = false
  let lastNo = 1
  // Each file's lines come in order, so a comment or string open on one line carries to the next.
  const old: Side = { lang: oldLang, state: null }
  const fresh: Side = { lang: newLang, state: null }
  for (const row of rows) {
    if (row.gap) {
      const gap = el('div', 'gap', '⋯')
      rowNodes.push(gap)
      fragment.append(gap)
      inChange = false
      // Lines were left out: what the next one starts inside of is unknown.
      old.state = null
      fresh.state = null
      continue
    }
    const { left, right } = row
    const node = el('div', 'row')
    // A removed line beside an added one is one line that changed: mark what differs inside it.
    const words = left && right && left.kind === 'del' ? wordDiff(left.text, right.text) : null
    if (only !== 'new') node.append(...codeCell(left, words?.left ?? null, old))
    if (only !== 'old') node.append(...codeCell(right, words?.right ?? null, fresh))
    rowNodes.push(node)
    const changed = left?.kind !== 'context'
    if (changed && !inChange) changes.push(node)
    inChange = changed
    lastNo = Math.max(lastNo, left?.no ?? 0, right?.no ?? 0)
    fragment.append(node)
  }
  rowsEl.style.setProperty('--no-w', `${String(lastNo).length + 2}ch`)
  rowsEl.classList.toggle('single', only !== null)
  rowsEl.replaceChildren(fragment)
}

// ---- Overview: where the changes are, beside the scrollbar -----------------------------------

/** The element of each row, gaps included, in the order of the rows the runs index. */
let rowNodes: HTMLElement[] = []
let runs: Run[] = []
const mapViewEl = el('div', 'map-view')

/**
 * Draws a mark per run of changes at its place in the file: red for removed lines, green for
 * added, both halves for changed ones. Lines wrap, so places come from where the rows really are.
 * A file shorter than the view keeps its marks beside its lines.
 */
function drawMap(): void {
  const first = rowNodes[0]
  const last = rowNodes[rowNodes.length - 1]
  if (!first || !last || bodyEl.hidden) return
  const top = first.getBoundingClientRect().top
  const total = last.getBoundingClientRect().bottom - top
  if (total <= 0) return
  const track = Math.min(mapEl.clientHeight, total)
  mapTrackEl.style.height = `${track}px`
  const marks = runs.map((run) => {
    const from = rowNodes[run.from].getBoundingClientRect().top - top
    const to = rowNodes[run.to - 1].getBoundingClientRect().bottom - top
    const mark = el('div', `map-mark ${run.kind}`)
    mark.style.top = `${(from / total) * track}px`
    mark.style.height = `${Math.max(2, ((to - from) / total) * track)}px`
    return mark
  })
  mapTrackEl.replaceChildren(...marks, mapViewEl)
  placeMapView()
}

/** The part of the file on screen, as a frame over the marks. */
function placeMapView(): void {
  const { scrollTop, scrollHeight, clientHeight } = rowsEl
  const track = mapTrackEl.clientHeight
  mapViewEl.hidden = scrollHeight <= clientHeight
  mapViewEl.style.top = `${(scrollTop / scrollHeight) * track}px`
  mapViewEl.style.height = `${(clientHeight / scrollHeight) * track}px`
}

/** A press or drag on the overview brings that place of the file to the middle of the view. */
function scrollToMap(event: PointerEvent): void {
  const box = mapTrackEl.getBoundingClientRect()
  const ratio = Math.min(1, Math.max(0, (event.clientY - box.top) / box.height))
  rowsEl.scrollTop = ratio * rowsEl.scrollHeight - rowsEl.clientHeight / 2
}

mapEl.addEventListener('pointerdown', (event) => {
  mapEl.setPointerCapture(event.pointerId)
  scrollToMap(event)
})
mapEl.addEventListener('pointermove', (event) => {
  if (mapEl.hasPointerCapture(event.pointerId)) scrollToMap(event)
})
rowsEl.addEventListener('scroll', placeMapView, { passive: true })

// Resizing rewraps the lines, which moves every change.
let mapFrame = 0
new ResizeObserver(() => {
  cancelAnimationFrame(mapFrame)
  mapFrame = requestAnimationFrame(drawMap)
}).observe(rowsEl)

function goTo(index: number, smooth = true): void {
  if (changes.length === 0) return
  current = (index + changes.length) % changes.length
  countEl.textContent = `${current + 1} / ${changes.length}`
  changes[current].scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' })
}

function render(diff: FileDiff, keepScroll: boolean): void {
  renderPath(diff.file, diff.from)
  const patch = parsePatch(diff.patch)
  const rows = splitRows(patch.hunks)
  const count = (kind: Cell['kind']) =>
    rows.reduce((sum, row) => sum + (row.gap ? 0 : Number(row.left?.kind === kind) + Number(row.right?.kind === kind)), 0)
  statEl.replaceChildren(el('span', 'plus', `+${count('add')}`), el('span', 'minus', `-${count('del')}`))
  statEl.hidden = patch.binary

  const notes: string[] = []
  if (diff.truncated) notes.push('This diff is too big to show whole: it stops early.')
  else if (diff.partial) notes.push('This file is too big to show whole: only the changed parts are here.')
  bannerEl.textContent = notes.join(' ')
  bannerEl.hidden = notes.length === 0

  if (patch.binary) return showNotice('Binary file: there is no text to compare.')
  if (rows.length === 0) {
    return showNotice(diff.truncated ? 'The changed lines are too long to show here.' : 'No changes to the content of this file.')
  }

  // A file with lines on one side only is drawn alone, across the whole width.
  const only = onlySide(rows)
  const newName = diff.newRev ? short(diff.newRev) : 'Working tree'
  oldSideEl.textContent = only === 'old' ? `Deleted · was in ${diff.oldRev ? short(diff.oldRev) : '?'}` : diff.oldRev ? short(diff.oldRev) : 'Not present'
  newSideEl.textContent = only === 'new' ? `${diff.from ? 'Renamed, no changes' : 'New file'} · ${newName}` : newName
  oldSideEl.hidden = only === 'new'
  newSideEl.hidden = only === 'old'
  sidesEl.classList.toggle('single', only !== null)
  const top = rowsEl.scrollTop
  const lang = languageOf(diff.file)
  renderRows(rows, diff.from ? languageOf(diff.from) : lang, lang, only)
  runs = changeRuns(rows)
  noticeEl.hidden = true
  sidesEl.hidden = false
  bodyEl.hidden = false
  drawMap()
  // One block of added or removed lines is all there is: nothing to step through.
  navEl.hidden = changes.length === 0 || only !== null
  if (keepScroll) {
    rowsEl.scrollTop = top
    current = Math.min(current, changes.length - 1)
    countEl.textContent = changes.length > 0 ? `${Math.max(current, 0) + 1} / ${changes.length}` : ''
  } else {
    goTo(0, false)
  }
}

/** `again` reloads what is on screen (a refresh), keeping the scroll position. */
async function load(again: boolean): Promise<void> {
  const mine = ++seq
  if (!ticket) {
    pathEl.replaceChildren()
    return showNotice('This file is not a Finline diff. Open a diff from the Finline panel.')
  }
  const { repo, rev, file, from } = ticket
  if (!again) {
    renderPath(file, from)
    showNotice('Loading…')
  }
  let result: DiffLoad
  try {
    result = await orca.plugin.request('file.diff', { path: repo, rev, file, ...(from === undefined ? {} : { from }) })
  } catch (error) {
    const e = error as { code?: string; message?: string }
    result = { ok: false, message: `${e.code ?? 'error'}: ${e.message ?? String(error)}` }
  }
  if (mine !== seq) return
  if (!result.ok) return showNotice(result.message, true)
  render(result.diff, again && !bodyEl.hidden)
}

function onDocument(doc: OrcaDocument): void {
  const text = doc.content?.kind === 'text' ? doc.content.text : ''
  if (text === shown) return
  shown = text
  ticket = parseTicket(text)
  void load(false)
}

$('prev').addEventListener('click', () => goTo(current - 1))
$('next').addEventListener('click', () => goTo(current + 1))
$('refresh').addEventListener('click', () => void load(true))

// Uncommitted changes move as files are saved; a commit's diff never changes.
const refreshWorktree = () => {
  if (ticket?.rev === WORKTREE_REV) void load(true)
}
orca.plugin.on('worktree.changed', refreshWorktree)
orca.plugin.on('repo.changed', refreshWorktree)

/** Code in the font of Orca's own editor, when the host can tell. */
async function applyTypography(): Promise<void> {
  try {
    const t = await orca.host.call('editor.readTypography', {})
    if (t?.cssFontFamily) document.documentElement.style.setProperty('--code-font', t.cssFontFamily)
    if (t?.fontSize) document.documentElement.style.setProperty('--code-size', `${t.fontSize}px`)
  } catch {
    // An older host: the stylesheet's monospace stack stands.
  }
}
void applyTypography()
try {
  orca.on('editor.typography.changed', () => void applyTypography())
} catch {
  // Not every host delivers this event to editors.
}

orca.document.onDidChange(onDocument)
orca.document.get().then(onDocument, (error) => showNotice(`Could not read the diff ticket: ${(error as Error).message}`))
