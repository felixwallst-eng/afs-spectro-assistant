import { useEffect, useMemo, useState } from 'react'
import { EXAMPLE_CASES } from '../../shared/cases.ts'
import { assess, resolveDimensions } from '../../shared/engine.ts'
import { DEFAULT_SETTINGS } from '../../shared/types.ts'
import type { MethodSetup, RawDimension, Settings } from '../../shared/types.ts'
import DecisionTree from '../components/DecisionTree.tsx'
import { store, treeApi } from '../lib.ts'
import { rawFromDecisions } from '../treeModel.ts'
import type { SourceMode, TreeResponse } from '../../shared/tree.ts'
import { METHOD_INFO } from '../../shared/knowledge.ts'
import { TREE_NODES } from '../../shared/tree.ts'
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
  const openSteps = TREE_NODES.filter((n) => assessment.dimensions[n.id]?.status === 'unknown').length
  return (
    <section className={`panel decision ${assessment.decisionStatus}`} style={{ margin: 0, display: 'block' }}>
      <strong>{DECISION_SHORT[assessment.decisionStatus]}</strong>
      <p style={{ fontSize: 14, marginTop: 4 }}>
        {top.length
          ? `${openSteps ? `Provisional shortlist (${openSteps} step${openSteps > 1 ? 's' : ''} open)` : 'Worth testing'}: ${top.map((c) => `${METHOD_INFO[c.setup.method].name} – ${c.setup.technique}`).join(', ')}.`
          : 'No setup is recommended without conditions yet.'}
        {blocks > 0 && ` ${blocks} premise${blocks > 1 ? 's' : ''} in the request cannot be confirmed – see below.`}
      </p>
      {open > 0 && (
        <p style={{ fontSize: 14, marginTop: 8 }}>
          {open} open question{open > 1 ? 's' : ''} to clarify with the client – marked “?” on the decision path.
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
  // the example shown in the dropdown; it clears as soon as the text no longer matches it
  const [exampleId, setExampleId] = useState('')
  const [raw, setRaw] = useState<Record<string, RawDimension> | null>(null)
  const [overrides, setOverrides] = useState<Record<string, string>>({})
  const [model, setModel] = useState('')
  const [latency, setLatency] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [history, setHistory] = useState<HistoryEntry[]>(() => store.history())
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [tree, setTree] = useState<TreeResponse | null>(null)
  const [since, setSince] = useState<number | null>(null)
  const [historyOpen, setHistoryOpen] = useState(() => {
    try {
      return localStorage.getItem('afs.historyOpen') !== '0'
    } catch {
      return true
    }
  })
  const toggleHistory = () => {
    setHistoryOpen((o) => {
      try {
        localStorage.setItem('afs.historyOpen', o ? '0' : '1')
      } catch {
        /* storage unavailable */
      }
      return !o
    })
  }
  const [sources, setSources] = useState<SourceMode>(() => {
    try {
      return localStorage.getItem('afs.sources') === 'original' ? 'original' : 'all'
    } catch {
      return 'all'
    }
  })
  const chooseSources = (m: SourceMode) => {
    setSources(m)
    try {
      localStorage.setItem('afs.sources', m)
    } catch {
      /* storage unavailable */
    }
  }

  const dims = useMemo(() => (raw ? resolveDimensions(raw, overrides, settings) : null), [raw, overrides, settings])
  const assessment = useMemo(() => (dims ? assess(dims, methods) : null), [dims, methods])

  async function analyze(input: string, keepOverrides: boolean, fresh = false) {
    if (!input.trim()) {
      setError('Paste or type the customer enquiry first.')
      return
    }
    setBusy(true)
    setError('')
    try {
      setSince(Date.now())
      const thresholds = { confidentAt: settings.confidentAt, uncertainAt: settings.uncertainAt, premiseAt: settings.premiseAt ?? DEFAULT_SETTINGS.premiseAt ?? 0.5 }
      const res = await treeApi.run(input, settings.agentModel ?? 'gptoss', { sources, fresh, pipeline: settings.engine === 'llm' ? 'steps' : 'clef', thresholds })
      const nextOverrides = keepOverrides ? overrides : {}
      const dimensions = rawFromDecisions(res.decisions)
      setTree(res)
      setRaw(dimensions)
      setModel(res.model)
      setLatency(res.latencyMs)
      setOverrides(nextOverrides)
      const entry: HistoryEntry = {
        id: keepOverrides && currentId ? currentId : crypto.randomUUID(),
        title: input.trim().slice(0, 70),
        text: input,
        raw: dimensions,
        overrides: nextOverrides,
        model: res.model,
        tree: res,
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
      setSince(null)
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

  function openEntry(e: HistoryEntry) {
    setText(e.text)
    setExampleId(EXAMPLE_CASES.find((c) => c.text === e.text)?.id ?? '')
    setRaw(e.raw)
    setOverrides(e.overrides)
    setModel(e.model)
    setLatency(null)
    setCurrentId(e.id)
    setError('')
    setTree(e.tree ?? null)
  }

  function newCase() {
    setText('')
    setExampleId('')
    setRaw(null)
    setOverrides({})
    setTree(null)
    setCurrentId(null)
    setError('')
  }

  return (
    <div className={`assess${historyOpen ? '' : ' history-closed'}`}>
      <aside className="history">
        <div className="history-head">
          {historyOpen && <h3>Recent assessments</h3>}
          <button
            className="history-toggle"
            onClick={toggleHistory}
            aria-expanded={historyOpen}
            aria-label={historyOpen ? 'Hide recent assessments' : 'Show recent assessments'}
            title={historyOpen ? 'Hide recent assessments' : 'Show recent assessments'}
          >
            {historyOpen ? '‹' : '›'}
          </button>
        </div>
        {!historyOpen ? null : history.length === 0 ? (
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
                  value={exampleId}
                  onChange={(e) => {
                    const ex = EXAMPLE_CASES.find((c) => c.id === e.target.value)
                    if (ex) {
                      newCase()
                      setText(ex.text)
                      setExampleId(ex.id)
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
                onChange={(e) => {
                  setText(e.target.value)
                  if (exampleId && e.target.value !== EXAMPLE_CASES.find((c) => c.id === exampleId)?.text) setExampleId('')
                }}
                placeholder="Paste what the customer wrote, e.g. “We need to monitor moisture and hydrocarbon contamination in soil…”"
                aria-label="Customer enquiry"
              />
              <div className="case-actions">
                <button className="btn primary" disabled={busy} onClick={() => analyze(text, false)}>
                  {busy ? <Elapsed since={since} /> : 'Analyse enquiry'}
                </button>
                {raw && (
                  <button className="btn" disabled={busy} onClick={newCase}>
                    New enquiry
                  </button>
                )}
                <label className="source-mode">
                  Sources
                  <select value={sources} onChange={(e) => chooseSources(e.target.value as SourceMode)} disabled={busy}>
                    <option value="original">AFS originals only</option>
                    <option value="all">Originals + added sources</option>
                  </select>
                </label>
                {raw && !busy && (
                  <span className="status">
                    {model}
                    {tree?.cachedAt ? ' · stored result for this exact input' : latency !== null ? ` · ${(latency / 1000).toFixed(1)} s` : ''}
                    {tree?.cachedAt && (
                      <button className="linkbtn" onClick={() => analyze(text, true, true)} title="Run all models again instead of showing the stored result">
                        Run again
                      </button>
                    )}
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
                  <li>The model decides each step of the AFS method table – only with a quote from the enquiry as evidence.</li>
                  <li>Steps without evidence stay open: you decide them (“action needed”).</li>
                  <li>Rules from the AFS material narrow the 19 method setups and cite their source.</li>
                </ol>
              </div>
            </section>
          )}
        </div>

        {assessment ? (
          <>
            {tree ? (
              <DecisionTree key={currentId ?? 'case'} tree={tree} text={history.find((h) => h.id === currentId)?.text ?? text} assessment={assessment} methods={methods} overrides={overrides} onOverride={setOverride} />
            ) : (
              <section className="panel placeholder">
                <strong>This entry was analysed with the earlier classifier</strong>
                Choose “Analyse enquiry” again to build the evidence-backed decision path.
              </section>
            )}
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

function Elapsed({ since }: { since: number | null }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [])
  return <>Reading the enquiry… {since ? ((now - since) / 1000).toFixed(0) : 0} s</>
}
