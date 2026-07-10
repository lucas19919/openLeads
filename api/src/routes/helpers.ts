import type { AppContext } from './middleware'

// Small response/request helpers shared by the route modules.

/** CSV download with a UTF-8 BOM so Excel renders umlauts correctly. */
export function csvResponse(c: AppContext, body: string, filename: string) {
  c.header('Content-Type', 'text/csv; charset=utf-8')
  c.header('Content-Disposition', `attachment; filename="${filename}"`)
  return c.body('﻿' + body)
}

/** Inline file response with an RFC 5987 filename* for non-ASCII names. */
export function inlineFile(c: AppContext, file: { data: Uint8Array; name: string; mime: string }) {
  c.header('Content-Type', file.mime)
  const asciiName = file.name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')
  c.header(
    'Content-Disposition',
    `inline; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
  )
  return c.body(Buffer.from(file.data) as unknown as ArrayBuffer)
}

// Allowed uploads for receipts and signed documents: a PDF or a photo/scan,
// capped so a stray huge file can't bloat the DB.
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024 // 10 MB
export const UPLOAD_MIMES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/gif',
  'image/tiff',
])

export interface UploadedFile {
  data: Uint8Array
  name: string
  mime: string
}

export type UploadResult =
  | { ok: true; file: UploadedFile }
  | { ok: false; status: 400 | 413 | 415; error: string }

/**
 * Read + validate the multipart "file" field (PDF/image, ≤ 10 MB). The one
 * implementation behind expense receipts and signed-document uploads.
 */
export async function readUpload(c: AppContext, fallbackName: string): Promise<UploadResult> {
  const form = await c.req.parseBody()
  const file = form['file']
  if (!(file instanceof File)) return { ok: false, status: 400, error: 'Keine Datei hochgeladen.' }
  if (file.size > UPLOAD_MAX_BYTES) return { ok: false, status: 413, error: 'Datei zu groß (max. 10 MB).' }
  const mime = file.type || 'application/octet-stream'
  if (!UPLOAD_MIMES.has(mime)) {
    return { ok: false, status: 415, error: 'Nicht unterstütztes Format — PDF oder Bild (PNG/JPEG/…) erwartet.' }
  }
  const data = new Uint8Array(await file.arrayBuffer())
  return { ok: true, file: { data, name: file.name || fallbackName, mime } }
}
