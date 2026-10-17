import { useEffect, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { TextItem } from 'pdfjs-dist/types/src/display/api'
import { fileUrlFor } from '../sources.ts'
import type { SourceRef } from '../sources.ts'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

// Letters and digits only, lower case, ligatures unfolded: makes matching robust to
// line breaks, hyphenation, dashes and spacing differences between PDF and quote.
const fold = (c: string) => c.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '')

interface Box {
  left: number
  top: number
  width: number
  height: number
}

const docCache = new Map<string, Promise<PDFDocumentProxy>>()
const loadDoc = (url: string) => {
  if (!docCache.has(url)) docCache.set(url, pdfjs.getDocument(url).promise)
  return docCache.get(url)!
}

export default function SourceViewer({ refTo, onClose }: { refTo: SourceRef; onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [page, setPage] = useState(refTo.page)
  const [pageCount, setPageCount] = useState<number | null>(null)
  const [boxes, setBoxes] = useState<Box[]>([])
  const [status, setStatus] = useState('Loading…')
  const file = fileUrlFor(refTo.source)

  useEffect(() => {
    let cancelled = false
    async function run() {
      if (!file) {
        setStatus(`No PDF available for ${refTo.source}.`)
        return
      }
      try {
        const doc = await loadDoc(file)
        if (cancelled) return
        setPageCount(doc.numPages)
        const p = await doc.getPage(Math.min(Math.max(page, 1), doc.numPages))
        const width = scrollRef.current?.clientWidth ?? 700
        const base = p.getViewport({ scale: 1 })
        const vp = p.getViewport({ scale: (width - 32) / base.width })
        const canvas = canvasRef.current!
        const ratio = window.devicePixelRatio || 1
        canvas.width = vp.width * ratio
        canvas.height = vp.height * ratio
        canvas.style.width = `${vp.width}px`
        canvas.style.height = `${vp.height}px`
        const ctx = canvas.getContext('2d')!
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
        await p.render({ canvasContext: ctx, viewport: vp }).promise
        if (cancelled) return

        if (!refTo.quote || page !== refTo.page) {
          setBoxes([])
          setStatus(refTo.quote && page !== refTo.page ? 'The quoted passage is on another page.' : '')
          return
        }
        // Map every folded character back to (text item, character index).
        const tc = await p.getTextContent()
        const items = tc.items.filter((it): it is TextItem => 'str' in it)
        let hay = ''
        const map: { item: number; idx: number }[] = []
        items.forEach((it, i) => {
          for (let k = 0; k < it.str.length; k++) {
            const f = fold(it.str[k])
            for (const ch of f) {
              hay += ch
              map.push({ item: i, idx: k })
            }
          }
        })
        const needle = fold(refTo.quote)
        const at = needle ? hay.indexOf(needle) : -1
        if (at < 0) {
          setBoxes([])
          setStatus('Passage not found in the text layer – showing the page.')
          return
        }
        // Per text item: highlight the matched character span (proportional width).
        const spans = new Map<number, [number, number]>()
        for (const m of map.slice(at, at + needle.length)) {
          const s = spans.get(m.item)
          spans.set(m.item, s ? [Math.min(s[0], m.idx), Math.max(s[1], m.idx)] : [m.idx, m.idx])
        }
        const out: Box[] = []
        for (const [i, [a, b]] of spans) {
          const it = items[i]
          const [x, y] = vp.convertToViewportPoint(it.transform[4], it.transform[5])
          const w = it.width * vp.scale
          const h = (it.height || Math.abs(it.transform[3])) * vp.scale
          const n = Math.max(it.str.length, 1)
          out.push({ left: x + (w * a) / n, top: y - h, width: (w * (b - a + 1)) / n, height: h * 1.2 })
        }
        setBoxes(out)
        setStatus('')
        const first = Math.min(...out.map((o) => o.top))
        scrollRef.current?.scrollTo({ top: Math.max(0, first - 120), behavior: 'smooth' })
      } catch (e) {
        setStatus(`Could not open ${file}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [file, page, refTo])

  return (
    <div className="viewer-backdrop" onClick={onClose}>
      <aside className="viewer" onClick={(e) => e.stopPropagation()} aria-label="Source document">
        <header className="viewer-head">
          <div>
            <strong>
              {refTo.title ?? refTo.source} · page {page}
              {pageCount ? ` of ${pageCount}` : ''}
            </strong>
            {refTo.quote && <p className="viewer-quote">“{refTo.quote}”</p>}
          </div>
          <div className="viewer-nav">
            <button className="btn small" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              Previous
            </button>
            <button className="btn small" disabled={pageCount !== null && page >= pageCount} onClick={() => setPage(page + 1)}>
              Next
            </button>
            {page !== refTo.page && (
              <button className="btn small" onClick={() => setPage(refTo.page)}>
                Back to quote
              </button>
            )}
            <button className="btn small" onClick={onClose} aria-label="Close">
              Close
            </button>
          </div>
        </header>
        {status && <p className="viewer-status">{status}</p>}
        <div className="viewer-scroll" ref={scrollRef}>
          <div className="viewer-page">
            <canvas ref={canvasRef} />
            {boxes.map((b, i) => (
              <span key={i} className="viewer-hl" style={{ left: b.left, top: b.top, width: b.width, height: b.height }} />
            ))}
          </div>
        </div>
      </aside>
    </div>
  )
}
