/** PDFs served from /public/sources (kept out of git until publication is cleared). */
export const SOURCE_FILES: Record<string, string> = {
  S01: '/sources/S01.pdf',
  S02: '/sources/S02.pdf',
  S03: '/sources/S03.pdf',
  S04: '/sources/S04.pdf',
}

export interface SourceRef {
  source: string
  page: number
  quote?: string
  title?: string
}

/** First page number in a citation like "p.17", "Table 1 (p.6)" or "p.16–18". */
export function pageOf(page?: string): number | null {
  const m = page?.match(/p\.\s*(\d+)/)
  return m ? Number(m[1]) : null
}

/** URL of a document's PDF: bundled originals or expert uploads served by the worker. */
export function fileUrlFor(id: string): string | undefined {
  return SOURCE_FILES[id] ?? (id.startsWith('u-') ? `/api/docs/${encodeURIComponent(id)}/file` : undefined)
}
