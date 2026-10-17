import { useEffect, useRef, useState } from 'react'
import { MAX_UPLOAD_BYTES } from '../../shared/docs.ts'
import type { DocMeta } from '../../shared/docs.ts'
import { docsApi } from '../lib.ts'
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
        Summary for the assistant
        <small>What the document covers. The assistant reads only these summaries first and then opens the documents that fit the enquiry.</small>
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

export default function KnowledgePage() {
  const open = useOpenSource()
  const [docs, setDocs] = useState<DocMeta[] | null>(null)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [pending, setPending] = useState<File | null>(null)
  const [dragOver, setDragOver] = useState(false)
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

  const active = docs?.filter((d) => d.enabled).length ?? 0

  return (
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
          The assistant first reads the summary of every active document, then opens only the documents that fit the enquiry. Expert notes are
          passed along whenever a document is cited.
        </p>

        {pending ? (
          <UploadForm
            file={pending}
            onCancel={() => setPending(null)}
            onDone={(d) => {
              setDocs((prev) => [...(prev ?? []), d])
              setPending(null)
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
                    <span className={`tag ${d.origin}`}>{d.origin === 'original' ? 'Original' : 'Uploaded'}</span>
                    {!d.indexed && <span className="kb-muted kb-unindexed">Not searchable yet</span>}
                  </td>
                  <td>{d.pages ?? '–'}</td>
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
                expanded === d.id && (
                  <tr key={`${d.id}-details`} className="kb-details-row">
                    <td colSpan={7}>
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
  )
}
