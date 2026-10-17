import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { TextItem } from 'pdfjs-dist/types/src/display/api'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

/** Extract the text of every page in the browser (same library as the viewer, so quotes match). */
export async function extractPageTexts(file: File): Promise<string[]> {
  return extractFrom(new Uint8Array(await file.arrayBuffer()))
}

export async function extractPageTextsFromUrl(url: string): Promise<string[]> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: ${res.status}`)
  return extractFrom(new Uint8Array(await res.arrayBuffer()))
}

async function extractFrom(data: Uint8Array): Promise<string[]> {
  const doc = await pdfjs.getDocument({ data }).promise
  const pages: string[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent()
    pages.push(
      tc.items
        .filter((it): it is TextItem => 'str' in it)
        .map((it) => it.str + (it.hasEOL ? '\n' : ''))
        .join('')
        .replace(/[ \t]+/g, ' ')
        .trim(),
    )
  }
  await doc.destroy()
  return pages
}
