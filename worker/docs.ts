import { BUNDLED_DOCS, MAX_UPLOAD_BYTES } from '../shared/docs.ts'
import { getCards } from './cards.ts'
import type { DocMeta, DocPatch } from '../shared/docs.ts'

// KV layout
//   meta:<id>   DocMeta of an upload (with the owning workspace)
//   ws:<workspace>:meta:<id>   DocPatch of a bundled source (switched off, notes …) – this browser only
//   ws:<workspace>:cards:<id>  re-read or edited cards of a bundled source – this browser only
//   file:<id>   PDF bytes (uploads only; originals are static assets)
//   text:<id>   string[] – extracted text per page (for retrieval and highlighting)
//   cards:<id>  CardSet – knowledge cards read from the whole document
//   run:<hash>  cached assessment (see worker/steps.ts)

const json = (data: unknown, status = 200) => Response.json(data, { status })
// bundled documents (originals and curated added sources) are static assets: they can be switched off, not deleted
const isOriginal = (id: string) => BUNDLED_DOCS.some((d) => d.id === id)

/** Workspace id sent by the browser (x-afs-workspace); '' = none, i.e. the shared curated state only. */
export function workspaceOf(request: Request): string {
  const ws = request.headers.get('x-afs-workspace') ?? ''
  return /^[A-Za-z0-9-]{8,64}$/.test(ws) ? ws : ''
}

/** The bundled sources (with this workspace's own settings) and the uploads of this workspace. */
export async function listDocs(kv: KVNamespace, ws = ''): Promise<DocMeta[]> {
  const originals = await Promise.all(
    BUNDLED_DOCS.map(async (d) => ({ ...d, ...((ws && (await kv.get<DocPatch>(`ws:${ws}:meta:${d.id}`, 'json'))) || {}) })),
  )
  const keys = ws ? await kv.list({ prefix: 'meta:u-' }) : { keys: [] }
  const uploads = (await Promise.all(keys.keys.map((k) => kv.get<DocMeta>(k.name, 'json')))).filter((d): d is DocMeta => d !== null && d.owner === ws)
  uploads.sort((a, b) => b.addedAt.localeCompare(a.addedAt))
  const indexed = new Set((await kv.list({ prefix: 'text:' })).keys.map((k) => k.name.slice(5)))
  const all = [...originals, ...uploads]
  const sets = await Promise.all(all.map((d) => getCards(kv, d.id, ws)))
  return all.map((d, i) => ({ ...d, indexed: indexed.has(d.id), ...(sets[i] ? { cards: sets[i]!.cards.length, cardsAt: sets[i]!.createdAt, cardsCurated: sets[i]!.curated } : {}) }))
}

function cleanPatch(body: Record<string, unknown>): DocPatch {
  const patch: DocPatch = {}
  if (typeof body.title === 'string') patch.title = body.title.trim().slice(0, 200)
  if (typeof body.summary === 'string') patch.summary = body.summary.trim().slice(0, 2000)
  if (typeof body.notes === 'string') patch.notes = body.notes.trim().slice(0, 4000)
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
  return patch
}

/** Handles /api/docs routes; returns null for other paths. */
/** May this workspace change the document? Bundled sources: only with a workspace (changes stay in it). Uploads: only the owner. */
export async function canChange(kv: KVNamespace, id: string, ws: string): Promise<boolean> {
  if (!ws) return false
  if (isOriginal(id)) return true
  return (await kv.get<DocMeta>(`meta:${id}`, 'json'))?.owner === ws
}

export async function handleDocs(request: Request, kv: KVNamespace): Promise<Response | null> {
  const ws = workspaceOf(request)
  const url = new URL(request.url)
  const parts = url.pathname.split('/').filter(Boolean) // ['api','docs',id?,'file'?]
  if (parts[0] !== 'api' || parts[1] !== 'docs') return null
  const id = parts[2] ? decodeURIComponent(parts[2]) : undefined

  // GET /api/docs
  if (!id && request.method === 'GET') return json(await listDocs(kv, ws))

  // POST /api/docs  (multipart: file, title, summary, notes, pageTexts)
  if (!id && request.method === 'POST') {
    if (!ws) return json({ error: 'Uploads need a browser workspace – reload the page.' }, 400)
    const form = await request.formData()
    const file = form.get('file')
    if (!(file instanceof File)) return json({ error: 'Choose a PDF file to upload.' }, 400)
    if (file.type && file.type !== 'application/pdf') return json({ error: 'Only PDF files can be uploaded.' }, 400)
    if (file.size > MAX_UPLOAD_BYTES) return json({ error: 'The file is larger than 20 MB.' }, 400)
    const bytes = await file.arrayBuffer()
    const head = new TextDecoder().decode(bytes.slice(0, 5))
    if (head !== '%PDF-') return json({ error: 'This file is not a valid PDF.' }, 400)

    let pageTexts: string[] = []
    try {
      const raw = form.get('pageTexts')
      if (typeof raw === 'string') pageTexts = (JSON.parse(raw) as unknown[]).map(String)
    } catch {
      pageTexts = []
    }
    const newId = `u-${crypto.randomUUID().slice(0, 8)}`
    const fields = cleanPatch(Object.fromEntries(form.entries()) as Record<string, unknown>)
    const meta: DocMeta = {
      id: newId,
      title: fields.title || file.name.replace(/\.pdf$/i, ''),
      fileName: file.name,
      origin: 'uploaded',
      url: `/api/docs/${newId}/file`,
      pages: pageTexts.length || null,
      size: file.size,
      addedAt: new Date().toISOString(),
      summary: fields.summary ?? '',
      notes: fields.notes ?? '',
      enabled: true,
      owner: ws,
    }
    await kv.put(`file:${newId}`, bytes)
    if (pageTexts.length) await kv.put(`text:${newId}`, JSON.stringify(pageTexts))
    await kv.put(`meta:${newId}`, JSON.stringify(meta))
    return json(meta, 201)
  }

  if (!id) return json({ error: 'Not found' }, 404)

  // GET /api/docs/:id/file
  if (parts[3] === 'file' && request.method === 'GET') {
    const bytes = await kv.get(`file:${id}`, 'arrayBuffer')
    if (!bytes) return json({ error: 'File not found.' }, 404)
    return new Response(bytes, { headers: { 'content-type': 'application/pdf', 'cache-control': 'private, max-age=300' } })
  }

  // PUT /api/docs/:id/text  – store extracted page texts (used to index the bundled originals)
  if (parts[3] === 'text' && request.method === 'PUT') {
    const pages = (await request.json().catch(() => null)) as unknown
    if (!Array.isArray(pages) || pages.length === 0) return json({ error: 'Body must be a non-empty array of page texts.' }, 400)
    if (isOriginal(id)) {
      // shared page texts of a bundled PDF are written once (first visit) and never replaced
      if (await kv.get(`text:${id}`)) return json({ indexed: id, pages: pages.length })
    } else {
      if (!(await canChange(kv, id, ws))) return json({ error: 'Document not found.' }, 404)
      await kv.delete(`cards:${id}`) // new text: the cards have to be read again
    }
    await kv.put(`text:${id}`, JSON.stringify(pages.map(String)))
    return json({ indexed: id, pages: pages.length })
  }

  // PATCH /api/docs/:id
  if (request.method === 'PATCH') {
    const patch = cleanPatch((await request.json().catch(() => ({}))) as Record<string, unknown>)
    const stamp = patch.notes !== undefined ? { notesUpdatedAt: new Date().toISOString() } : {}
    if (!(await canChange(kv, id, ws))) return json({ error: 'Document not found.' }, 404)
    if (isOriginal(id)) {
      const prev = (await kv.get<DocPatch>(`ws:${ws}:meta:${id}`, 'json')) ?? {}
      await kv.put(`ws:${ws}:meta:${id}`, JSON.stringify({ ...prev, ...patch, ...stamp }))
    } else {
      const prev = (await kv.get<DocMeta>(`meta:${id}`, 'json'))!
      await kv.put(`meta:${id}`, JSON.stringify({ ...prev, ...patch, ...stamp }))
    }
    return json((await listDocs(kv, ws)).find((d) => d.id === id))
  }

  // DELETE /api/docs/:id  (uploads only)
  if (request.method === 'DELETE') {
    if (isOriginal(id)) return json({ error: 'Original AFS documents cannot be deleted. Turn off “Used by AI” instead.' }, 400)
    if (!(await canChange(kv, id, ws))) return json({ error: 'Document not found.' }, 404)
    await Promise.all([kv.delete(`meta:${id}`), kv.delete(`file:${id}`), kv.delete(`text:${id}`), kv.delete(`cards:${id}`)])
    return json({ deleted: id })
  }

  return json({ error: 'Not found' }, 404)
}
