import { useEffect, useMemo, useState } from 'react'
import { EXAMPLE_CASES } from '../../shared/cases.ts'
import { assess, resolveDimensions } from '../../shared/engine.ts'
import { DEFAULT_SETTINGS } from '../../shared/types.ts'
import type { MethodSetup, RawDimension, Settings } from '../../shared/types.ts'
import DecisionTree from '../components/DecisionTree.tsx'
import Report from '../components/Report.tsx'
import { casesApi, store, treeApi } from '../lib.ts'
import type { SolvedCase } from '../../shared/solvedCases.ts'
import { rawFromDecisions } from '../treeModel.ts'
import type { SourceMode, TreeResponse } from '../../shared/tree.ts'

import type { HistoryEntry } from '../lib.ts'

const EMPTY_TREE: TreeResponse = {
  model: '',
  decisions: [],
  latencyMs: 0,
  passagesRead: 0,
  usage: { inputTokens: 0, outputTokens: 0 },
  stats: { decided: 0, suggested: 0, open: 0, rejectedQuotes: 0, verifiedSources: 0 },
}

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
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [savedAt, setSavedAt] = useState<string | undefined>(undefined)
  const [model, setModel] = useState('')
  const [latency, setLatency] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [history, setHistory] = useState<HistoryEntry[]>(() => store.history())
  const [currentId, setCurrentId] = useState<string | null>(null)
  // evaluation cases frozen for the demo (public/demo/evaluation-cases.json, written by scripts/export-demo.mjs)
  const [pinned, setPinned] = useState<HistoryEntry[]>([])
  const [confirmClear, setConfirmClear] = useState(false)
  useEffect(() => {
    fetch('/demo/evaluation-cases.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { cases?: { id: string; title: string; text: string; tree: TreeResponse; createdAt: string }[] } | null) =>
        setPinned(
          (d?.cases ?? []).map((c) => ({ id: c.id, title: c.title, text: c.text, raw: rawFromDecisions(c.tree.decisions), overrides: {}, model: c.tree.model, tree: c.tree, createdAt: c.createdAt })),
        ),
      )
      .catch(() => setPinned([]))
  }, [])
  const isPinned = (id: string | null) => !!id && pinned.some((p) => p.id === id)
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
  // the empty path shown before the first analysis: every step open, no methods yet
  const emptyAssessment = useMemo(() => assess(resolveDimensions(rawFromDecisions([]), {}, settings), methods), [settings, methods])

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
      const res = await treeApi.run(input, 'gptoss', { sources, fresh, pipeline: 'clef', thresholds })
      const nextOverrides = keepOverrides ? overrides : {}
      const dimensions = rawFromDecisions(res.decisions)
      setTree(res)
      setRaw(dimensions)
      setModel(res.model)
      setLatency(res.latencyMs)
      setOverrides(nextOverrides)
      if (!keepOverrides) {
        setNotes({})
        setSavedAt(undefined)
      }
      const entry: HistoryEntry = {
        id: keepOverrides && currentId ? currentId : crypto.randomUUID(),
        title: input.trim().slice(0, 70),
        text: input,
        raw: dimensions,
        overrides: nextOverrides,
        notes: keepOverrides ? notes : {},
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

  // functional updates, so several decisions in a row (e.g. "accept all suggestions") all stick
  function setOverride(id: string, value: string | undefined) {
    setOverrides((prev) => {
      const next = { ...prev }
      if (value === undefined) delete next[id]
      else next[id] = value
      if (currentId)
        setHistory((h) => {
          const nh = h.map((e) => (e.id === currentId ? { ...e, overrides: next } : e))
          store.saveHistory(nh)
          return nh
        })
      return next
    })
  }

  /** Update the current history entry (notes, saved state) and keep it in the browser. */
  function patchEntry(patch: Partial<HistoryEntry>) {
    if (!currentId) return
    const h = history.map((e) => (e.id === currentId ? { ...e, ...patch } : e))
    setHistory(h)
    store.saveHistory(h)
  }

  function setNote(id: string, value: string) {
    const next = { ...notes, [id]: value }
    if (!value) delete next[id]
    setNotes(next)
    patchEntry({ notes: next })
  }

  async function saveCase(c: Omit<SolvedCase, 'createdAt'>) {
    const saved = await casesApi.save(c)
    const at = saved.updatedAt ?? saved.createdAt
    setSavedAt(at)
    patchEntry({ savedAt: at })
  }

  function openEntry(e: HistoryEntry) {
    setText(e.text)
    setNotes(e.notes ?? {})
    setSavedAt(e.savedAt)
    setExampleId(EXAMPLE_CASES.find((c) => c.text === e.text)?.id ?? '')
    setRaw(e.raw)
    setOverrides(e.overrides)
    setModel(e.model)
    setLatency(null)
    setCurrentId(e.id)
    setError('')
    setTree(e.tree ?? null)
  }

  function removeEntry(id: string) {
    const next = history.filter((e) => e.id !== id)
    setHistory(next)
    store.saveHistory(next)
    if (currentId === id) newCase()
  }

  function clearHistory() {
    setHistory([])
    store.saveHistory([])
    setConfirmClear(false)
    if (!isPinned(currentId)) newCase()
  }

  function newCase() {
    setText('')
    setNotes({})
    setSavedAt(undefined)
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
        {historyOpen && pinned.length > 0 && (
          <div className="history-pinned">
            <h4>Evaluation cases</h4>
            <ul>
              {pinned.map((h) => (
                <li key={h.id}>
                  <button aria-current={h.id === currentId} onClick={() => openEntry(h)} title="Result stored with the app – open it without running the analysis">
                    {h.title}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {!historyOpen ? null : history.length === 0 ? (
          <p className="empty">Analysed enquiries appear here. They are stored in this browser only.</p>
        ) : (
          <>
            <ul>
              {history.map((h) => (
                <li key={h.id} className="history-item">
                  <button aria-current={h.id === currentId} onClick={() => openEntry(h)}>
                    {h.title}
                    {h.title.length >= 70 ? '…' : ''}
                    <small>{new Date(h.createdAt).toLocaleString()}</small>
                  </button>
                  <button className="history-del" onClick={() => removeEntry(h.id)} aria-label={`Remove “${h.title}” from the history`} title="Remove from the history">
                    ×
                  </button>
                </li>
              ))}
            </ul>
            <div className="history-clear">
              {confirmClear ? (
                <>
                  Delete all {history.length}?{' '}
                  <button className="linkbtn danger" onClick={clearHistory}>
                    Yes, delete
                  </button>{' '}
                  <button className="linkbtn" onClick={() => setConfirmClear(false)}>
                    Cancel
                  </button>
                </>
              ) : (
                <button className="linkbtn" onClick={() => setConfirmClear(true)}>
                  Clear history
                </button>
              )}
            </div>
          </>
        )}
      </aside>

      <div className="stack">
        <section className="panel case-input reading">
          <div className="panel-head">
            <h2>Customer enquiry</h2>
            <span className="hint">Paste what the customer wrote, or load an example.</span>
          </div>
          <div className="panel-body intake-row">
            <textarea
              value={text}
              onChange={(e) => {
                setText(e.target.value)
                if (exampleId && e.target.value !== EXAMPLE_CASES.find((c) => c.id === exampleId)?.text) setExampleId('')
              }}
              placeholder="Paste what the customer wrote, e.g. “We need to monitor moisture and hydrocarbon contamination in soil…”"
              aria-label="Customer enquiry"
            />
            <div className="intake-side">
              <label className="side-field">
                Example
                <select
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
              </label>
              <label className="side-field">
                Sources
                <select value={sources} onChange={(e) => chooseSources(e.target.value as SourceMode)} disabled={busy}>
                  <option value="original">AFS originals only</option>
                  <option value="all">Originals + added sources</option>
                </select>
              </label>
              <button className="btn primary" disabled={busy} onClick={() => analyze(text, false)}>
                {busy ? <Elapsed since={since} /> : 'Analyse enquiry'}
              </button>
              {raw && (
                <button className="btn" disabled={busy} onClick={newCase}>
                  New enquiry
                </button>
              )}
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
          </div>
          {error && <p className="error intake-error">{error}</p>}
        </section>

        {assessment ? (
          <>
            {tree ? (
              <DecisionTree key={currentId ?? 'case'} tree={tree} text={history.find((h) => h.id === currentId)?.text ?? text} assessment={assessment}
                methods={methods}
                overrides={overrides}
                onOverride={setOverride}
                caseId={currentId}
                notes={notes}
                onNote={setNote}
                savedAt={savedAt}
                onSaveCase={saveCase}
              />
            ) : null}
            {tree ? (
              <Report
                key={`report-${currentId ?? 'case'}`}
                text={history.find((h) => h.id === currentId)?.text ?? text}
                tree={tree}
                assessment={assessment}
                overrides={overrides}
                notes={notes}
                model="gptoss"
              />
            ) : (
              <section className="panel placeholder">
                <strong>This entry was analysed with the earlier classifier</strong>
                Choose “Analyse enquiry” again to build the evidence-backed decision path.
              </section>
            )}
          </>
        ) : (
          <DecisionTree
            key="empty"
            tree={EMPTY_TREE}
            text=""
            assessment={emptyAssessment}
            methods={methods}
            overrides={{}}
            onOverride={() => {}}
            placeholder={
              busy
                ? { title: 'Reading the enquiry…', text: 'The decision path fills in as soon as every step is classified.' }
                : { title: 'No enquiry analysed yet', text: 'Paste a customer enquiry or load an example, then choose “Analyse enquiry”.' }
            }
          />
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
