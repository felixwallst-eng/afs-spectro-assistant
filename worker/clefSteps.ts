import type { KnowledgeCard } from '../shared/cards.ts'
import { DIMENSIONS, DIM_BY_ID } from '../shared/dimensions.ts'
import { SOURCE_STEPS, TREE_NODES } from '../shared/tree.ts'
import type { Decision, SourcePassage, StepsRequest, TreeResponse } from '../shared/tree.ts'
import { deriveSteps, premisesFor } from '../shared/treeLogic.ts'
import { DEFAULT_SETTINGS } from '../shared/types.ts'
import type { DimensionDef } from '../shared/types.ts'
import { loadCards } from './cards.ts'
import { CLEF_MODEL } from './clef.ts'
import { listDocs } from './docs.ts'

// Clef pipeline – a classifier decides, so the same input gives the same decision.
//   A  Clef classifies each step from the customer text alone.
//   B  Clef marks which knowledge cards apply to this enquiry (relevant / not relevant).
//   C  Clef classifies each step again from the customer text plus the relevant cards.
//   Rules turn A and C into the decision:
//     A confident and C confident on another value  -> conflict, the expert must check
//     A confident                                    -> stated by the customer (C confirms or adds context)
//     C confident with relevant cards (source steps) -> suggestion from the AFS sources
//     A or C at least plausible                      -> most likely value, as a suggestion to confirm
//     otherwise                                      -> information missing
//   Other facts and flags are classified from the customer text; the rule engine turns them into the
//   premise check (customer assumptions that the AFS rules contradict).
// The evidence shown to the expert is the relevant cards (verified quotes) – no generated text.

export const CLEF_PIPELINE_VERSION = 'clef-v4'
const MAX_QUESTIONS = 60
const TREE_IDS = new Set(TREE_NODES.map((n) => n.id))
/** Steps that are never suggested from a tentative reading of the text – stated or open. */
const STATED_ONLY = new Set(['spectral_range'])

type Runner = { run: (model: string, input: unknown) => Promise<unknown> }
interface Answer {
  choice?: string
  probabilities?: Record<string, number>
  confidence?: number
}
interface Pick {
  value: string
  confidence: number
}

async function clef(ai: Runner, state: string, questions: Record<string, unknown>): Promise<Record<string, Answer>> {
  const entries = Object.entries(questions)
  const out: Record<string, Answer> = {}
  for (let i = 0; i < entries.length; i += MAX_QUESTIONS) {
    const res = (await ai.run(CLEF_MODEL, { model: 'clef', state, questions: Object.fromEntries(entries.slice(i, i + MAX_QUESTIONS)) })) as { answers?: Record<string, Answer> }
    Object.assign(out, res.answers ?? {})
  }
  return out
}

const pick = (a?: Answer): Pick | null => {
  if (!a?.choice) return null
  return { value: a.choice, confidence: typeof a.confidence === 'number' ? a.confidence : (a.probabilities?.[a.choice] ?? 0) }
}

const choiceQuestion = (d: DimensionDef, extra = '') => ({
  type: 'choice',
  instructions: d.question + extra,
  criteria: Object.fromEntries(Object.entries(d.labels).map(([k, l]) => [k, l.description])),
})

export async function runClefSteps(aiBinding: unknown, kv: KVNamespace, req: StepsRequest): Promise<TreeResponse> {
  const started = Date.now()
  const ai = aiBinding as Runner
  const sources = req.sources ?? 'all'
  // thresholds from the settings page; the defaults are the values the benchmark was measured with
  const t = req.thresholds
  const HI = t?.confidentAt ?? DEFAULT_SETTINGS.confidentAt
  const LO = t?.uncertainAt ?? DEFAULT_SETTINGS.uncertainAt
  const PREMISE_AT = t?.premiseAt ?? DEFAULT_SETTINGS.premiseAt ?? 0.5
  let calls = 0
  const run = async (state: string, questions: Record<string, unknown>) => {
    calls += Math.ceil(Object.keys(questions).length / MAX_QUESTIONS)
    return clef(ai, state, questions)
  }

  // ------------------------------------------------------------ knowledge
  const docs = (await listDocs(kv)).filter((d) => d.enabled && (sources === 'all' || d.origin === 'original'))
  const sets = await loadCards(kv, docs.map((d) => d.id))
  const title = (id: string) => docs.find((d) => d.id === id)?.title ?? id
  const cardsOf = (stepId: string) => sets.flatMap((s) => s.cards).filter((c) => c.step === stepId)
  const toRef = (c: KnowledgeCard): SourcePassage => ({ docId: c.docId, docTitle: title(c.docId), page: c.page, quote: c.quote, cardId: c.id, claim: c.claim })

  // ------------------------------------------------------------ A: customer text only (+ other facts and flags) · B: card relevance
  const treeDefs = TREE_NODES.map((n) => DIM_BY_ID[n.id])
  const otherDefs = DIMENSIONS.filter((d) => !TREE_IDS.has(d.id))
  const allCards = treeDefs.flatMap((d) => cardsOf(d.id))
  const relevanceQuestions = Object.fromEntries(
    allCards.map((c) => [
      c.id,
      {
        type: 'choice',
        instructions: `Does this statement from the AFS literature apply to the customer's case for the decision "${DIM_BY_ID[c.step].title}"? Statement: ${c.claim} Source sentence: "${c.quote}"`,
        criteria: {
          relevant: 'The statement concerns the kind of sample, process or measurement task the customer describes and helps decide this point.',
          not_relevant: 'The statement concerns a different kind of sample, process or task, or does not help decide this point for this customer.',
        },
      },
    ]),
  )
  const [textAnswers, relevance] = await Promise.all([
    run(req.text, Object.fromEntries([...treeDefs, ...otherDefs].map((d) => [d.id, choiceQuestion(d)]))),
    allCards.length ? run(req.text, relevanceQuestions) : Promise.resolve({} as Record<string, Answer>),
  ])
  const isRelevant = (c: KnowledgeCard) => {
    const p = pick(relevance[c.id])
    return !!p && p.value === 'relevant' && p.confidence >= 0.5
  }

  // ------------------------------------------------------------ C: customer text + relevant cards, one call per step
  const relevantByStep = new Map(treeDefs.map((d) => [d.id, cardsOf(d.id).filter(isRelevant)]))
  const withSources = await Promise.all(
    treeDefs.map(async (d) => {
      const rel = relevantByStep.get(d.id) ?? []
      if (!rel.length) return null
      const state = `${req.text}\n\nAFS knowledge that applies to this case:\n${rel.map((c) => `- ${c.claim} (“${c.quote}”)`).join('\n')}`
      const ans = await run(state, { [d.id]: choiceQuestion(d, ' Use what the customer wrote first, and the AFS knowledge to judge what this kind of sample or process usually is.') })
      return pick(ans[d.id])
    }),
  )

  // ------------------------------------------------------------ rules
  const real = (d: DimensionDef, p: Pick | null) => !!p && p.value in d.labels && p.value !== d.unknownLabel
  const name = (d: DimensionDef, v: string) => d.labels[v]?.name ?? v
  const decisions: Decision[] = treeDefs.map((d, i) => {
    const A = pick(textAnswers[d.id])
    const C = withSources[i]
    const rel = relevantByStep.get(d.id) ?? []
    const all = cardsOf(d.id)
    const aReal = real(d, A)
    const cReal = real(d, C)
    const aSure = aReal && A!.confidence >= HI
    const cSure = cReal && C!.confidence >= HI
    // references: relevant cards, those that point to the chosen value first
    const MAX_REFS = 6
    const ordered = (value: string | null) => [...rel].sort((x, y) => Number(y.value === value) - Number(x.value === value) || x.id.localeCompare(y.id))
    const refsFor = (value: string | null) => ordered(value).slice(0, MAX_REFS).map(toRef)
    // everything not shown as a reference stays available under "other passages"
    const relatedFor = (value: string | null) => [...ordered(value).slice(MAX_REFS), ...all.filter((c) => !rel.includes(c))].map(toRef)
    const clefInfo = { text: { value: A?.value ?? '–', confidence: A?.confidence ?? 0 }, withSources: { value: C?.value ?? '–', confidence: C?.confidence ?? 0 }, relevantCards: rel.length }
    const markers = (refs: SourcePassage[], value: string | null) => {
      const nums = refs.map((r, k) => ({ r, k: k + 1 })).filter(({ r }) => all.find((c) => c.id === r.cardId)?.value === value).map(({ k }) => k)
      return nums.length ? ` [${nums.slice(0, 4).join(', ')}]` : rel.length ? ` [${Array.from({ length: Math.min(rel.length, 3) }, (_, k) => k + 1).join(', ')}]` : ''
    }
    const base = { id: d.id, clef: clefInfo }

    if (aSure && cSure && C!.value !== A!.value) {
      const refs = refsFor(C!.value)
      return {
        ...base,
        basis: 'conflict' as const,
        value: A!.value,
        alternative: C!.value,
        refs,
        related: relatedFor(C!.value),
        reasoning: `The customer text points to “${name(d, A!.value)}”, but with the applicable AFS knowledge the classification is “${name(d, C!.value)}”${markers(refs, C!.value)}. Check whether the customer's description is accurate.`,
      }
    }
    if (aSure) {
      const refs = refsFor(A!.value)
      const confirmed = cSure && C!.value === A!.value
      return {
        ...base,
        basis: 'customer' as const,
        value: A!.value,
        refs,
        related: relatedFor(A!.value),
        reasoning: `Classified from the customer text as “${name(d, A!.value)}”.${rel.length ? ` ${rel.length} AFS statement${rel.length > 1 ? 's apply' : ' applies'} to this case${confirmed ? ' and confirm it' : ''}${markers(refs, A!.value)}.` : ''}`,
      }
    }
    if (SOURCE_STEPS.has(d.id) && cSure && rel.length) {
      const refs = refsFor(C!.value)
      return {
        ...base,
        basis: 'sources' as const,
        value: C!.value,
        refs,
        related: relatedFor(C!.value),
        reasoning: `The customer text does not state this. With the applicable AFS knowledge the most likely value is “${name(d, C!.value)}”${markers(refs, C!.value)}.`,
      }
    }
    // a weak reading of the text is no basis for the spectral range: it changes which methods are excluded,
    // so it is only taken when stated (or derived from the stated fiber link)
    const candidates = [aReal && !STATED_ONLY.has(d.id) ? A : null, SOURCE_STEPS.has(d.id) && cReal ? C : null].filter((p): p is Pick => !!p && p.confidence >= LO)
    const best = candidates.sort((x, y) => y.confidence - x.confidence)[0]
    if (best) {
      const refs = refsFor(best.value)
      return {
        ...base,
        basis: 'sources' as const,
        value: best.value,
        refs,
        related: relatedFor(best.value),
        reasoning: `Not clearly stated. The most likely value is “${name(d, best.value)}”${refs.length ? markers(refs, best.value) : ''} – please confirm.`,
      }
    }
    return {
      ...base,
      basis: 'missing' as const,
      value: null,
      refs: refsFor(null),
      related: relatedFor(null),
      missing: d.clarification ?? d.question,
      reasoning: `Neither the customer text nor the AFS knowledge decides this point.${rel.length ? ` Background${markers(refsFor(null), null)}.` : ''}`,
    }
  })

  // other facts and flags feed the premise check. A premise warning only asks the expert to check
  // something, so a missed premise costs more than a false alarm: they count from PREMISE_AT on.
  const premiseFacts: Record<string, Pick> = {}
  for (const d of otherDefs) {
    const p = pick(textAnswers[d.id])
    if (p) premiseFacts[d.id] = p
    if (real(d, p) && p!.confidence >= PREMISE_AT) decisions.push({ id: d.id, basis: 'customer', value: p!.value })
    else decisions.push({ id: d.id, basis: 'missing', value: null })
  }

  deriveSteps(decisions)
  const steps = decisions.filter((x) => TREE_IDS.has(x.id))
  return {
    model: 'Cloudflare Clef (classifier)',
    decisions,
    latencyMs: Date.now() - started,
    passagesRead: allCards.length,
    usage: { inputTokens: 0, outputTokens: 0 },
    pipeline: 'clef',
    sources,
    calls,
    docsRead: sets.map((s) => ({ docId: s.docId, title: title(s.docId), pages: s.pagesRead, cards: s.cards.length })),
    docsUnread: docs.filter((d) => !sets.some((s) => s.docId === d.id)).map((d) => d.id),
    premises: premisesFor(decisions),
    premiseFacts,
    stats: {
      decided: steps.filter((x) => x.basis === 'customer').length,
      suggested: steps.filter((x) => x.basis === 'sources').length,
      open: steps.filter((x) => x.basis === 'missing' || x.basis === 'conflict').length,
      rejectedQuotes: 0,
      verifiedSources: steps.reduce((a, x) => a + (x.refs?.length ?? 0), 0),
    },
  }
}
