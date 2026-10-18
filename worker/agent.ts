import { AGENT_MODELS } from '../shared/agent.ts'
import type { AgentModelKey, AgentRequest, AgentResponse, AgentSuggestion, BriefRequest, BriefResponse, Finding } from '../shared/agent.ts'
import { DIM_BY_ID } from '../shared/dimensions.ts'
import type { DocMeta } from '../shared/docs.ts'
import { findQuotePage } from '../shared/text.ts'
import { listDocs } from './docs.ts'

// Pipeline (keeps cost low and every citation checkable):
//   1. route    – the model reads only the summaries + expert notes and picks up to 3 documents
//   2. retrieve – keyword search over the pages of those documents, top pages only
//   3. answer   – the model suggests a value per open question, with a verbatim quote
//   4. verify   – code checks that each quote really occurs in the cited document

type Runner = { run: (model: string, input: unknown) => Promise<unknown> }
interface ChatResult {
  choices?: { message?: { content?: string | null } }[]
  response?: string
  output_text?: string
  output?: { content?: { type?: string; text?: string }[] }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

const MAX_DOCS = 3
const MAX_PAGES = 6
const PAGE_CHARS = 3500

const MODEL_TIMEOUT_MS = 45_000

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`The model did not answer within ${ms / 1000} s – try again or switch the model in Settings.`)), ms)),
  ])
}

/** Whether the current model accepted a `seed`; switched off after the first rejection. */
let seedSupported = true
/** false once the model has rejected the `seed` parameter (runs then rely on temperature 0 only). */
export const seedAccepted = () => seedSupported

export async function chat(ai: Runner, model: string, key: AgentModelKey, system: string, user: string, maxTokens: number, opts: { seed?: number } = {}) {
  const input = {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    max_completion_tokens: maxTokens,
    temperature: 0,
    // gpt-oss: JSON is requested in the prompt; the parser extracts it either way
    ...(key === 'gptoss' ? {} : { response_format: { type: 'json_object' } }),
    reasoning_effort: key === 'kimi' ? 'none' : 'low',
  }
  let out: ChatResult
  if (opts.seed !== undefined && seedSupported) {
    try {
      out = (await withTimeout(ai.run(model, { ...input, seed: opts.seed }), MODEL_TIMEOUT_MS)) as ChatResult
    } catch (err) {
      if (!/seed/i.test(String(err))) throw err
      seedSupported = false // the model rejects the parameter – continue without it
      out = (await withTimeout(ai.run(model, input), MODEL_TIMEOUT_MS)) as ChatResult
    }
  } else out = (await withTimeout(ai.run(model, input), MODEL_TIMEOUT_MS)) as ChatResult
  // chat-completions shape, legacy `response`, or Responses-API `output` (gpt-oss) – take whichever is present
  const fromOutput = (out.output ?? [])
    .flatMap((o) => o.content ?? [])
    .filter((c) => c.type === 'output_text' || c.type === 'text')
    .map((c) => c.text ?? '')
    .join('')
  const text = out.choices?.[0]?.message?.content || out.response || out.output_text || fromOutput || ''
  return { text, usage: out.usage ?? {} }
}

export function parseJson<T>(text: string): T | null {
  const a = text.indexOf('{')
  const b = text.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try {
    return JSON.parse(text.slice(a, b + 1)) as T
  } catch {
    return null
  }
}

const STOP = new Set('the and for with that this from have will are our was were can not but all any into more than also such which when what need want should could would about there their they them been being only other some most very each first'.split(' '))
const terms = (s: string) => s.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g)?.filter((w) => !STOP.has(w)) ?? []

/** Rank pages by query-term overlap, weighted by how rare a term is across the candidate pages. */
export function rankPages(pages: { docId: string; page: number; text: string }[], query: string) {
  const q = [...new Set(terms(query))]
  const tf = pages.map((p) => {
    const counts = new Map<string, number>()
    for (const w of terms(p.text)) counts.set(w, (counts.get(w) ?? 0) + 1)
    return counts
  })
  const df = new Map(q.map((w) => [w, tf.filter((c) => c.has(w)).length]))
  return pages
    .map((p, i) => ({
      ...p,
      score: q.reduce((s, w) => {
        const n = tf[i].get(w) ?? 0
        return n ? s + (1 + Math.log(n)) * Math.log(1 + pages.length / (df.get(w) || 1)) : s
      }, 0),
    }))
    .sort((a, b) => b.score - a.score)
}

export async function runAgent(aiBinding: unknown, kv: KVNamespace, req: AgentRequest): Promise<AgentResponse> {
  const started = Date.now()
  const ai = aiBinding as Runner
  const key: AgentModelKey = req.model && req.model in AGENT_MODELS ? req.model : 'gptoss'
  const model = AGENT_MODELS[key].id
  const usage = { inputTokens: 0, outputTokens: 0 }
  const addUsage = (u: ChatResult['usage']) => {
    usage.inputTokens += u?.prompt_tokens ?? 0
    usage.outputTokens += u?.completion_tokens ?? 0
  }

  const dims = req.dimensionIds.map((id) => DIM_BY_ID[id]).filter((d) => d && d.kind !== 'flag')
  const docs = (await listDocs(kv)).filter((d) => d.enabled && d.indexed)
  if (!docs.length) throw new Error('No searchable documents. Open the Knowledge base tab once so the documents are indexed.')

  // 1. route ---------------------------------------------------------------
  const catalog = docs.map((d) => `[${d.id}] ${d.title}\nSummary: ${d.summary || '(none)'}${d.notes ? `\nExpert note: ${d.notes}` : ''}`).join('\n\n')
  const route = await chat(
    ai,
    model,
    key,
    'You select reference documents for a spectroscopy expert. Answer only with JSON: {"documents": ["ID", ...]} – at most 3 IDs, most useful first.',
    `Customer enquiry:\n${req.text}\n\nOpen questions:\n${dims.map((d) => `- ${d.clarification ?? d.question}`).join('\n')}\n\nAvailable documents:\n${catalog}`,
    300,
  )
  addUsage(route.usage)
  const picked = (parseJson<{ documents?: unknown }>(route.text)?.documents ?? [])
  let chosen: DocMeta[] = (Array.isArray(picked) ? picked : []).map((id) => docs.find((d) => d.id === String(id))).filter((d): d is DocMeta => !!d)
  chosen = [...new Set(chosen)].slice(0, MAX_DOCS)
  if (!chosen.length) chosen = docs.slice(0, MAX_DOCS) // fall back to all (small knowledge base)

  // 2. retrieve ------------------------------------------------------------
  const texts = new Map<string, string[]>()
  for (const d of chosen) texts.set(d.id, (await kv.get<string[]>(`text:${d.id}`, 'json')) ?? [])
  const allPages = chosen.flatMap((d) => (texts.get(d.id) ?? []).map((text, i) => ({ docId: d.id, page: i + 1, text })))
  // the enquiry carries most of the signal; question wording adds the topic of each open point
  const query = `${req.text} ${req.text} ${dims.map((d) => d.clarification ?? d.title).join(' ')}`
  const top = rankPages(allPages, query).filter((p) => p.text.trim()).slice(0, MAX_PAGES)

  // 3. answer --------------------------------------------------------------
  const excerpts = top.map((p) => `<excerpt doc="${p.docId}" page="${p.page}">\n${p.text.slice(0, PAGE_CHARS)}\n</excerpt>`).join('\n\n')
  const notes = chosen.filter((d) => d.notes).map((d) => `[${d.id}] ${d.notes}`).join('\n')
  const questionBlock = dims
    .map((d) => `- id: ${d.id}\n  question: ${d.clarification ?? d.question}\n  allowed values: ${Object.entries(d.labels).filter(([k]) => k !== d.unknownLabel).map(([k, l]) => `${k} (${l.description})`).join('; ')}`)
    .join('\n')
  const answer = await chat(
    ai,
    model,
    key,
    [
      'You assist a spectroscopy expert at Art Fiber Systems. For each open question, suggest a likely value as a hypothesis the expert will confirm with the client.',
      'Rules:',
      '- Base a suggestion on the customer enquiry together with the supplied excerpts. Never invent client facts, numbers or sources.',
      '- "quote" must be one sentence copied character for character from an excerpt that supports the suggestion; give its doc and page.',
      '- If the excerpts give no real support, use value null and explain briefly. Prefer null over a weak guess.',
      '- Respect the expert notes about each document.',
      '- Answer only with JSON: {"answers": [{"id": "...", "value": "allowed value or null", "rationale": "max 2 sentences", "quote": "...", "doc": "ID", "page": 1}]}',
    ].join('\n'),
    `Customer enquiry:\n${req.text}\n\nOpen questions:\n${questionBlock}\n\nExpert notes:\n${notes || '(none)'}\n\nExcerpts:\n${excerpts}`,
    1200,
  )
  addUsage(answer.usage)

  // 4. verify --------------------------------------------------------------
  type Raw = { id?: string; value?: string | null; rationale?: string; quote?: string; doc?: string; page?: number }
  const raw = parseJson<{ answers?: Raw[] }>(answer.text)?.answers ?? []
  const suggestions: AgentSuggestion[] = dims.map((d) => {
    const a = raw.find((r) => r?.id === d.id)
    const value = a?.value && a.value in d.labels && a.value !== d.unknownLabel ? a.value : null
    const rationale = (a?.rationale ?? '').toString().slice(0, 400)
    if (!value) return { dimensionId: d.id, value: null, rationale: rationale || 'The knowledge base gives no basis for this – ask the client.', status: 'none' }
    const doc = chosen.find((x) => x.id === a?.doc) ?? null
    const page = doc && a?.quote ? findQuotePage(texts.get(doc.id) ?? [], a.quote, Number(a.page) || undefined) : null
    if (!doc || !page || !a?.quote)
      return { dimensionId: d.id, value: null, rationale: 'A suggestion was withheld because its quoted source could not be found in the documents.', status: 'withheld' }
    return { dimensionId: d.id, value, rationale, quote: a.quote, docId: doc.id, docTitle: doc.title, page, status: 'verified' }
  })

  return {
    model: AGENT_MODELS[key].name,
    selectedDocs: chosen.map((d) => ({ id: d.id, title: d.title })),
    pagesRead: top.map((p) => ({ docId: p.docId, page: p.page })),
    suggestions,
    latencyMs: Date.now() - started,
    usage,
  }
}

// ---------------------------------------------------------------------------
// Fast path: one model call that returns the key evidence for the enquiry,
// each finding backed by a verbatim quote that is checked against the PDF text.
// ---------------------------------------------------------------------------

export async function runBrief(aiBinding: unknown, kv: KVNamespace, req: BriefRequest): Promise<BriefResponse> {
  const started = Date.now()
  const ai = aiBinding as Runner
  const key: AgentModelKey = req.model && req.model in AGENT_MODELS ? req.model : 'gptoss'
  const docs = (await listDocs(kv)).filter((d) => d.enabled && d.indexed)
  if (!docs.length) throw new Error('No searchable documents. Open the Knowledge base tab once so the documents are indexed.')

  const texts = new Map<string, string[]>()
  for (const d of docs) texts.set(d.id, (await kv.get<string[]>(`text:${d.id}`, 'json')) ?? [])
  const pages = docs.flatMap((d) => (texts.get(d.id) ?? []).map((text, i) => ({ docId: d.id, page: i + 1, text })))
  const top = rankPages(pages, `${req.text} ${req.text}`).filter((p) => p.text.trim()).slice(0, 5)

  const excerpts = top.map((p) => `<excerpt doc="${p.docId}" page="${p.page}">\n${p.text.slice(0, 2500)}\n</excerpt>`).join('\n\n')
  const notes = docs.filter((d) => d.notes).map((d) => `[${d.id}] ${d.notes}`).join('\n')
  const res = await chat(
    ai,
    AGENT_MODELS[key].id,
    key,
    [
      'You support a spectroscopy expert at Art Fiber Systems with a first technical assessment of a customer enquiry.',
      'From the excerpts, give the 3 most relevant findings for this enquiry (method choice, probe geometry, risks).',
      'Each finding: "statement" = max 2 sentences on what it means for this enquiry; "quote" = one sentence copied character for character from an excerpt; "doc" and "page" of that excerpt.',
      'Use only the excerpts. Never invent numbers or sources. Respect the expert notes.',
      'Answer only with JSON: {"findings": [{"statement": "...", "quote": "...", "doc": "ID", "page": 1}]}',
    ].join('\n'),
    `Customer enquiry:\n${req.text}\n\nExpert notes:\n${notes || '(none)'}\n\nExcerpts:\n${excerpts}`,
    700,
  )

  type Raw = { statement?: string; quote?: string; doc?: string; page?: number }
  const raw = parseJson<{ findings?: Raw[] }>(res.text)?.findings ?? []
  const findings: Finding[] = []
  let withheld = 0
  for (const f of raw.slice(0, 5)) {
    const doc = docs.find((d) => d.id === f?.doc)
    const page = doc && f.quote ? findQuotePage(texts.get(doc.id) ?? [], f.quote, Number(f.page) || undefined) : null
    if (!doc || !page || !f.quote || !f.statement) {
      withheld++
      continue
    }
    findings.push({ statement: String(f.statement).slice(0, 400), quote: f.quote, docId: doc.id, docTitle: doc.title, page })
  }

  return {
    model: AGENT_MODELS[key].name,
    findings,
    withheld,
    pagesRead: top.map((p) => ({ docId: p.docId, page: p.page })),
    latencyMs: Date.now() - started,
    usage: { inputTokens: res.usage.prompt_tokens ?? 0, outputTokens: res.usage.completion_tokens ?? 0 },
  }
}
