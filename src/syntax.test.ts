import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { join } from 'node:path'

// Orca loads the sources as-is, so a syntax error anywhere (e.g. a raw line break inside a
// quoted string) stops the worker or the panel from starting. Most files have no test that
// imports them, so parse every one here.
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return entry.name.endsWith('.ts') ? [path] : []
  })
}

test('every TypeScript source parses', () => {
  const files = sources(import.meta.dirname)
  assert.ok(files.some((f) => f.endsWith('worker.ts')))
  for (const file of files) {
    assert.doesNotThrow(() => stripTypeScriptTypes(readFileSync(file, 'utf8')), file)
  }
})
