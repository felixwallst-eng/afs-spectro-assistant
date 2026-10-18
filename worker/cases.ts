import { MAX_CASE_BYTES, parseSolvedCase } from '../shared/solvedCases.ts'
import type { SolvedCase } from '../shared/solvedCases.ts'
import REFERENCE from '../knowledge/cases/reference-cases.json' with { type: 'json' }

// worked examples D01 and D02 from the AFS reference document, versioned in the repository
const REFERENCE_CASES = (REFERENCE as { cases: SolvedCase[] }).cases.map((c) => ({ ...c, origin: 'reference' as const }))
const isReference = (id: string) => REFERENCE_CASES.some((c) => c.id === id)

// Solved cases in KV: case:<workspace>:<id> → SolvedCase (JSON). Each browser sees the worked examples plus its own cases,
// so cases added while testing never show up for other users.
const key = (ws: string, id: string) => `case:${ws}:${id}`

export async function handleCases(request: Request, kv: KVNamespace, ws: string, id?: string): Promise<Response | null> {
  if (request.method === 'GET' && !id) {
    if (!ws) return Response.json(REFERENCE_CASES)
    const keys = await kv.list({ prefix: `case:${ws}:` })
    const all = await Promise.all(keys.keys.map((k) => kv.get<SolvedCase>(k.name, 'json')))
    const saved = all.filter((c): c is SolvedCase => !!c && !isReference(c.id)).sort((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt))
    return Response.json([...saved, ...REFERENCE_CASES])
  }
  if (request.method !== 'GET' && !ws) return Response.json({ error: 'Saving cases needs a browser workspace – reload the page.' }, { status: 400 })
  if (request.method === 'POST' && !id) {
    const raw = await request.text()
    if (raw.length > MAX_CASE_BYTES) return Response.json({ error: 'The case is too large.' }, { status: 413 })
    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      return Response.json({ error: 'Send the case as JSON.' }, { status: 400 })
    }
    const parsed = parseSolvedCase(body)
    if (!parsed) return Response.json({ error: 'A solved case needs the enquiry and the step decisions.' }, { status: 400 })
    if (isReference(parsed.id)) return Response.json({ error: 'The worked examples are part of the app and cannot be overwritten.' }, { status: 400 })
    // saving the same case again updates it and keeps its first date
    const old = await kv.get<SolvedCase>(key(ws, parsed.id), 'json')
    const saved: SolvedCase = old ? { ...parsed, createdAt: old.createdAt, updatedAt: parsed.createdAt } : parsed
    await kv.put(key(ws, saved.id), JSON.stringify(saved))
    return Response.json(saved)
  }
  if (request.method === 'DELETE' && id) {
    if (isReference(id)) return Response.json({ error: 'The worked examples are part of the app and cannot be deleted.' }, { status: 400 })
    await kv.delete(key(ws, id))
    return Response.json({ ok: true })
  }
  return null
}
