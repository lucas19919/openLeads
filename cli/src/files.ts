import { writeFileSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import type { FileResponse } from './client.js'
import { print, warn } from './output.js'

// Where downloads go. `-o -` means stdout, so a PDF or a CSV can be piped
// straight into another tool; a directory keeps the server's own filename.
// That is the difference between a command you can script and one you cannot.

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Save a binary payload. Returns the path written, or null when piped out. */
export function saveFile(file: FileResponse, target: string | undefined): string | null {
  if (target === '-') {
    process.stdout.write(file.data)
    return null
  }
  const path =
    target === undefined || isDirectory(target)
      ? resolve(target ?? '.', file.filename)
      : resolve(target)
  writeFileSync(path, file.data)
  return path
}

/** Save text (a CSV export). No target → straight to stdout. */
export function saveText(text: string, target: string | undefined, filename?: string): string | null {
  if (!target || target === '-') {
    process.stdout.write(text.endsWith('\n') ? text : text + '\n')
    return null
  }
  const path = isDirectory(target) && filename ? join(resolve(target), filename) : resolve(target)
  writeFileSync(path, text, 'utf8')
  return path
}

/** Tell the user where a download landed, on stderr so stdout stays clean. */
export function reportSaved(path: string | null, bytes?: number): void {
  if (!path) return
  const size = bytes != null ? ` (${(bytes / 1024).toFixed(1)} KB)` : ''
  if (process.stdout.isTTY) print(`${path}${size}`)
  else warn(`gespeichert: ${path}${size}`)
}
