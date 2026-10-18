import { useEffect, useRef, useState } from 'react'
import { MAX_UPLOAD_BYTES } from '../../shared/docs.ts'
import type { DocMeta } from '../../shared/docs.ts'
import { DIM_BY_ID } from '../../shared/dimensions.ts'
import type { CardSet } from '../../shared/cards.ts'
import { TREE_NODES } from '../../shared/tree.ts'
import { cardsApi, casesApi, docsApi, resetWorkspace } from '../lib.ts'
import type { SolvedCase } from '../../shared/solvedCases.ts'
import { extractPageTexts } from '../pdfText.ts'
import { useOpenSource } from '../sourceContext.ts'

const fmtSize = (b: number | null) => (b === null ? '–' : b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`)
const fmtDate = (s: string) => new Date(s).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })

function DocDetails({ doc, onSaved, onCancel }: { doc: DocMeta; onSaved: (d: DocMeta) => void; onCancel: () => void }) {
  const [title, setTitle] = useState(doc.title)
  const [summary, setSummary] = useState(doc.summary)
  const [notes, setNotes] = useState(doc.notes)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const changed = title !== doc.title || summary !== doc.summary || notes !== doc.notes

  async function save() {
    setBusy(true)
    setError('')
    try {
      onSaved(await docsApi.update(doc.id, { title, summary, notes }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="kb-details">
      <label>
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        Summary
        <small>What the document covers – shown to colleagues in the knowledge base.</small>
        <textarea rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="e.g. Application note on NIR transflection probes for clear process liquids, with probe dimensions and cleaning procedure." />
      </label>
      <label>
        Expert note
        <small>Limits or warnings the assistant must respect when it cites this document.</small>
        <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Laboratory data only – do not cite as proof for process use." />
      </label>
      {error && <p className="error">{error}</p>}
      <div className="kb-detail-actions">
        <button className="btn primary small" disabled={!changed || busy} onClick={save}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
        <button className="linkbtn" onClick={onCancel}>
          Cancel
        </button>
        {doc.notesUpdatedAt && <span className="kb-muted">Note updated {fmtDate(doc.notesUpdatedAt)}</span>}
      </div>
    </div>
  )
}

/** The knowledge cards of one document, grouped by decision step; the expert can open or remove each. */
function CardsPanel({ doc, onChanged }: { doc: DocMeta; onChanged: (count: number, curated: boolean) => void }) {
  const open = useOpenSource()
  const [set, setSet] = useState<CardSet | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    cardsApi.get(doc.id).then(setSet).catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [doc.id, doc.cardsAt])

  async function remove(cardId: string) {
    try {
      const next = await cardsApi.remove(doc.id, cardId)
      setSet(next)
      onChanged(next.cards.length, false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function reset() {
    try {
      const next = await cardsApi.reset(doc.id)
      setSet(next)
      onChanged(next.cards.length, true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  function download() {
    if (!set) return
    const { curated: _c, ...data } = set
    void _c
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
    const a = Object.assign(document.createElement('a'), { href: url, download: `${doc.id}.json` })
    a.click()
    URL.revokeObjectURL(url)
  }

  if (error) return <p className="error">{error}</p>
  if (!set) return <p className="kb-muted">Loading cards…</p>
  return (
    <div className="kb-cards">
      <div className="kb-cards-head">
        <p className="kb-muted">
          {set.curated ? 'Curated cards from the repository' : `Read by ${set.model} – your version, in this browser only`} · {fmtDate(set.createdAt)} · all {set.pagesRead} pages · {set.cards.length} statements
          {set.rejected > 0 && `, ${set.rejected} discarded because their quote was not found in the document`}. Every quote was checked against the PDF text. Remove a card
          if it should not be used.
        </p>
        <div>
          <button className="linkbtn" onClick={download} title="Save these cards as JSON, e.g. to version them in the repository">
            Download JSON
          </button>
          {!set.curated && doc.origin !== 'uploaded' && (
            <button className="linkbtn" onClick={reset} title="Discard your edits and re-reads, use the curated cards again">
              Reset to curated
            </button>
          )}
        </div>
      </div>
      {[...TREE_NODES.map((n) => n.id), 'budget'].map((stepId) => {
        const cards = set.cards.filter((c) => c.step === stepId)
        if (!cards.length) return null
        const def = DIM_BY_ID[stepId]
        const n = { id: stepId }
        return (
          <div key={n.id} className="kb-card-group">
            <h4>
              {stepId === 'budget' ? 'Cost (background for the pros and cons of setups)' : def.title} <span className="kb-muted">· {cards.length}</span>
            </h4>
            <ul>
              {cards.map((c) => (
                <li key={c.id} className="kb-card">
                  <div>
                    <p>
                      {c.claim}
                      {c.value && <span className="chip clef kb-card-value">{def.labels[c.value]?.name}</span>}
                    </p>
                    <button className="kb-card-quote" title="Open the page with this sentence highlighted" onClick={() => open({ source: doc.id, page: c.page, quote: c.quote, title: doc.title })}>
                      p.{c.page} · “{c.quote}”
                    </button>
                  </div>
                  <button className="linkbtn danger" onClick={() => remove(c.id)} aria-label="Remove this card">
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </div>
  )
}

function UploadForm({ file, onDone, onCancel }: { file: File; onDone: (d: DocMeta) => void; onCancel: () => void }) {
  const [title, setTitle] = useState(file.name.replace(/\.pdf$/i, ''))
  const [summary, setSummary] = useState('')
  const [notes, setNotes] = useState('')
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')

  async function upload() {
    setError('')
    try {
      setStatus('Reading the text of every page…')
      const texts = await extractPageTexts(file)
      setStatus(`Uploading (${texts.length} pages)…`)
      onDone(await docsApi.upload(file, texts, { title, summary, notes }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus('')
    }
  }

  return (
    <div className="kb-upload-form">
      <div className="kb-file">
        <span className="kb-icon" aria-hidden="true">PDF</span>
        <div>
          <strong>{file.name}</strong>
          <span className="kb-muted">{fmtSize(file.size)}</span>
        </div>
      </div>
      <label>
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        Summary for the assistant
        <textarea rows={2} value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="What does this document cover? Can also be added later." />
      </label>
      <label>
        Expert note <span className="kb-muted">(optional)</span>
        <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
      {error && <p className="error">{error}</p>}
      <div className="kb-detail-actions">
        <button className="btn primary small" disabled={!!status} onClick={upload}>
          {status || 'Upload document'}
        </button>
        <button className="linkbtn" disabled={!!status} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

/** focusCase: a solved case to open and scroll to (e.g. from a hint on the assessment page). */
export default function KnowledgePage({ focusCase }: { focusCase?: string | null } = {}) {
  const open = useOpenSource()
  const [docs, setDocs] = useState<DocMeta[] | null>(null)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [pending, setPending] = useState<File | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [reading, setReading] = useState<Set<string>>(new Set())
  const [showCards, setShowCards] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    docsApi
      .list()
      .then(setDocs)
      .catch((e) => setError(`Could not load the knowledge base: ${e instanceof Error ? e.message : String(e)}`))
  }, [])

  const replace = (d: DocMeta) => setDocs((prev) => (prev ?? []).map((x) => (x.id === d.id ? d : x)))

  function pick(files: FileList | null) {
    const f = files?.[0]
    if (!f) return
    if (f.type !== 'application/pdf' && !f.name.toLowerCase().endsWith('.pdf')) return setError('Only PDF files can be added.')
    if (f.size > MAX_UPLOAD_BYTES) return setError('The file is larger than 20 MB.')
    setError('')
    setPending(f)
  }

  async function toggle(d: DocMeta) {
    try {
      replace(await docsApi.update(d.id, { enabled: !d.enabled }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function remove(d: DocMeta) {
    try {
      await docsApi.remove(d.id)
      setDocs((prev) => (prev ?? []).filter((x) => x.id !== d.id))
      setConfirmDelete(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /** Let the model read the whole document into knowledge cards (about a minute). */
  async function read(d: DocMeta) {
    setReading((r) => new Set(r).add(d.id))
    setError('')
    try {
      const set = await cardsApi.build(d.id)
      setDocs((prev) => (prev ?? []).map((x) => (x.id === d.id ? { ...x, cards: set.cards.length, cardsAt: set.createdAt, cardsCurated: false } : x)))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setReading((r) => {
        const n = new Set(r)
        n.delete(d.id)
        return n
      })
    }
  }

  const active = docs?.filter((d) => d.enabled).length ?? 0

  return (
    <div className="kb-page">
    <section className="panel kb">
      <div className="panel-head">
        <h2>Knowledge base</h2>
        {docs && (
          <span className="hint">
            {docs.length} documents · {active} used by the assistant
          </span>
        )}
      </div>
      <div className="panel-body">
        <p className="kb-intro">
          Every document is read completely once, when it is added: the model turns each page into knowledge cards – statements that matter for the
          decision steps, each with a verified quote. Assessments then use all cards of the active documents, so the same enquiry always gets the same
          knowledge. Expert notes are passed along with every card of a document.
        </p>
        <p className="kb-workspace">
          <span>
            <strong>Your changes stay in this browser.</strong> Re-reading or editing cards, switching sources off, notes, uploads and solved cases are kept
            for you only – every other user always works with the curated knowledge base.
          </span>
          <button
            className="btn small"
            onClick={() => {
              resetWorkspace()
              window.location.reload()
            }}
            title="Discard all your changes and uploads and go back to the curated knowledge base"
          >
            Reset all my changes
          </button>
        </p>

        {pending ? (
          <UploadForm
            file={pending}
            onCancel={() => setPending(null)}
            onDone={(d) => {
              setDocs((prev) => [...(prev ?? []), d])
              setPending(null)
              if (d.pages) void read(d)
            }}
          />
        ) : (
          <div
            className={`kb-drop ${dragOver ? 'over' : ''}`}
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragOver(false)
              pick(e.dataTransfer.files)
            }}
          >
            <span>Drop a PDF here or</span>
            <button className="btn small" onClick={() => inputRef.current?.click()}>
              Choose file
            </button>
            <span className="kb-muted">max. 20 MB</span>
            <input ref={inputRef} type="file" accept="application/pdf,.pdf" hidden onChange={(e) => pick(e.target.files)} />
          </div>
        )}

        {error && <p className="error">{error}</p>}

        {!docs && !error && <p className="kb-muted" style={{ marginTop: 16 }}>Loading documents…</p>}

        {docs && (
          <table className="kb-table">
            <thead>
              <tr>
                <th>Document</th>
                <th>Source</th>
                <th>Pages</th>
                <th>Read by AI</th>
                <th>Size</th>
                <th>Added</th>
                <th>Used by AI</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => [
                <tr key={d.id} className={d.enabled ? '' : 'off'}>
                  <td>
                    <div className="kb-file">
                      <span className="kb-icon" aria-hidden="true">
                        PDF
                      </span>
                      <div>
                        <strong>{d.title}</strong>
                        <span className={d.summary ? 'kb-summary' : 'kb-summary missing'}>
                          {d.summary || 'No summary yet – add one so the assistant can select this document.'}
                        </span>
                        {d.notes && <span className="kb-note">Note: {d.notes}</span>}
                      </div>
                    </div>
                  </td>
                  <td>
                    <span className={`tag ${d.origin}`}>{d.origin === 'original' ? 'Original' : d.origin === 'added' ? 'Added source' : 'Uploaded'}</span>
                    {!d.indexed && <span className="kb-muted kb-unindexed">Not searchable yet</span>}
                  </td>
                  <td>{d.pages ?? '–'}</td>
                  <td className="kb-read">
                    {reading.has(d.id) ? (
                      <span className="kb-reading">Reading all pages…</span>
                    ) : d.cards !== undefined ? (
                      <>
                        <button className="linkbtn" onClick={() => setShowCards(showCards === d.id ? null : d.id)}>
                          {d.cards} cards
                        </button>
                        {d.cardsCurated && <span className="tag curated">curated</span>}
                        <button className="linkbtn kb-muted" onClick={() => read(d)} title="Read the whole document again with the language model – the new cards apply in this browser only">
                          Re-read
                        </button>
                      </>
                    ) : d.indexed ? (
                      <button className="btn small" onClick={() => read(d)}>
                        Read document
                      </button>
                    ) : (
                      <span className="kb-muted">Text not extracted yet</span>
                    )}
                  </td>
                  <td>{fmtSize(d.size)}</td>
                  <td>{fmtDate(d.addedAt)}</td>
                  <td>
                    <button className={`switch ${d.enabled ? 'on' : ''}`} role="switch" aria-checked={d.enabled} aria-label={`Use ${d.title} in answers`} onClick={() => toggle(d)}>
                      <span />
                    </button>
                  </td>
                  <td className="kb-actions">
                    <button className="linkbtn" onClick={() => open({ source: d.id, page: 1, title: d.title })}>
                      Open
                    </button>
                    <button className="linkbtn" onClick={() => setExpanded(expanded === d.id ? null : d.id)}>
                      {expanded === d.id ? 'Close' : 'Edit details'}
                    </button>
                    {d.origin === 'uploaded' &&
                      (confirmDelete === d.id ? (
                        <span className="kb-confirm">
                          Delete?
                          <button className="linkbtn danger" onClick={() => remove(d)}>
                            Yes
                          </button>
                          <button className="linkbtn" onClick={() => setConfirmDelete(null)}>
                            No
                          </button>
                        </span>
                      ) : (
                        <button className="linkbtn danger" onClick={() => setConfirmDelete(d.id)}>
                          Delete
                        </button>
                      ))}
                  </td>
                </tr>,
                showCards === d.id && (
                  <tr key={`${d.id}-cards`} className="kb-details-row">
                    <td colSpan={8}>
                      <CardsPanel doc={d} onChanged={(n, curated) => setDocs((prev) => (prev ?? []).map((x) => (x.id === d.id ? { ...x, cards: n, cardsCurated: curated } : x)))} />
                    </td>
                  </tr>
                ),
                expanded === d.id && (
                  <tr key={`${d.id}-details`} className="kb-details-row">
                    <td colSpan={8}>
                      <DocDetails
                        doc={d}
                        onCancel={() => setExpanded(null)}
                        onSaved={(nd) => {
                          replace(nd)
                          setExpanded(null)
                        }}
                      />
                    </td>
                  </tr>
                ),
              ])}
            </tbody>
          </table>
        )}
      </div>
    </section>
    <SolvedCasesPanel focus={focusCase ?? null} />
    </div>
  )
}

const BASIS_TEXT: Record<string, string> = {
  customer: 'stated by the customer',
  sources: 'suggested from the sources',
  missing: 'missing',
  conflict: 'conflict',
}

/** Enquiries the expert walked through: the worked examples next to the documents. */
function SolvedCasesPanel({ focus }: { focus: string | null }) {
  const [cases, setCases] = useState<SolvedCase[] | null>(null)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<string | null>(focus)
  const [confirm, setConfirm] = useState<string | null>(null)

  useEffect(() => {
    casesApi
      .list()
      .then(setCases)
      .catch((e) => setError(`Could not load the solved cases: ${e instanceof Error ? e.message : String(e)}`))
  }, [])

  async function remove(id: string) {
    try {
      await casesApi.remove(id)
      setCases((prev) => (prev ?? []).filter((c) => c.id !== id))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <section className="panel kb-cases">
      <div className="panel-head">
        <h2>Solved cases</h2>
        {cases && <span className="hint">{cases.length} worked example{cases.length === 1 ? '' : 's'} from expert reviews</span>}
      </div>
      <div className="panel-body">
        <p className="kb-intro">
          When an expert has decided every step of an assessment, the case can be added here: the customer enquiry, what the assistant proposed, what the
          expert decided and why. The collection grows with every reviewed enquiry. The worked examples D01 and D02 from the AFS reference document are
          included as the first cases.
        </p>
        {error && <p className="error">{error}</p>}
        {!cases ? (
          !error && <p className="kb-muted">Loading…</p>
        ) : cases.length === 0 ? (
          <p className="kb-muted">No solved cases yet. Walk through an assessment, decide every step and choose “Add to knowledge base”.</p>
        ) : (
          <ul className="case-list">
            {cases.map((c) => {
              const expert = c.steps.filter((s) => s.byExpert || s.note)
              const isOpen = open === c.id
              return (
                <li
                  key={c.id}
                  className={`${isOpen ? 'open' : ''} ${c.id === focus ? 'focus' : ''}`}
                  ref={c.id === focus ? (el) => el?.scrollIntoView({ block: 'start', behavior: 'smooth' }) : undefined}
                >
                  <button className="case-row" onClick={() => setOpen(isOpen ? null : c.id)} aria-expanded={isOpen}>
                    <span className="case-title">
                      {c.origin === 'reference' && <span className="tag added case-tag">Worked example</span>}
                      {c.title}
                      {c.origin !== 'reference' && c.enquiry.length > c.title.length ? '…' : ''}
                    </span>
                    <span className="case-meta">
                      {expert.length} expert decision{expert.length === 1 ? '' : 's'} · {c.steps.filter((s) => s.note).length} note
                      {c.steps.filter((s) => s.note).length === 1 ? '' : 's'} · {fmtDate(c.updatedAt ?? c.createdAt)}
                    </span>
                  </button>
                  {isOpen && (
                    <div className="case-body">
                      <h4>Customer enquiry</h4>
                      <p className="case-enquiry">{c.enquiry}</p>
                      <h4>Decisions</h4>
                      <table className="case-steps">
                        <thead>
                          <tr>
                            <th>Step</th>
                            <th>Assistant proposed</th>
                            <th>Final decision</th>
                            <th>Expert reasoning</th>
                          </tr>
                        </thead>
                        <tbody>
                          {c.steps.map((s) => (
                            <tr key={s.id} className={s.byExpert || s.note ? 'hard' : ''}>
                              <td>{s.title}</td>
                              <td>
                                {s.model.valueName ?? '–'}
                                <small>{BASIS_TEXT[s.model.basis] ?? s.model.basis}</small>
                              </td>
                              <td>
                                <strong>{s.valueName}</strong>
                                <small>{s.value === 'not_stated' ? 'left open by the expert' : s.byExpert ? (s.model.value === s.value ? 'confirmed by the expert' : s.model.value ? 'changed by the expert' : 'filled in by the expert') : 'from the customer text'}</small>
                              </td>
                              <td>{s.note ?? <span className="kb-muted">–</span>}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {c.methods.length > 0 && (
                        <>
                          <h4>Methods worth testing</h4>
                          <p className="case-methods">{c.methods.map((m) => `${m.rank ? `#${m.rank} ` : ''}${m.name} – ${m.technique}`).join(' · ')}</p>
                        </>
                      )}
                      {c.premises.length > 0 && (
                        <>
                          <h4>Premise check</h4>
                          <ul className="case-premises">
                            {c.premises.map((w) => (
                              <li key={w.id} className={w.severity}>
                                {w.text}
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                      <div className="case-actions-row">
                        <span className="kb-muted">Assessed with {c.engine || 'the assistant'}</span>
                        {c.origin === 'reference' ? (
                          <span className="kb-muted">From the AFS reference document (worked example) – part of the app</span>
                        ) : confirm === c.id ? (
                          <span>
                            Delete this case?{' '}
                            <button className="linkbtn danger" onClick={() => remove(c.id)}>
                              Yes
                            </button>{' '}
                            <button className="linkbtn" onClick={() => setConfirm(null)}>
                              No
                            </button>
                          </span>
                        ) : (
                          <button className="linkbtn danger" onClick={() => setConfirm(c.id)}>
                            Delete
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </section>
  )
}

