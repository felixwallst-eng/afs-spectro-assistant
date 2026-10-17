import { useMemo, useState } from 'react'
import { EXAMPLE_CASES } from '../../shared/cases.ts'
import { assess, resolveDimensions } from '../../shared/engine.ts'
import type { MethodSetup, RawDimension, Settings } from '../../shared/types.ts'
import Recommendations from '../components/Recommendations.tsx'
import ReviewTable from '../components/ReviewTable.tsx'
import { classifyText, store } from '../lib.ts'
import { METHOD_INFO } from '../../shared/knowledge.ts'
import type { Assessment } from '../../shared/types.ts'

const DECISION_SHORT = {
  provisional: 'Provisional assessment',
  insufficient_information: 'Insufficient information',
  out_of_scope: 'Outside supported scope',
}

function Summary({ assessment }: { assessment: Assessment }) {
  const top = assessment.candidates.filter((c) => c.status === 'recommended').slice(0, 3)
  const blocks = assessment.warnings.filter((w) => w.severity === 'block').length
  const open = assessment.questions.filter((q) => q.kind === 'missing').length
  return (
    <section className={`panel decision ${assessment.decisionStatus}`} style={{ margin: 0, display: 'block' }}>
      <strong>{DECISION_SHORT[assessment.decisionStatus]}</strong>
      <p style={{ fontSize: 14, marginTop: 4 }}>
        {top.length
          ? `Worth testing: ${top.map((c) => `${METHOD_INFO[c.setup.method].name} – ${c.setup.technique}`).join(', ')}.`
          : 'No setup is recommended without conditions yet.'}
        {blocks > 0 && ` ${blocks} premise${blocks > 1 ? 's' : ''} in the request cannot be confirmed – see below.`}
      </p>
      {open > 0 && (
        <p style={{ fontSize: 14, marginTop: 8 }}>
          <a href="#review">{open} open question{open > 1 ? 's' : ''} to clarify with the client</a>
        </p>
      )}
    </section>
  )
}
import type { HistoryEntry } from '../lib.ts'

interface Props {
  settings: Settings
  methods: MethodSetup[]
}

export default function AssessPage({ settings, methods }: Props) {
  const [text, setText] = useState('')
  const [raw, setRaw] = useState<Record<string, RawDimension> | null>(null)
  const [overrides, setOverrides] = useState<Record<string, string>>({})
  const [model, setModel] = useState('')
  const [latency, setLatency] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [history, setHistory] = useState<HistoryEntry[]>(() => store.history())
  const [currentId, setCurrentId] = useState<string | null>(null)

  const dims = useMemo(() => (raw ? resolveDimensions(raw, overrides, settings) : null), [raw, overrides, settings])
  const assessment = useMemo(() => (dims ? assess(dims, methods) : null), [dims, methods])

  async function analyze(input: string, keepOverrides: boolean) {
    if (!input.trim()) {
      setError('Paste or type the customer enquiry first.')
      return
    }
    setBusy(true)
    setError('')
    try {
      const res = await classifyText(input)
      const nextOverrides = keepOverrides ? overrides : {}
      setRaw(res.dimensions)
      setModel(res.model)
      setLatency(res.latencyMs)
      setOverrides(nextOverrides)
      const entry: HistoryEntry = {
        id: keepOverrides && currentId ? currentId : crypto.randomUUID(),
        title: input.trim().slice(0, 70),
        text: input,
        raw: res.dimensions,
        overrides: nextOverrides,
        model: res.model,
        createdAt: new Date().toISOString(),
      }
      const next = [entry, ...history.filter((h) => h.id !== entry.id)]
      setHistory(next)
      store.saveHistory(next)
      setCurrentId(entry.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  function setOverride(id: string, value: string | undefined) {
    const next = { ...overrides }
    if (value === undefined) delete next[id]
    else next[id] = value
    setOverrides(next)
    if (currentId) {
      const h = history.map((e) => (e.id === currentId ? { ...e, overrides: next } : e))
      setHistory(h)
      store.saveHistory(h)
    }
  }

  function addNote(note: string) {
    const next = `${text.trim()}\n\nAdditional information from the client: ${note.trim()}`
    setText(next)
    void analyze(next, true)
  }

  function openEntry(e: HistoryEntry) {
    setText(e.text)
    setRaw(e.raw)
    setOverrides(e.overrides)
    setModel(e.model)
    setLatency(null)
    setCurrentId(e.id)
    setError('')
  }

  function newCase() {
    setText('')
    setRaw(null)
    setOverrides({})
    setCurrentId(null)
    setError('')
  }

  return (
    <div className="assess">
      <aside className="history">
        <h3>Recent assessments</h3>
        {history.length === 0 ? (
          <p className="empty">Analysed enquiries appear here.</p>
        ) : (
          <ul>
            {history.map((h) => (
              <li key={h.id}>
                <button aria-current={h.id === currentId} onClick={() => openEntry(h)}>
                  {h.title}
                  {h.title.length >= 70 ? '…' : ''}
                  <small>{new Date(h.createdAt).toLocaleString()}</small>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <div className="stack">
        <div className="intake">
          <section className="panel case-input">
            <div className="panel-head">
              <h2>Customer enquiry</h2>
              <div className="right">
                <select
                  aria-label="Load an example enquiry"
                  value=""
                  onChange={(e) => {
                    const ex = EXAMPLE_CASES.find((c) => c.id === e.target.value)
                    if (ex) {
                      newCase()
                      setText(ex.text)
                    }
                  }}
                >
                  <option value="">Load example…</option>
                  <optgroup label="Development cases">
                    {EXAMPLE_CASES.filter((c) => c.split === 'dev').map((c) => (
                      <option key={c.id} value={c.id}>{`${c.id} · ${c.title}`}</option>
                    ))}
                  </optgroup>
                  <optgroup label="Evaluation cases">
                    {EXAMPLE_CASES.filter((c) => c.split === 'test').map((c) => (
                      <option key={c.id} value={c.id}>{`${c.id} · ${c.title}`}</option>
                    ))}
                  </optgroup>
                </select>
              </div>
            </div>
            <div className="panel-body">
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Paste what the customer wrote, e.g. “We need to monitor moisture and hydrocarbon contamination in soil…”"
                aria-label="Customer enquiry"
              />
              <div className="case-actions">
                <button className="btn primary" disabled={busy} onClick={() => analyze(text, false)}>
                  {busy ? 'Analysing…' : 'Analyse enquiry'}
                </button>
                {raw && (
                  <button className="btn" disabled={busy} onClick={newCase}>
                    New enquiry
                  </button>
                )}
                {raw && !busy && (
                  <span className="status">
                    {model}
                    {latency !== null ? ` · ${latency} ms` : ''}
                  </span>
                )}
              </div>
              {error && <p className="error">{error}</p>}
            </div>
          </section>
          {assessment ? (
            <Summary assessment={assessment} />
          ) : (
            <section className="panel how-to">
              <div className="panel-body">
                <strong>How the assessment works</strong>
                <ol>
                  <li>Clef classifies the enquiry on every decision dimension.</li>
                  <li>You answer what is missing and check what is uncertain.</li>
                  <li>Rules from the AFS material rank the method setups and cite their source.</li>
                </ol>
              </div>
            </section>
          )}
        </div>

        {assessment ? (
          <>
            <ReviewTable key={currentId ?? "case"} assessment={assessment} settings={settings} onOverride={setOverride} onAddNote={addNote} busy={busy} />
            <Recommendations assessment={assessment} />
          </>
        ) : (
          <section className="panel placeholder">
            <strong>No enquiry analysed yet</strong>
            Paste a customer enquiry or load an example, then choose “Analyse enquiry”.
          </section>
        )}
      </div>
    </div>
  )
}
