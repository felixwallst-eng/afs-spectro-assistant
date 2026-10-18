import { useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { DIMENSIONS, DIM_BY_ID } from '../../shared/dimensions.ts'
import { openRisks } from '../../shared/engine.ts'
import type { OpenRisk } from '../../shared/engine.ts'
import { METHOD_INFO } from '../../shared/knowledge.ts'
import { DECISION_STATUS_TEXT } from '../../shared/report.ts'
import type { ReportEvidence, ReportInput, ReportResponse } from '../../shared/report.ts'
import { TREE_NODES } from '../../shared/tree.ts'
import type { TreeResponse } from '../../shared/tree.ts'
import type { AgentModelKey } from '../../shared/agent.ts'
import type { Assessment, Citation } from '../../shared/types.ts'
import { reportApi } from '../lib.ts'
import { nodeStatus } from '../treeModel.ts'
import CiteLink from './CiteLink.tsx'

interface Props {
  text: string
  tree: TreeResponse
  assessment: Assessment
  overrides: Record<string, string>
  notes: Record<string, string>
  model: AgentModelKey
}

const PRINT_CSS = `
  @page { size: A4 portrait; margin: 18mm 17mm 18mm 17mm; }
  html { background: #e6e9ee; }
  body { font-family: 'Instrument Sans', system-ui, -apple-system, 'Segoe UI', sans-serif; color: #172230; font-size: 10.5pt; line-height: 1.5; margin: 0; }
  /* on screen the print window shows one A4 sheet; in print the sheet is the page itself */
  .report-print { box-sizing: border-box; width: 210mm; min-height: 297mm; margin: 12mm auto; padding: 18mm 17mm; background: #fff; box-shadow: 0 2px 12px rgba(0, 0, 0, .18); }
  @media print {
    html { background: #fff; }
    .report-print { width: auto; min-height: 0; margin: 0; padding: 0; box-shadow: none; }
  }
  h2 { font-size: 15pt; margin: 4px 0 0; }
  h3 { font-size: 8.5pt; text-transform: uppercase; letter-spacing: .06em; color: #2d4fd0; margin: 0 0 4px; }
  .rp-head { display: flex; justify-content: space-between; gap: 20px; border-bottom: 2px solid #172230; padding-bottom: 8px; margin-bottom: 10px; }
  .rp-kicker { font-size: 8pt; text-transform: uppercase; letter-spacing: .08em; color: #5b6877; font-weight: 600; }
  .rp-date { font-size: 9pt; color: #5b6877; white-space: nowrap; }
  .rp-meta { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }
  .rp-team { font-size: 8pt; font-weight: 600; letter-spacing: .04em; color: #2d4fd0; white-space: nowrap; }
  .rp-credit { display: block; margin-top: 4px; font-weight: 600; color: #56657a; }
  .rp-status { background: #f1f4f8; border-left: 3px solid #2d4fd0; padding: 6px 10px; margin: 0 0 4px; }
  .rp-status strong { margin-right: 6px; }
  .rp-block { margin-top: 12px; break-inside: avoid; }
  .rp-block p { margin: 0 0 4px; }
  ul, ol { margin: 0; padding-left: 18px; }
  li { margin-bottom: 2px; }
  .rp-enquiry { margin: 0; padding: 4px 12px; border-left: 3px solid #c9d3df; color: #56657a; font-style: italic; }
  .cite { border: 0; background: none; padding: 0 1px; font: inherit; font-size: 8.5pt; color: #2d4fd0; }
  .rp-cites { margin-left: 2px; }
  .rp-sources { color: #56657a; }
  .rp-premises { border: 1.5px solid #c58a1c; background: #fdf6e7; padding: 8px 12px; margin: 8px 0 0; break-inside: avoid; }
  .rp-premises.block { border-color: #a0384a; background: #fbeef1; }
  .rp-premises ul { margin: 6px 0 0; }
  .rp-sev { font-weight: 700; font-size: 8.5pt; text-transform: uppercase; letter-spacing: .03em; color: #8a5a0c; margin-right: 4px; }
  .rp-premises li.block .rp-sev { color: #a0384a; }
  .rp-provisional { border: 1.5px solid #c58a1c; background: #fdf6e7; padding: 8px 12px; margin: 8px 0 0; break-inside: avoid; }
  .rp-provisional ol { margin: 6px 0 0; }
  .rp-q-step { font-weight: 600; }
  .rp-change { width: 100%; border-collapse: collapse; font-size: 9.5pt; }
  .rp-change th, .rp-change td { text-align: left; vertical-align: top; padding: 4px 6px; border-bottom: 1px solid #dde3ea; }
  .rp-change th { width: 38%; font-weight: 600; }
  .rp-foot { margin-top: 16px; padding-top: 6px; border-top: 1px solid #c9d3df; font-size: 8pt; color: #84909f; }
`

const MAX_RECOMMENDED = 5
const MAX_CONDITIONAL = 3

/** “Drops out if …” / “Becomes conditional if …” for the open steps. */
function riskLines(risks: OpenRisk[]): string[] {
  const by = (status: OpenRisk['status']) => {
    const groups = new Map<string, string[]>()
    for (const r of risks.filter((x) => x.status === status)) groups.set(r.dimensionId, [...(groups.get(r.dimensionId) ?? []), DIM_BY_ID[r.dimensionId].labels[r.label].name])
    return [...groups].map(([id, labels]) => `${DIM_BY_ID[id].title} = ${labels.join(' or ')}`)
  }
  return [...by('excluded').map((t) => `Drops out if ${t}`), ...by('conditional').map((t) => `Becomes conditional if ${t}`)]
}

/** Everything the report may use, collected from the decided path. Evidence gets stable ids E1, E2 … */
function buildInput(p: Props): ReportInput {
  const evidence: ReportEvidence[] = []
  const cite = (source: string, page: string, textOf: string, quote?: string) => {
    const hit = evidence.find((e) => e.source === source && e.page === page && e.text === textOf)
    if (hit) return hit.id
    const id = `E${evidence.length + 1}`
    evidence.push({ id, source, page, text: textOf, ...(quote ? { quote } : {}) })
    return id
  }
  const citeC = (c: Citation | undefined, textOf: string) => (c ? cite(c.source, c.page ?? '', textOf, c.quote) : null)

  const steps: ReportInput['steps'] = TREE_NODES.map((n) => {
    const def = DIM_BY_ID[n.id]
    const d = p.tree.decisions.find((x) => x.id === n.id)
    const status = nodeStatus(n.id, p.tree.decisions, p.overrides)
    const v = p.assessment.dimensions[n.id]?.value
    const known = v && v !== def.unknownLabel
    const shownValue = status === 'suggested' || status === 'conflict' ? (d?.value ?? null) : known ? v : null
    const how: ReportInput['steps'][number]['how'] =
      status === 'decided' ? 'customer' : status === 'expert' ? 'expert' : status === 'suggested' ? 'suggested' : status === 'conflict' ? 'conflict' : 'open'
    return {
      title: def.title,
      value: shownValue ? (def.labels[shownValue]?.name ?? shownValue) : null,
      how,
      ...(d?.enquiryQuote && how !== 'open' ? { customerQuote: d.enquiryQuote } : {}),
      evidence: (d?.refs ?? []).map((r) => cite(r.docId, `p.${r.page}`, r.claim ?? r.quote, r.quote)),
      ...(p.notes[n.id]?.trim() ? { expertNote: p.notes[n.id].trim() } : {}),
      ...(how === 'open' || how === 'suggested' || how === 'conflict' ? { question: def.clarification ?? def.question } : {}),
    }
  })

  const openIds = TREE_NODES.filter((n) => {
    const st = nodeStatus(n.id, p.tree.decisions, p.overrides)
    const v = p.assessment.dimensions[n.id]?.value
    return !(st === 'decided' || st === 'expert') || !v || v === DIM_BY_ID[n.id].unknownLabel
  }).map((n) => n.id)
  const openSteps = openIds.map((id) => ({ title: DIM_BY_ID[id].title, question: DIM_BY_ID[id].clarification ?? DIM_BY_ID[id].question }))
  const values = Object.fromEntries(Object.values(p.assessment.dimensions).map((d) => [d.id, d.value]))

  const treeIds = new Set(TREE_NODES.map((n) => n.id))
  const facts = DIMENSIONS.filter((def) => !treeIds.has(def.id))
    .map((def) => ({ def, r: p.assessment.dimensions[def.id] }))
    .filter(({ def, r }) => r && r.status !== 'unknown' && (def.kind === 'flag' ? r.value === 'yes' : r.value !== def.unknownLabel))
    .map(({ def, r }) => ({ title: def.title, value: def.kind === 'flag' ? 'yes' : (def.labels[r.value]?.name ?? r.value) }))

  const premises = p.assessment.warnings.map((w) => ({ severity: w.severity, text: w.text, evidence: [citeC(w.citation, w.text)].filter((x): x is string => !!x) }))

  const pick = [
    ...p.assessment.candidates.filter((c) => c.status === 'recommended').slice(0, MAX_RECOMMENDED),
    ...p.assessment.candidates.filter((c) => c.status === 'conditional').slice(0, MAX_CONDITIONAL),
  ]
  const methods = pick.map((c) => {
    const withRef = (r: { text: string; citation?: Citation }) => {
      const id = citeC(r.citation, r.text)
      return id ? `${r.text} [${id}]` : r.text
    }
    const row = citeC(c.setup.citation, `${METHOD_INFO[c.setup.method].name} – ${c.setup.technique}: ${c.setup.phenomenon}, samples ${c.setup.sampleTypes.join(', ')}`)
    return {
      rank: c.rank,
      status: c.status,
      name: METHOD_INFO[c.setup.method].name,
      technique: c.setup.technique,
      range: METHOD_INFO[c.setup.method].rangeText,
      pros: c.reasons.filter((r) => r.effect === 'plus').map(withRef),
      cons: c.reasons.filter((r) => r.effect === 'minus' || r.effect === 'condition').map(withRef),
      evidence: row ? [row] : [],
      canChange: openIds.length ? riskLines(openRisks(c.setup, values, openIds)) : [],
    }
  })

  return { enquiry: p.text, decisionStatus: p.assessment.decisionStatus, decisionReasons: p.assessment.decisionReasons, steps, facts, premises, methods, evidence, openSteps }
}

/** Text with [E3, E5] markers turned into source chips (S01 p.17) that open the cited page. */
function Cited({ text, evidence }: { text: string; evidence: ReportEvidence[] }) {
  const parts = text.split(/(\[E\d+(?:\s*,\s*E\d+)*\])/g)
  return (
    <>
      {parts.map((part, i) => {
        const m = part.match(/^\[(E\d+(?:\s*,\s*E\d+)*)\]$/)
        if (!m) return <span key={i}>{part}</span>
        return (
          <span key={i} className="rp-cites">
            {m[1].split(/\s*,\s*/).map((id) => {
              const e = evidence.find((x) => x.id === id)
              return e ? <CiteLink key={id} c={{ source: e.source, page: e.page, quote: e.quote }} /> : null
            })}
          </span>
        )
      })}
    </>
  )
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rp-block">
      <h3>{title}</h3>
      {children}
    </section>
  )
}

export default function Report(props: Props) {
  const input = useMemo(() => buildInput(props), [props])
  const inputKey = useMemo(() => JSON.stringify(input), [input])
  const [result, setResult] = useState<{ key: string; res: ReportResponse; input: ReportInput } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const stale = !!result && result.key !== inputKey

  async function write() {
    setBusy(true)
    setError('')
    try {
      setResult({ key: inputKey, res: await reportApi.write(input, props.model), input })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  // the report alone, in its own print window: a clean PDF without the rest of the page
  const articleRef = useRef<HTMLElement>(null)
  function downloadPdf() {
    const html = articleRef.current?.outerHTML
    if (!html) return
    const title = `AFS assessment – ${props.text.trim().split(/[.!?]/)[0].slice(0, 60)}`
    const w = window.open('', '_blank', 'width=900,height=1100')
    if (!w) {
      setError('The browser blocked the print window. Allow pop-ups for this page and try again.')
      return
    }
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${title.replace(/</g, '&lt;')}</title><style>${PRINT_CSS}</style></head><body>${html}</body></html>`)
    w.document.close()
    w.focus()
    setTimeout(() => {
      w.print()
    }, 250)
  }

  // the fixed parts of the report belong to the input it was written from
  const shown = result?.input ?? input
  const r = result?.res.report
  const ev = result?.res.evidence ?? []
  const usedSources = [...new Set(ev.map((e) => e.source))].map((s) => ({ s, pages: [...new Set(ev.filter((e) => e.source === s).map((e) => e.page))] }))
  const list = (items: string[], ordered = false) => {
    const Tag = ordered ? 'ol' : 'ul'
    return (
      <Tag>
        {items.map((t, i) => (
          <li key={i}>
            <Cited text={t} evidence={ev} />
          </li>
        ))}
      </Tag>
    )
  }

  return (
    <section className="panel report-panel">
      <div className="panel-head">
        <h2>Written assessment</h2>
        <span className="hint">The decided path as a report in the structure of the AFS examples. A language model writes the text; facts, methods and sources are fixed.</span>
      </div>
      <div className="panel-body">
        {!r ? (
          <div className="rp-start">
            <p>
              Write the assessment from the current decisions: requirements, clarification questions, recommended methods with sources, measurement concept,
              spectral range, risks and a first feasibility experiment.
            </p>
            <button className="btn primary" disabled={busy} onClick={write}>
              {busy ? 'Writing the assessment…' : 'Write assessment'}
            </button>
            {error && <p className="error">{error}</p>}
          </div>
        ) : (
          <>
            {stale && (
              <p className="rp-stale">
                The decisions have changed since this assessment was written.{' '}
                <button className="linkbtn" disabled={busy} onClick={write}>
                  {busy ? 'Updating…' : 'Update the assessment'}
                </button>
              </p>
            )}
            {error && <p className="error">{error}</p>}
            <article className="report-print reading" ref={articleRef}>
              <header className="rp-head">
                <div>
                  <span className="rp-kicker">Art Fiber Systems · First technical assessment</span>
                  <h2>{props.text.trim().split(/[.!?]/)[0].slice(0, 110)}</h2>
                </div>
                <div className="rp-meta">
                  <span className="rp-date">{new Date().toLocaleDateString(undefined, { day: '2-digit', month: 'long', year: 'numeric' })}</span>
                  <span className="rp-team">Made by Team Hallucination Nation</span>
                </div>
              </header>

              <p className="rp-status">
                <strong>Decision status</strong> <Cited text={r.decisionStatus || DECISION_STATUS_TEXT[props.assessment.decisionStatus]} evidence={ev} />
              </p>

              {shown.premises.length > 0 && (
                <div className={`rp-premises ${shown.premises.some((w) => w.severity === 'block') ? 'block' : ''}`}>
                  <strong>Premise check – assumptions in the request, checked against the AFS material</strong>
                  <ul>
                    {[...shown.premises]
                      .sort((x, y) => Number(y.severity === 'block') - Number(x.severity === 'block'))
                      .map((w, i) => (
                        <li key={i} className={w.severity}>
                          <span className="rp-sev">{w.severity === 'block' ? 'Contradicts the AFS material' : 'Needs checking'}</span> {w.text}
                          {w.evidence.length > 0 && (
                            <span className="rp-cites">
                              {w.evidence.map((id) => {
                                const e = shown.evidence.find((x) => x.id === id)
                                return e ? <CiteLink key={id} c={{ source: e.source, page: e.page, quote: e.quote }} /> : null
                              })}
                            </span>
                          )}
                        </li>
                      ))}
                  </ul>
                </div>
              )}

              {shown.openSteps.length > 0 && (
                <div className="rp-provisional">
                  <strong>
                    Provisional – {shown.openSteps.length} decision step{shown.openSteps.length > 1 ? 's are' : ' is'} still open.
                  </strong>{' '}
                  Everything below depends on the answers to these questions and is not final. They should be clarified with the customer first:
                  <ol>
                    {shown.openSteps.map((o) => (
                      <li key={o.title}>
                        <span className="rp-q-step">{o.title}:</span> {o.question}
                      </li>
                    ))}
                  </ol>
                </div>
              )}

              <Block title="Customer enquiry">
                <blockquote className="rp-enquiry">{props.text}</blockquote>
              </Block>
              <Block title="Requirements stated">{list(r.requirementsStated)}</Block>
              {r.keyUnknowns.length > 0 && <Block title="Key unknowns">{list(r.keyUnknowns)}</Block>}
              {r.clarificationQuestions.length > 0 && <Block title="Clarification questions">{list(r.clarificationQuestions, true)}</Block>}
              <Block title="Recommendation">
                {r.recommendation.map((m, i) => (
                  <p key={i} className="rp-method">
                    <strong>{m.method}.</strong> <Cited text={m.text} evidence={ev} />
                  </p>
                ))}
              </Block>
              {shown.openSteps.length > 0 && shown.methods.some((m) => m.canChange.length) && (
                <Block title="What the open answers can change">
                  <table className="rp-change">
                    <tbody>
                      {shown.methods.map((m) => (
                        <tr key={`${m.name}-${m.technique}`}>
                          <th>
                            {m.rank ? `#${m.rank} ` : ''}
                            {m.name} – {m.technique}
                            {m.status === 'conditional' ? ' (conditional)' : ''}
                          </th>
                          <td>{m.canChange.length ? m.canChange.join('; ') : 'Stays on the list whatever the answers are – only its rank can change.'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Block>
              )}
              {r.measurementConcept && (
                <Block title="Measurement concept">
                  <p>
                    <Cited text={r.measurementConcept} evidence={ev} />
                  </p>
                </Block>
              )}
              {r.spectralRange && (
                <Block title="Spectral range">
                  <p>
                    <Cited text={r.spectralRange} evidence={ev} />
                  </p>
                </Block>
              )}
              {r.risks.length > 0 && <Block title="Risks and uncertainty">{list(r.risks)}</Block>}
              {r.feasibilityPlan.length > 0 && <Block title="First feasibility experiment">{list(r.feasibilityPlan, true)}</Block>}
              {r.decisionBasis && (
                <Block title="Decision basis">
                  <p>
                    <Cited text={r.decisionBasis} evidence={ev} />
                  </p>
                </Block>
              )}
              <Block title="Sources">
                <p className="rp-sources">{usedSources.map(({ s, pages }) => `${s} ${pages.join(', ')}`).join(' · ')}</p>
              </Block>
              <footer className="rp-foot">
                Decisions by the Clef classifier, the AFS rules and the expert; text written by {result.res.model}. A starting point for a feasibility test, not a final
                specification.
                <span className="rp-credit">Spectroscopy Assessment Assistant · built by Team Hallucination Nation, Karlsruhe · National AI Hackathon 2026 by SchubKI</span>
              </footer>
            </article>
            <div className="rp-actions">
              <button className="btn primary" onClick={downloadPdf}>
                Download as PDF
              </button>
              <span className="note">Opens the report in a print window – choose “Save as PDF” as the destination.</span>
            </div>
          </>
        )}
      </div>
    </section>
  )
}
