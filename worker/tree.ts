import { AGENT_MODELS } from '../shared/agent.ts'
import type { AgentModelKey } from '../shared/agent.ts'
import { DIMENSIONS, DIM_BY_ID } from '../shared/dimensions.ts'
import { fold } from '../shared/text.ts'
import { TREE_NODES } from '../shared/tree.ts'
import type { Decision, SourcePassage, TreeRequest, TreeResponse } from '../shared/tree.ts'
import { chat, parseJson } from './agent.ts'
import { premisesFor } from '../shared/treeLogic.ts'
import { listDocs } from './docs.ts'

// One model call fills every decision. Before the call, code retrieves the most relevant
// knowledge-base passages for each tree step; the model decides from the enquiry (primary)
// and those passages (secondary). After the call, code enforces the evidence rule:
//  - a value is accepted only if its enquiry quote really occurs in the enquiry
//  - an AFS quote is shown only if it really occurs on the cited page
// Steps without accepted enquiry evidence stay open for the expert ("action needed").

const TREE_IDS = new Set(TREE_NODES.map((n) => n.id))
const MIN_QUOTE = 8 // folded characters – rejects one-word "evidence"
const PER_NODE = 4 // passages retrieved per tree step

interface Passage {
  key: string
  docId: string
  page: number
  text: string
}

const STOP = new Set(
  'the and for with that this from have will are our was were can not but all any into more than also such which when what need want should could would about there their they them been being only other some most very each first used using sample samples measurement measured process'.split(' '),
)
const stem = (w: string) => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)
const terms = (s: string) => s.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g)?.map(stem).filter((w) => !STOP.has(w)) ?? []

/** Split page texts into passages of about two sentences (verbatim, so they can be highlighted). */
function toPassages(docId: string, pages: string[]): Passage[] {
  const out: Passage[] = []
  pages.forEach((raw, i) => {
    const sentences = raw.replace(/\s+/g, ' ').split(/(?<=[.!?:])\s+(?=[A-Z(“"•–-])/).filter((x) => x.trim())
    for (let k = 0; k < sentences.length; k += 2) {
      const text = sentences.slice(k, k + 2).join(' ').trim()
      if (text.length >= 60) out.push({ key: '', docId, page: i + 1, text: text.slice(0, 480) })
    }
  })
  return out
}

/** BM25 score of every passage for a weighted query (length-normalised, so long passages do not dominate). */
function scorer(passages: Passage[]) {
  const tf = passages.map((p) => {
    const m = new Map<string, number>()
    for (const w of terms(p.text)) m.set(w, (m.get(w) ?? 0) + 1)
    return m
  })
  const len = tf.map((m) => [...m.values()].reduce((a, b) => a + b, 0))
  const avg = len.reduce((a, b) => a + b, 0) / Math.max(1, len.length)
  const df = new Map<string, number>()
  tf.forEach((m) => m.forEach((_, w) => df.set(w, (df.get(w) ?? 0) + 1)))
  const N = passages.length
  return (query: Map<string, number>) =>
    passages
      .map((p, i) => {
        let s = 0
        query.forEach((wq, w) => {
          const n = tf[i].get(w)
          if (!n) return
          const idf = Math.log(1 + (N - (df.get(w) ?? 0) + 0.5) / ((df.get(w) ?? 0) + 0.5))
          s += wq * idf * ((n * 2.2) / (n + 1.2 * (0.25 + 0.75 * (len[i] / avg))))
        })
        return { p, s }
      })
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
}

const weigh = (parts: [string, number][]) => {
  const q = new Map<string, number>()
  for (const [text, w] of parts) for (const t of new Set(terms(text))) q.set(t, Math.max(q.get(t) ?? 0, w))
  return q
}

export async function runTree(aiBinding: unknown, kv: KVNamespace, req: TreeRequest): Promise<TreeResponse> {
  const started = Date.now()
  const ai = aiBinding as Parameters<typeof chat>[0]
  const key: AgentModelKey = req.model && req.model in AGENT_MODELS ? req.model : 'gptoss'

  // 1. Knowledge base: retrieve passages per tree step ------------------------------------------
  const docs = (await listDocs(kv)).filter((d) => d.enabled && d.indexed)
  const texts = new Map<string, string[]>()
  for (const d of docs) texts.set(d.id, (await kv.get<string[]>(`text:${d.id}`, 'json')) ?? [])
  const all = docs.flatMap((d) => toPassages(d.id, texts.get(d.id) ?? []))
  const score = scorer(all)
  const perNode = new Map<string, Passage[]>()
  const used: Passage[] = []
  for (const n of TREE_NODES) {
    const def = DIM_BY_ID[n.id]
    const labels = Object.entries(def.labels).filter(([k]) => k !== def.unknownLabel)
    // what this step is about (high weight) + what the customer wrote (lower weight)
    const q = weigh([
      [labels.map(([, l]) => l.description).join(' '), 0.6],
      [req.text, 1.4],
      [`${def.title} ${n.column} ${labels.map(([, l]) => l.name).join(' ')}`, 1.6],
    ])
    // passages already shown for an earlier step count less, so every step gets its own evidence
    const ranked = score(q)
      .map((x) => ({ ...x, s: x.p.key ? x.s * 0.55 : x.s }))
      .sort((a, b) => b.s - a.s)
    const picked: Passage[] = []
    for (const x of ranked) {
      if (picked.length >= PER_NODE) break
      if (picked.filter((p) => p.docId === x.p.docId && p.page === x.p.page).length < 2) picked.push(x.p)
    }
    for (const p of picked) {
      if (p.key) continue
      p.key = `P${used.length + 1}`
      used.push(p)
    }
    perNode.set(n.id, picked)
  }
  const title = (id: string) => docs.find((d) => d.id === id)?.title ?? id
  const notes = docs.filter((d) => d.notes).map((d) => `[${d.id}] ${d.notes}`).join('\n')

  // 2. One model call ------------------------------------------------------------------------
  const facts = DIMENSIONS.filter((d) => d.kind !== 'flag')
  const flags = DIMENSIONS.filter((d) => d.kind === 'flag')
  const values = (d: (typeof facts)[number]) =>
    Object.entries(d.labels).filter(([k]) => k !== d.unknownLabel).map(([k, l]) => `${k} = ${l.description}`).join(' | ')
  const stepBlock = TREE_NODES.map((n) => {
    const d = DIM_BY_ID[n.id]
    return `- ${d.id}: ${d.question.split(' Only use')[0]}\n  values: ${values(d)}\n  passages for this step: ${(perNode.get(d.id) ?? []).map((p) => p.key).join(', ') || '(none)'}`
  }).join('\n')
  const factBlock = facts.filter((d) => !TREE_IDS.has(d.id)).map((d) => `- ${d.id}: ${d.question.split(' Only use')[0]}\n  values: ${values(d)}`).join('\n')
  const flagBlock = flags.map((d) => `- ${d.id}: ${d.labels.yes.description}`).join('\n')
  const passageBlock = used.map((p) => `<passage id="${p.key}" doc="${p.docId}" page="${p.page}">${p.text}</passage>`).join('\n')

  const res = await chat(
    ai,
    AGENT_MODELS[key].id,
    key,
    [
      'You prepare the first technical assessment of a customer enquiry for a spectroscopy expert at Art Fiber Systems (AFS).',
      'DECISION STEPS. For each step, read the enquiry first, then the AFS passages listed for the step, and decide in this order:',
      '1. basis "customer": the enquiry states it. Give "value" and "enquiry_quote" (a short passage copied character for character from the enquiry).',
      '2. basis "sources": the enquiry does not state it, but the AFS passages let you infer it for THIS case (e.g. AFS describes the customer\'s product type). Give the "value" you suggest. General statements that do not concern this case are not enough.',
      '3. basis "missing": neither decides it. value null, and "missing": one sentence naming the information you need from the customer.',
      'For every step write "reasoning" (2–4 sentences): what the customer wrote, what the AFS passages say and what that means for the method choice. Cite passages inline as [P12]. Basis "sources" must cite at least one passage.',
      'For each cited passage add {"passage": "P12", "quote": "the key sentence, copied exactly from that passage"} to "cite".',
      '"check": one sentence only if the AFS passages contradict, qualify or add a risk to what the customer states or assumes.',
      'OTHER FACTS: value only with an enquiry_quote, otherwise null. FLAGS: list only those the customer clearly mentions, each with its enquiry_quote.',
      'Answer only with JSON: {"steps": [{"id": "...", "basis": "customer|sources|missing", "value": "label or null", "enquiry_quote": "...", "reasoning": "...", "cite": [{"passage": "P1", "quote": "..."}], "check": "...", "missing": "..."}], "facts": [{"id": "...", "value": "label or null", "enquiry_quote": "..."}], "flags": [{"id": "...", "enquiry_quote": "..."}]}',
    ].join('\n'),
    `Customer enquiry:\n"""${req.text}"""\n\nDecision steps:\n${stepBlock}\n\nOther facts:\n${factBlock}\n\nFlags:\n${flagBlock}\n\nExpert notes on documents:\n${notes || '(none)'}\n\nAFS passages:\n${passageBlock || '(no documents indexed)'}`,
    4000,
  )

  // 3. Verify ------------------------------------------------------------------------------
  type RawStep = { id?: string; basis?: string; value?: string | null; enquiry_quote?: string; reasoning?: string; cite?: { passage?: string; quote?: string }[]; check?: string; missing?: string }
  type RawFact = { id?: string; value?: string | null; enquiry_quote?: string }
  const parsed = parseJson<{ steps?: RawStep[]; facts?: RawFact[]; flags?: { id?: string; enquiry_quote?: string }[] }>(res.text) ?? {}
  const enquiry = fold(req.text)
  const inEnquiry = (q?: string) => !!q && fold(q).length >= MIN_QUOTE && enquiry.includes(fold(q))
  let rejectedQuotes = 0
  let verifiedSources = 0
  const toRef = (p: Passage, quote?: string): SourcePassage => {
    // a key sentence is used for the highlight only if it really occurs in the passage
    const ok = quote && fold(quote).length >= 20 && fold(p.text).includes(fold(quote))
    if (quote && !ok) rejectedQuotes++
    return { docId: p.docId, docTitle: title(p.docId), page: p.page, quote: ok ? quote!.trim() : p.text }
  }

  const stepDecision = (d: (typeof facts)[number]): Decision => {
    const st = (parsed.steps ?? []).find((x) => x?.id === d.id)
    const label = st?.value && st.value in d.labels && st.value !== d.unknownLabel ? st.value : null
    // number the cited passages in order of first mention; unknown ids are dropped
    const refs: SourcePassage[] = []
    const keyToNum = new Map<string, number>()
    const reasoning = (st?.reasoning ?? '')
      .replace(/\[(P\d+(?:\s*,\s*P\d+)*)\]/g, (_, ids: string) => {
        const nums = ids.split(/\s*,\s*/).map((k) => {
          const p = used.find((x) => x.key === k)
          if (!p) return null
          if (!keyToNum.has(k)) {
            refs.push(toRef(p, st?.cite?.find((c) => c?.passage === k)?.quote))
            keyToNum.set(k, refs.length)
          }
          return keyToNum.get(k)
        })
        const ok = nums.filter((n) => n !== null)
        return ok.length ? `[${ok.join(', ')}]` : ''
      })
      .replace(/\s+([,.;:)])/g, '$1')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, 900)
    // passages listed in "cite" but not marked in the text are appended as references
    for (const c of st?.cite ?? []) {
      const p = used.find((x) => x.key === c?.passage)
      if (p && c?.passage && !keyToNum.has(c.passage)) {
        refs.push(toRef(p, c.quote))
        keyToNum.set(c.passage, refs.length)
      }
    }
    verifiedSources += refs.length
    const usedKeys = new Set(keyToNum.keys())
    const related = (perNode.get(d.id) ?? []).filter((p) => !usedKeys.has(p.key)).map((p) => toRefPlain(p))
    const base = { id: d.id, reasoning: reasoning || undefined, refs, related, check: st?.check?.slice(0, 300) || undefined }

    if (st?.basis === 'customer' && label) {
      if (inEnquiry(st.enquiry_quote)) return { ...base, basis: 'customer', value: label, enquiryQuote: st.enquiry_quote }
      rejectedQuotes++
      // the claim is not backed by the enquiry; keep it only as a suggestion if sources back it
      if (refs.length) return { ...base, basis: 'sources', value: label, rejected: `The model said the customer states “${d.labels[label].name}”, but its quote is not in the enquiry – shown as a suggestion.` }
      return { ...base, basis: 'missing', value: null, missing: d.clarification, rejected: `The model proposed “${d.labels[label].name}” but its quote is not in the enquiry.` }
    }
    if (st?.basis === 'sources' && label) {
      if (refs.length) return { ...base, basis: 'sources', value: label }
      return { ...base, basis: 'missing', value: null, missing: st.missing || d.clarification, rejected: `The model suggested “${d.labels[label].name}” without citing an AFS passage – not shown as a suggestion.` }
    }
    return { ...base, basis: 'missing', value: null, missing: st?.missing?.slice(0, 300) || d.clarification }
  }
  const toRefPlain = (p: Passage): SourcePassage => ({ docId: p.docId, docTitle: title(p.docId), page: p.page, quote: p.text })

  const decisions: Decision[] = facts.map((d) => {
    if (TREE_IDS.has(d.id)) return stepDecision(d)
    const f = (parsed.facts ?? []).find((x) => x?.id === d.id) ?? (parsed.steps ?? []).find((x) => x?.id === d.id)
    const proposed = f?.value && f.value in d.labels && f.value !== d.unknownLabel ? f.value : null
    if (!proposed) return { id: d.id, basis: 'missing', value: null }
    if (!inEnquiry(f?.enquiry_quote)) {
      rejectedQuotes++
      return { id: d.id, basis: 'missing', value: null, rejected: `The model proposed “${d.labels[proposed].name}” but its quote is not in the enquiry.` }
    }
    return { id: d.id, basis: 'customer', value: proposed, enquiryQuote: f!.enquiry_quote }
  })
  for (const fl of parsed.flags ?? []) {
    if (!fl?.id || !flags.some((d) => d.id === fl.id)) continue
    if (inEnquiry(fl.enquiry_quote)) decisions.push({ id: fl.id, basis: 'customer', value: 'yes', enquiryQuote: fl.enquiry_quote })
    else rejectedQuotes++
  }

  const steps = decisions.filter((x) => TREE_IDS.has(x.id))
  return {
    model: AGENT_MODELS[key].name,
    decisions,
    latencyMs: Date.now() - started,
    passagesRead: used.length,
    premises: premisesFor(decisions),
    usage: { inputTokens: res.usage.prompt_tokens ?? 0, outputTokens: res.usage.completion_tokens ?? 0 },
    stats: {
      decided: steps.filter((x) => x.basis === 'customer').length,
      suggested: steps.filter((x) => x.basis === 'sources').length,
      open: steps.filter((x) => x.basis === 'missing').length,
      rejectedQuotes,
      verifiedSources,
    },
  }
}
