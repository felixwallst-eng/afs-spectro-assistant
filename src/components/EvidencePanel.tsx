import { useEffect, useState } from 'react'
import type { BriefResponse } from '../../shared/agent.ts'
import CiteLink from './CiteLink.tsx'

export type BriefState = { status: 'idle' } | { status: 'loading'; since: number } | { status: 'error'; error: string } | { status: 'done'; data: BriefResponse }

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [])
  return <>{Math.max(0, Math.round((now - since) / 1000))} s</>
}

/** Key findings for the enquiry, each with a verified quote that opens the highlighted PDF passage. */
export default function EvidencePanel({ state, onRetry }: { state: BriefState; onRetry: () => void }) {
  if (state.status === 'idle') return null
  return (
    <section className="panel evidence">
      <div className="panel-head">
        <h2>Evidence from the knowledge base</h2>
        <span className="hint">Every finding quotes the AFS document it is based on – click the source to see the passage.</span>
        {state.status !== 'loading' && (
          <button className="linkbtn right" onClick={onRetry}>
            Run again
          </button>
        )}
      </div>
      <div className="panel-body">
        {state.status === 'loading' && (
          <p className="ev-wait">
            Searching the documents and checking every quote… <Elapsed since={state.since} />
          </p>
        )}
        {state.status === 'error' && <p className="error">{state.error}</p>}
        {state.status === 'done' && (
          <>
            {state.data.findings.length === 0 ? (
              <p className="ev-wait">No finding with a verifiable source – the enquiry may be outside the AFS material.</p>
            ) : (
              <ol className="ev-list">
                {state.data.findings.map((f, i) => (
                  <li key={i}>
                    <p className="ev-statement">{f.statement}</p>
                    <p className="ev-quote">
                      “{f.quote}”
                      <CiteLink c={{ source: f.docId, page: `p.${f.page}` }} quote={f.quote} />
                    </p>
                  </li>
                ))}
              </ol>
            )}
            <p className="ev-meta">
              {state.data.model} · {state.data.pagesRead.length} pages read · {(state.data.latencyMs / 1000).toFixed(1)} s ·{' '}
              {state.data.findings.length} quotes verified
              {state.data.withheld > 0 && ` · ${state.data.withheld} withheld (quote not found in the document)`}
            </p>
          </>
        )}
      </div>
    </section>
  )
}
