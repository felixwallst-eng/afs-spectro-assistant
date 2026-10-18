import { AGENT_MODELS } from '../shared/agent.ts'
import type { AgentModelKey } from '../shared/agent.ts'
import type { CardSet, KnowledgeCard } from '../shared/cards.ts'
import { DIM_BY_ID } from '../shared/dimensions.ts'
import { findQuotePage, fold } from '../shared/text.ts'
import { TREE_NODES } from '../shared/tree.ts'
import { chat, parseJson } from './agent.ts'
import { SEED_CARDS } from './seedCards.ts'

// Workspaces: every browser sends its own id (x-afs-workspace). Re-reads and edits of the bundled sources (S01–S04, A01)
// are stored under that id only, so they never change what other users get. Without an id (scripts, benchmark) the curated
// cards from the repository are always used. Uploads belong to the workspace that added them and keep their cards in cards:<id>.
const isBundled = (docId: string) => docId in SEED_CARDS
const cardsKey = (docId: string, ws: string) => (isBundled(docId) ? (ws ? `ws:${ws}:cards:${docId}` : null) : `cards:${docId}`)

const CHUNK_CHARS = 12_000 // pages are read in parts of about 3,000 tokens
const PER_CHUNK = 14

type Ai = Parameters<typeof chat>[0]

/** Group consecutive pages into parts of at most CHUNK_CHARS characters. */
function chunkPages(pages: string[]): { from: number; text: string }[] {
  const out: { from: number; text: string }[] = []
  let cur = ''
  let from = 1
  pages.forEach((p, i) => {
    const block = `=== Page ${i + 1} ===\n${p.slice(0, CHUNK_CHARS)}\n`
    if (cur && cur.length + block.length > CHUNK_CHARS) {
      out.push({ from, text: cur })
      cur = ''
      from = i + 1
    }
    cur += block
  })
  if (cur) out.push({ from, text: cur })
  return out
}

const STEP_GUIDE = TREE_NODES.map((n) => {
  const d = DIM_BY_ID[n.id]
  const labels = Object.entries(d.labels).filter(([k]) => k !== d.unknownLabel).map(([k, l]) => `${k} (${l.name})`).join(', ')
  return `- ${n.id} – ${d.title} / method table column "${n.column}". Labels: ${labels}`
}).join('\n')

/** Read the whole document and store its verified knowledge cards. */
export async function buildCards(aiBinding: unknown, kv: KVNamespace, docId: string, docTitle: string, ws = '', modelKey: AgentModelKey = 'gptoss'): Promise<CardSet> {
  const ai = aiBinding as Ai
  const pages = (await kv.get<string[]>(`text:${docId}`, 'json')) ?? []
  if (!pages.length) throw new Error(`${docId} has no page text yet – open the Knowledge base tab once so it is indexed.`)
  const chunks = chunkPages(pages)
  const system = [
    'You read one part of a technical document for Art Fiber Systems (AFS), a company that designs in-line fiber-optic spectroscopy setups.',
    'Extract the statements that help an expert decide these steps when choosing a measurement setup for a customer:',
    STEP_GUIDE,
    `Rules: only statements the text makes explicitly; at most ${PER_CHUNK} for this part; prefer statements that link a condition to a consequence for the method choice (e.g. a sample type to a measurement geometry, a property to a method, a range to a fiber).`,
    'For each statement give: "step" (one id above), "value" (the label it points to, or null for general guidance), "claim" (one sentence in your own words: under which condition what follows), "quote" (one sentence copied exactly from the page), "page" (number from the page marker).',
    'Answer only with JSON: {"cards": [{"step": "...", "value": "label or null", "claim": "...", "quote": "...", "page": 1}]}. If the part contains nothing relevant, answer {"cards": []}.',
  ].join('\n')

  const results = await Promise.all(
    chunks.map((c, i) =>
      chat(ai, AGENT_MODELS[modelKey].id, modelKey, system, `Document: ${docTitle} [${docId}]\nPart ${i + 1} of ${chunks.length}\n\n${c.text}`, 2500, { seed: 7 })
        .then((r) => parseJson<{ cards?: { step?: string; value?: string | null; claim?: string; quote?: string; page?: number }[] }>(r.text)?.cards ?? [])
        .catch(() => []),
    ),
  )

  const cards: KnowledgeCard[] = []
  let rejected = 0
  for (const raw of results.flat()) {
    const def = raw?.step ? DIM_BY_ID[raw.step] : undefined
    if (!def || !TREE_NODES.some((n) => n.id === raw.step) || !raw.quote || !raw.claim) {
      rejected++
      continue
    }
    const page = findQuotePage(pages, raw.quote, Number(raw.page) || undefined)
    if (!page) {
      rejected++
      continue
    }
    if (cards.some((c) => c.step === raw.step && fold(c.quote) === fold(raw.quote!))) continue
    const value = raw.value && raw.value in def.labels && raw.value !== def.unknownLabel ? raw.value : null
    cards.push({ id: `${docId}-${cards.length + 1}`, docId, page, step: raw.step!, value, claim: raw.claim.trim().slice(0, 300), quote: raw.quote.trim().slice(0, 600) })
  }
  // stable order: by step, then page
  const order = new Map(TREE_NODES.map((n, i) => [n.id, i]))
  cards.sort((a, b) => (order.get(a.step)! - order.get(b.step)!) || a.page - b.page || a.id.localeCompare(b.id))
  const set: CardSet = { docId, createdAt: new Date().toISOString(), model: AGENT_MODELS[modelKey].name, pagesRead: pages.length, cards, rejected }
  const k = cardsKey(docId, ws)
  if (k) await kv.put(k, JSON.stringify(set)) // bundled source without workspace: returned only, never stored
  return set
}

/** The cards of one document: this workspace's edited / re-read copy, else the curated file. */
export async function getCards(kv: KVNamespace, docId: string, ws = ''): Promise<(CardSet & { curated: boolean }) | null> {
  const k = cardsKey(docId, ws)
  const stored = k ? await kv.get<CardSet>(k, 'json') : null
  const seed = SEED_CARDS[docId]
  // a stored copy wins only if it is newer than the curated file (expert edit or re-read after curation)
  if (stored && (!seed || stored.createdAt > seed.createdAt)) return { ...stored, curated: false }
  return seed ? { ...seed, curated: true } : null
}

export async function loadCards(kv: KVNamespace, docIds: string[], ws = ''): Promise<CardSet[]> {
  const sets = await Promise.all(docIds.map((id) => getCards(kv, id, ws)))
  return sets.filter((s): s is CardSet & { curated: boolean } => s !== null)
}

/** Drop this workspace's copy so the curated cards apply again. */
export async function resetCards(kv: KVNamespace, docId: string, ws = '') {
  const k = cardsKey(docId, ws)
  if (k && isBundled(docId)) await kv.delete(k)
  return getCards(kv, docId, ws)
}

/** Remove a single card (expert review). */
export async function deleteCard(kv: KVNamespace, docId: string, cardId: string, ws = ''): Promise<CardSet | null> {
  const k = cardsKey(docId, ws)
  if (!k) throw new Error('Changes to the bundled sources need a workspace id.')
  const current = await getCards(kv, docId, ws)
  if (!current) return null
  const { curated: _curated, ...set } = current
  void _curated
  set.cards = set.cards.filter((c) => c.id !== cardId)
  set.createdAt = new Date().toISOString()
  set.model = `${set.model.replace(/ · edited by expert$/, '')} · edited by expert`
  await kv.put(k, JSON.stringify(set))
  return set
}
