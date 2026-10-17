// Text matching shared by quote verification (worker) and the PDF highlighter (browser).

/** Letters and digits only, lower case: robust to line breaks, hyphenation and spacing. */
export const fold = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '')

/** 1-based page on which the quote occurs, preferring `hint`; null if it occurs nowhere. */
export function findQuotePage(pages: string[], quote: string, hint?: number): number | null {
  const q = fold(quote)
  if (q.length < 20) return null // too short to be a meaningful, verifiable citation
  if (hint && pages[hint - 1] && fold(pages[hint - 1]).includes(q)) return hint
  const i = pages.findIndex((p) => fold(p).includes(q))
  return i >= 0 ? i + 1 : null
}
