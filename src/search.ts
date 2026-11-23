// Searching commits: what a query means, and where it matched. Pure and free of Node and DOM
// APIs, so the worker filters with it, the panel highlights with it, and `node --test` covers it.

const MAX_TERMS = 8
const MAX_TERM = 100

/** A query's words, lower-cased: a commit matches when it has every one of them. */
export function searchTerms(query: string): string[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => term.slice(0, MAX_TERM))
  return [...new Set(terms)].slice(0, MAX_TERMS)
}

/** True when `text` contains every term, whatever the case. */
export function hasAllTerms(text: string, terms: readonly string[]): boolean {
  const lower = text.toLowerCase()
  return terms.every((term) => lower.includes(term))
}

/**
 * The first line of a commit body that has one of the terms, cut to `max` characters around the
 * match; null when none has.
 */
export function excerptOf(body: string, terms: readonly string[], max = 160): string | null {
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim()
    const lower = line.toLowerCase()
    const at = terms.reduce((first, term) => {
      const index = lower.indexOf(term)
      return index >= 0 && (first < 0 || index < first) ? index : first
    }, -1)
    if (at < 0) continue
    if (line.length <= max) return line
    const start = Math.max(0, Math.min(at - 30, line.length - max))
    return `${start > 0 ? '…' : ''}${line.slice(start, start + max)}${start + max < line.length ? '…' : ''}`
  }
  return null
}

export interface Mark {
  text: string
  /** This part is one of the searched words. */
  hit: boolean
}

/** Splits text at every occurrence of a term, so the panel can highlight them. */
export function splitMarks(text: string, terms: readonly string[]): Mark[] {
  if (terms.length === 0 || text === '') return text === '' ? [] : [{ text, hit: false }]
  const lower = text.toLowerCase()
  // Longer terms first, so "feature" wins over "feat" where both start.
  const sorted = [...terms].sort((a, b) => b.length - a.length)
  const marks: Mark[] = []
  let plain = 0
  let at = 0
  while (at < text.length) {
    const term = sorted.find((t) => t !== '' && lower.startsWith(t, at))
    if (!term) {
      at++
      continue
    }
    if (at > plain) marks.push({ text: text.slice(plain, at), hit: false })
    marks.push({ text: text.slice(at, at + term.length), hit: true })
    at += term.length
    plain = at
  }
  if (plain < text.length) marks.push({ text: text.slice(plain), hit: false })
  return marks
}
