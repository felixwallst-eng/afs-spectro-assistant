import type { Citation } from '../../shared/types.ts'
import { useOpenSource } from '../sourceContext.ts'
import { fileUrlFor, pageOf } from '../sources.ts'

/** Citation chip; opens the PDF at the cited page when the document is available. */
export default function CiteLink({ c, quote }: { c?: Citation; quote?: string }) {
  const open = useOpenSource()
  if (!c) return <span />
  const label = `${c.source}${c.page ? ' ' + c.page : ''}`
  const page = pageOf(c.page) ?? 1
  if (!fileUrlFor(c.source)) return <span className="cite">{label}</span>
  return (
    <button className="cite cite-link" title="Open source" onClick={() => open({ source: c.source, page, quote: quote ?? c.quote })}>
      {label}
    </button>
  )
}
