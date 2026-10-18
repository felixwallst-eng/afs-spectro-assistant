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

export const CLEF_PIPELINE_VERSION = 'clef-v6'
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

export async function runClefSteps(aiBinding: unknown, kv: KVNamespace, req: StepsRequest, ws = ''): Promise<TreeResponse> {
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
  // knowledge as this browser's workspace sees it; without a workspace: the curated, shared state
  const docs = (await listDocs(kv, ws)).filter((d) => d.enabled && (sources === 'all' || d.origin === 'original'))
  const sets = await loadCards(kv, docs.map((d) => d.id), ws)
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

  if ((req.citations ?? 'support') === 'support') {
    const better = await citeAndExplain(
      decisions,
      req.text,
      treeDefs,
      cardsOf,
      relevantByStep,
      toRef,
      run,
    )
    better.forEach((d, i) => (decisions[i] = d))
  }

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

// ---------------------------------------------------------------- references and reasoning (Clef only)
//   C  Clef picks the sentence of the enquiry that states the value (the sentences are the answer options).
//   A  For every step with a value, Clef rates each knowledge card of that step against the decided value
//      for this customer: supports · adds a limit or warning · background only · about something else.
//      Only supporting and cautioning cards are shown as references; the rest stays under "other passages".
//   D  The reasoning is assembled from fixed sentences around the quote and the strongest card.

const SUPPORT_AT = 0.5
const QUOTE_AT = 0.4
const MAX_SUPPORT = 3
const MAX_CAUTION = 2

export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9“"(])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 3)
    .slice(0, 30)
}

const lower1 = (s: string) => s.charAt(0).toLowerCase() + s.slice(1)
const noDot = (s: string) => s.replace(/[.\s]+$/, '')

async function citeAndExplain(
  decisions: Decision[],
  text: string,
  defs: DimensionDef[],
  cardsOf: (stepId: string) => KnowledgeCard[],
  relevantByStep: Map<string, KnowledgeCard[]>,
  toRef: (c: KnowledgeCard) => SourcePassage,
  run: (state: string, questions: Record<string, unknown>) => Promise<Record<string, Answer>>,
): Promise<Decision[]> {
  const name = (d: DimensionDef, v?: string | null) => (v ? (d.labels[v]?.name ?? v) : '')
  const shown = (d: Decision) => (d.basis === 'conflict' ? (d.alternative ?? d.value) : d.value)
  const sentences = splitSentences(text)

  // C: where the customer says it
  const quoteQs: Record<string, unknown> = {}
  defs.forEach((def, i) => {
    const d = decisions[i]
    if (!d.value || !sentences.length) return
    quoteQs[def.id] = {
      type: 'choice',
      instructions: `Which sentence of the customer text states or plainly implies: ${def.title} = “${name(def, d.value)}”?`,
      criteria: { ...Object.fromEntries(sentences.map((s, k) => [`s${k}`, s])), none: 'No sentence states or implies this.' },
    }
  })

  // A: which cards support the decided value for this customer
  const supportCall = (def: DimensionDef, value: string) => {
    const cards = cardsOf(def.id)
    if (!cards.length) return Promise.resolve({} as Record<string, Answer>)
    const decision = `${def.title} = “${name(def, value)}”`
    return run(
      `${text}\n\nDecision for this customer: ${decision}.`,
      Object.fromEntries(
        cards.map((c) => [
          c.id,
          {
            type: 'choice',
            instructions: `How does this statement from the AFS literature relate to the decision ${decision} for this customer? Statement: ${c.claim} Source sentence: "${c.quote}"`,
            criteria: {
              supports: `It directly supports ${name(def, value)} for this kind of sample, process or measurement task.`,
              caution: 'It applies to this case and adds a limit, condition or warning to this choice.',
              background: 'It is general background on the topic but does not decide this point for this customer.',
              unrelated: 'It is about a different kind of sample, process or task.',
            },
          },
        ]),
      ),
    )
  }

  const [quotes, ...ratings] = await Promise.all([
    Object.keys(quoteQs).length ? run(text, quoteQs) : Promise.resolve({} as Record<string, Answer>),
    ...defs.map((def, i) => {
      const v = shown(decisions[i])
      return v ? supportCall(def, v) : Promise.resolve({} as Record<string, Answer>)
    }),
  ])

  return defs.map((def, i) => {
    const d = decisions[i]
    const v = shown(d)
    const cards = cardsOf(def.id)
    const relevant = relevantByStep.get(def.id) ?? []
    const rating = ratings[i]
    const prob = (c: KnowledgeCard, role: string) => {
      const a = rating[c.id]
      return a?.choice === role ? (a.probabilities?.[role] ?? a.confidence ?? 0) : 0
    }
    // a card that names another value cannot support this one
    const supports = cards
      .filter((c) => (!c.value || c.value === v) && prob(c, 'supports') >= SUPPORT_AT)
      .sort((x, y) => prob(y, 'supports') - prob(x, 'supports'))
      .slice(0, MAX_SUPPORT)
    const cautions = cards
      .filter((c) => !supports.includes(c) && prob(c, 'caution') >= SUPPORT_AT)
      .sort((x, y) => prob(y, 'caution') - prob(x, 'caution'))
      .slice(0, MAX_CAUTION)
    const refs = [...supports.map((c) => ({ ...toRef(c), role: 'supports' as const })), ...cautions.map((c) => ({ ...toRef(c), role: 'caution' as const }))]
    const used = new Set(refs.map((r) => r.cardId))
    const rest = cards.filter((c) => !used.has(c.id))
    const related = [...rest.filter((c) => relevant.includes(c)), ...rest.filter((c) => !relevant.includes(c))].map(toRef)

    const q = quotes[def.id]
    const qPick = q?.choice && q.choice !== 'none' && (q.confidence ?? q.probabilities?.[q.choice] ?? 0) >= QUOTE_AT ? sentences[Number(q.choice.slice(1))] : undefined
    const sup = refs.filter((r) => r.role === 'supports').map((_, k) => k + 1)
    const cau = refs.map((r, k) => (r.role === 'caution' ? k + 1 : 0)).filter(Boolean)
    const mark = (ns: number[]) => (ns.length ? ` [${ns.join(', ')}]` : '')
    const firstClaim = supports[0] ? noDot(supports[0].claim) : ''
    const cautionNote = cautions[0] ? ` Note${mark(cau)}: ${lower1(noDot(cautions[0].claim))}.` : ''
    // [E] becomes a chip that opens the enquiry with this passage highlighted
    const quoted = qPick ? `“${noDot(qPick)}” [E]` : ''

    let reasoning: string
    if (d.basis === 'customer' && d.value) {
      reasoning = qPick
        ? `The customer writes ${quoted} – that is ${name(def, d.value)}.`
        : `Read from the customer text as ${name(def, d.value)}.`
      if (sup.length) reasoning += ` The AFS material agrees${mark(sup)}: ${lower1(firstClaim)}.`
      reasoning += cautionNote
    } else if (d.basis === 'conflict' && d.value && d.alternative) {
      reasoning = `The customer text points to ${name(def, d.value)}${qPick ? ` (${quoted})` : ''}, but for a case like this the AFS material points to ${name(def, d.alternative)}${mark(sup)}${firstClaim ? `: ${lower1(firstClaim)}` : ''}. Check which applies before deciding.`
    } else if (d.basis === 'sources' && d.value) {
      reasoning = qPick
        ? `Not stated outright. The closest passage is ${quoted}, which suggests ${name(def, d.value)}.`
        : `The customer does not state this. The most likely value is ${name(def, d.value)}.`
      if (sup.length) reasoning += ` This matches the AFS material${mark(sup)}: ${lower1(firstClaim)}.`
      reasoning += `${cautionNote} Please confirm.`
    } else {
      reasoning = `Neither the enquiry nor the AFS material decides this. Ask the customer: ${def.clarification ?? def.question}`
    }
    return { ...d, refs, related, reasoning, ...(qPick ? { enquiryQuote: qPick } : {}) }
  })
}

