import { AGENT_MODELS } from '../shared/agent.ts'
import type { AgentModelKey } from '../shared/agent.ts'
import type { KnowledgeCard } from '../shared/cards.ts'
import { DIMENSIONS, DIM_BY_ID } from '../shared/dimensions.ts'
import type { DimensionDef } from '../shared/types.ts'
import { fold } from '../shared/text.ts'
import { SOURCE_STEPS, TREE_NODES } from '../shared/tree.ts'
import type { Decision, DecisionBasis, SourcePassage, StepsRequest, TreeResponse } from '../shared/tree.ts'
import { chat, parseJson, seedAccepted } from './agent.ts'
import { deriveSteps, premisesFor } from '../shared/treeLogic.ts'
import { loadCards } from './cards.ts'
import { listDocs } from './docs.ts'

// Reproducible assessment
//  1. Knowledge: every enabled document was read completely into knowledge cards when it was
//     added (worker/cards.ts). Each step gets ALL cards for that step – no search, same input every time.
//  2. One small call per decision step (plus one for the other facts), each asked closed questions.
//  3. The basis (customer / sources / missing) is decided by rules in code, not by the model.
//  4. Every call runs VOTES times; the runs vote on the value, then the basis is "stated" as soon as one
//     agreeing run found a verified quote. Without a majority the step is left open for the expert –
//     instability becomes a visible uncertainty instead of noise.
//  5. Identical input (text, model, sources, cards) returns the stored result unless a fresh run is asked for.

export const PIPELINE_VERSION = 'steps-v3'
const DEFAULT_VOTES = 3
const MAX_CARDS_PER_STEP = 40
const MIN_QUOTE = 8
const TREE_IDS = new Set(TREE_NODES.map((n) => n.id))
type Ai = Parameters<typeof chat>[0]

const values = (d: DimensionDef) =>
  Object.entries(d.labels)
    .filter(([k]) => k !== d.unknownLabel)
    .map(([k, l]) => `${k} = ${l.description}`)
    .join('\n  ')

const STEP_SYSTEM = [
  'You support a spectroscopy expert at Art Fiber Systems (AFS). You answer ONE decision step for a customer enquiry.',
  'Answer these questions in order:',
  'Q1 "value": the value that fits THIS case, judged from the customer text first and the AFS knowledge cards second; null if neither supports one.',
  'Q2 "enquiry_quote": the phrase in the customer text that states or directly describes this value, copied character for character; null if the value comes only from the cards. Always look for such a phrase before answering null.',
  'Q3 "cards_used": ids of the AFS knowledge cards that are relevant to this enquiry for this step.',
  'Q4 "reasoning": 2–4 sentences on what the customer wrote and what the cards say about it; cite cards inline like [C3].',
  'Q5 "check": one sentence if a card contradicts, qualifies or adds a risk to what the customer states or assumes; otherwise null.',
  'Q6 "missing": if value is null, the one question to ask the customer; otherwise null.',
  'Answer only with JSON: {"value": "label or null", "enquiry_quote": "... or null", "cards_used": ["C1"], "reasoning": "...", "check": null, "missing": null}',
].join('\n')

const FACT_SYSTEM = [
  'You extract facts from a customer enquiry for a spectroscopy expert. Use only what the customer wrote.',
  'For each fact: the value only if the enquiry states it, with "enquiry_quote" copied character for character from the enquiry; otherwise value null.',
  'For flags: list only those the customer clearly mentions, each with its enquiry_quote.',
  'Answer only with JSON: {"facts": [{"id": "...", "value": "label or null", "enquiry_quote": "..."}], "flags": [{"id": "...", "enquiry_quote": "..."}]}',
].join('\n')

interface StepRun {
  basis: DecisionBasis
  value: string | null
  quote?: string
  reasoning?: string
  cardKeys: string[]
  check?: string
  missing?: string
  rejected?: string
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const terms = (s: string) => new Set(s.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? [])

export async function runSteps(aiBinding: unknown, kv: KVNamespace, req: StepsRequest): Promise<TreeResponse> {
  const started = Date.now()
  const ai = aiBinding as Ai
  const key: AgentModelKey = req.model && req.model in AGENT_MODELS ? req.model : 'gptoss'
  const model = AGENT_MODELS[key].id
  const votes = req.votes ?? DEFAULT_VOTES
  const sources = req.sources ?? 'all'

  // ------------------------------------------------------------ knowledge
  const docs = (await listDocs(kv)).filter((d) => d.enabled && (sources === 'all' || d.origin === 'original'))
  const sets = await loadCards(kv, docs.map((d) => d.id))
  const title = (id: string) => docs.find((d) => d.id === id)?.title ?? id
  const allCards = sets.flatMap((s) => s.cards)
  const notes = docs.filter((d) => d.notes).map((d) => `[${d.id}] ${d.notes}`).join('\n')

  // ------------------------------------------------------------ cache
  const cacheKey = `run:${await sha256(
    JSON.stringify({
      v: PIPELINE_VERSION,
      text: req.text,
      model: key,
      sources,
      votes,
      docs: docs.map((d) => [d.id, d.cardsAt ?? '', d.notesUpdatedAt ?? '']),
      cards: allCards.map((c) => c.id),
    }),
  )}`
  const benchmark = req.seedBase !== undefined || req.stepsOnly === true
  if (!req.fresh && !benchmark) {
    const hit = await kv.get<TreeResponse>(cacheKey, 'json')
    if (hit) return { ...hit, cachedAt: hit.cachedAt ?? new Date().toISOString() }
  }

  const enquiry = fold(req.text)
  const inEnquiry = (q?: string | null) => !!q && fold(q).length >= MIN_QUOTE && enquiry.includes(fold(q))
  const usage = { inputTokens: 0, outputTokens: 0 }
  let calls = 0
  const errors: string[] = []
  const fail = (e: unknown) => {
    errors.push(e instanceof Error ? e.message : String(e))
    return null
  }
  let rejectedQuotes = 0
  const ask = async (system: string, user: string, maxTokens: number, seed: number) => {
    calls++
    const r = await chat(ai, model, key, system, user, maxTokens, { seed })
    usage.inputTokens += r.usage.prompt_tokens ?? 0
    usage.outputTokens += r.usage.completion_tokens ?? 0
    return r.text
  }

  // ------------------------------------------------------------ one step, one run
  const stepCards = (stepId: string): KnowledgeCard[] => {
    const cards = allCards.filter((c) => c.step === stepId)
    if (cards.length <= MAX_CARDS_PER_STEP) return cards
    // large knowledge base: keep the cards that share the most words with the enquiry (deterministic)
    const q = terms(req.text)
    const overlap = (c: KnowledgeCard) => [...terms(`${c.claim} ${c.quote}`)].filter((t) => q.has(t)).length
    return [...cards].sort((a, b) => overlap(b) - overlap(a) || a.id.localeCompare(b.id)).slice(0, MAX_CARDS_PER_STEP)
  }

  async function runStep(def: DimensionDef, column: string, cards: KnowledgeCard[], seed: number): Promise<StepRun> {
    const cardBlock = cards
      .map((c, i) => `<card id="C${i + 1}" doc="${c.docId}" page="${c.page}"${c.value ? ` points_to="${c.value}"` : ''}>${c.claim} — “${c.quote}”</card>`)
      .join('\n')
    const user = [
      `Customer enquiry:\n"""${req.text}"""`,
      `Step: ${def.id} – ${def.title} (AFS method table column "${column}")`,
      `Question: ${def.question.split(' Only use')[0]}`,
      `Values:\n  ${values(def)}`,
      `AFS knowledge cards for this step:\n${cardBlock || '(none)'}`,
      notes ? `Expert notes on documents:\n${notes}` : '',
    ]
      .filter(Boolean)
      .join('\n\n')
    const text = await ask(STEP_SYSTEM, user, 1400, seed)
    const r = parseJson<{ value?: string | null; enquiry_quote?: string | null; cards_used?: string[]; reasoning?: string; check?: string | null; missing?: string | null }>(text) ?? {}
    const valid = (v?: string | null) => (v && v in def.labels && v !== def.unknownLabel ? v : null)
    const cardKeys = [...new Set([...(r.cards_used ?? []), ...[...(r.reasoning ?? '').matchAll(/C(\d+)/g)].map((m) => `C${m[1]}`)])].filter((k) => {
      const n = Number(k.slice(1))
      return n >= 1 && n <= cards.length
    })
    const base = { reasoning: r.reasoning?.slice(0, 900), cardKeys, check: r.check?.slice(0, 300) || undefined, missing: r.missing?.slice(0, 300) || undefined }
    // The basis is decided here, by fixed rules – not by the model:
    //   verified quote from the enquiry            -> stated by the customer
    //   no quote, but cited cards (source steps)   -> suggestion from the AFS sources
    //   otherwise                                  -> information missing
    const value = valid(r.value)
    if (value && inEnquiry(r.enquiry_quote)) return { ...base, basis: 'customer', value, quote: r.enquiry_quote! }
    if (value && r.enquiry_quote) rejectedQuotes++
    if (value && cardKeys.length && SOURCE_STEPS.has(def.id)) return { ...base, basis: 'sources', value }
    return { ...base, basis: 'missing', value: null }
  }

  // ------------------------------------------------------------ all steps × votes, in parallel
  const seeds = Array.from({ length: votes }, (_, i) => i + 1 + (req.seedBase ?? 0))
  const treeDefs = TREE_NODES.map((n) => ({ def: DIM_BY_ID[n.id], column: n.column, cards: stepCards(n.id) }))
  const otherFacts = DIMENSIONS.filter((d) => d.kind !== 'flag' && !TREE_IDS.has(d.id))
  const flags = DIMENSIONS.filter((d) => d.kind === 'flag')
  const factUser = `Customer enquiry:\n"""${req.text}"""\n\nFacts:\n${otherFacts.map((d) => `- ${d.id}: ${d.question.split(' Only use')[0]}\n  values: ${values(d).replace(/\n {2}/g, ' | ')}`).join('\n')}\n\nFlags:\n${flags.map((d) => `- ${d.id}: ${d.labels.yes.description}`).join('\n')}`

  const [stepRuns, factRuns] = await Promise.all([
    Promise.all(treeDefs.map((t) => Promise.all(seeds.map((s) => runStep(t.def, t.column, t.cards, s).catch(fail))))),
    Promise.all(
      (req.stepsOnly ? [] : seeds).map((s) =>
        ask(FACT_SYSTEM, factUser, 1800, s)
          .then((t) => parseJson<{ facts?: { id?: string; value?: string | null; enquiry_quote?: string }[]; flags?: { id?: string; enquiry_quote?: string }[] }>(t) ?? {})
          .catch(fail),
      ),
    ),
  ])
  // never present failed calls as a result: a step without a single successful run is an error
  if (stepRuns.some((runs) => runs.every((r) => r === null)) || (factRuns.length > 0 && factRuns.every((f) => f === null))) {
    throw new Error(`${errors.length} of ${calls} model calls failed – ${errors[0] ?? 'no answer'}`)
  }

  // ------------------------------------------------------------ majority per step
  let verifiedSources = 0
  const decisions: Decision[] = treeDefs.map((t, ti) => {
    const runs = stepRuns[ti].filter((r): r is StepRun => r !== null)
    // 1. vote on the VALUE (a missing value counts as one option)
    const byValue = new Map<string, StepRun[]>()
    for (const r of runs) {
      const k = r.value ?? '(missing)'
      byValue.set(k, [...(byValue.get(k) ?? []), r])
    }
    const ranked = [...byValue.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    const outcomes = ranked.map(([k, rs]) => ({
      label: k === '(missing)' ? 'information missing' : `${t.def.labels[k].name}${rs.some((r) => r.basis === 'customer') ? ' (quote found)' : ' (from sources)'}`,
      count: rs.length,
    }))
    const win = ranked[0] && ranked[0][1].length > votes / 2 ? { n: ranked[0][1].length, runs: ranked[0][1] } : null
    // 2. then the BASIS: stated by the customer as soon as one agreeing run found a verified quote
    const rep = win ? (win.runs.find((r) => r.basis === 'customer') ?? win.runs.find((r) => r.basis === 'sources') ?? win.runs[0]) : runs[0]
    const voteInfo = { runs: runs.length, agree: win?.n ?? 0, outcomes }

    // numbered references from the representative run
    const refs: SourcePassage[] = []
    const keyToNum = new Map<string, number>()
    const addRef = (k: string) => {
      if (keyToNum.has(k)) return keyToNum.get(k)!
      const c = t.cards[Number(k.slice(1)) - 1]
      if (!c) return null
      refs.push({ docId: c.docId, docTitle: title(c.docId), page: c.page, quote: c.quote, cardId: c.id, claim: c.claim })
      keyToNum.set(k, refs.length)
      return refs.length
    }
    const reasoning = (rep?.reasoning ?? '')
      .replace(/\[(C\d+(?:\s*,\s*C\d+)*)\]/g, (_, ids: string) => {
        const nums = ids.split(/\s*,\s*/).map(addRef).filter((n): n is number => n !== null)
        return nums.length ? `[${nums.join(', ')}]` : ''
      })
      .replace(/\s+([,.;:)])/g, '$1')
      .replace(/\s{2,}/g, ' ')
      .trim()
    for (const k of rep?.cardKeys ?? []) addRef(k)
    verifiedSources += refs.length
    const used = new Set(refs.map((r) => r.cardId))
    const related = t.cards.filter((c) => !used.has(c.id)).map((c) => ({ docId: c.docId, docTitle: title(c.docId), page: c.page, quote: c.quote, cardId: c.id, claim: c.claim }))
    const base = { id: t.def.id, reasoning: reasoning || undefined, refs, related, check: rep?.check, votes: voteInfo }

    if (!win || !rep) {
      return {
        ...base,
        basis: 'missing' as const,
        value: null,
        missing: rep?.missing ?? t.def.clarification,
        rejected: runs.length
          ? `The ${runs.length} independent runs did not agree (${outcomes.map((o) => `${o.label} ×${o.count}`).join(', ')}) – this is a borderline case, please decide.`
          : 'The model did not answer for this step.',
      }
    }
    if (rep.basis === 'customer') return { ...base, basis: 'customer', value: rep.value, enquiryQuote: rep.quote }
    if (rep.basis === 'sources') return { ...base, basis: 'sources', value: rep.value, rejected: rep.rejected }
    return { ...base, basis: 'missing', value: null, missing: rep.missing ?? t.def.clarification }
  })

  // ------------------------------------------------------------ majority per fact and flag
  const okFacts = factRuns.filter((f): f is NonNullable<typeof f> => f !== null)
  for (const d of otherFacts) {
    const tally = new Map<string, { n: number; quote: string }>()
    for (const run of okFacts) {
      const f = (run.facts ?? []).find((x) => x?.id === d.id)
      const v = f?.value && f.value in d.labels && f.value !== d.unknownLabel ? f.value : null
      if (!v) continue
      if (!inEnquiry(f?.enquiry_quote)) {
        rejectedQuotes++
        continue
      }
      const c = tally.get(v)
      if (c) c.n++
      else tally.set(v, { n: 1, quote: f!.enquiry_quote! })
    }
    const best = [...tally.entries()].sort((a, b) => b[1].n - a[1].n)[0]
    if (best && best[1].n > votes / 2) decisions.push({ id: d.id, basis: 'customer', value: best[0], enquiryQuote: best[1].quote, votes: { runs: okFacts.length, agree: best[1].n, outcomes: [] } })
    else decisions.push({ id: d.id, basis: 'missing', value: null })
  }
  for (const d of flags) {
    const hits = okFacts.map((run) => (run.flags ?? []).find((x) => x?.id === d.id)).filter((f) => f && inEnquiry(f.enquiry_quote))
    if (hits.length > votes / 2) decisions.push({ id: d.id, basis: 'customer', value: 'yes', enquiryQuote: hits[0]!.enquiry_quote })
  }

  deriveSteps(decisions)
  const steps = decisions.filter((x) => TREE_IDS.has(x.id))
  const result: TreeResponse = {
    model: AGENT_MODELS[key].name,
    decisions,
    latencyMs: Date.now() - started,
    passagesRead: allCards.length,
    usage,
    pipeline: 'steps',
    sources,
    calls,
    docsRead: sets.map((s) => ({ docId: s.docId, title: title(s.docId), pages: s.pagesRead, cards: s.cards.length })),
    docsUnread: docs.filter((d) => !sets.some((s) => s.docId === d.id)).map((d) => d.id),
    seedAccepted: seedAccepted(),
    premises: premisesFor(decisions),
    stats: {
      decided: steps.filter((x) => x.basis === 'customer').length,
      suggested: steps.filter((x) => x.basis === 'sources').length,
      open: steps.filter((x) => x.basis === 'missing').length,
      rejectedQuotes,
      verifiedSources,
    },
  }
  // only complete results are cached (a failed call would otherwise be frozen in)
  const complete = stepRuns.every((runs) => runs.every((r) => r !== null)) && factRuns.every((f) => f !== null)
  if (complete && !benchmark) await kv.put(cacheKey, JSON.stringify(result), { expirationTtl: 60 * 60 * 24 * 30 })
  return result
}
