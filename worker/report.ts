import { AGENT_MODELS } from '../shared/agent.ts'
import type { AgentModelKey } from '../shared/agent.ts'
import type { ReportInput, ReportOutput, ReportResponse } from '../shared/report.ts'
import { DECISION_STATUS_TEXT } from '../shared/report.ts'
import { chat, parseJson } from './agent.ts'

type Runner = { run: (model: string, input: unknown) => Promise<unknown> }
const REPORT_VERSION = 'report-v3'

const SYSTEM = `You write the first technical assessment of a customer enquiry for Art Fiber Systems (AFS), a maker of fiber-optic probes for in-line spectroscopy. The reader is an AFS expert who reviews it and may forward it to the customer.

Everything is already decided. You receive the enquiry, the decided steps (with how each was decided), the premise check, the ranked methods with their pros and cons, and a numbered evidence list. Your job is only to write it up clearly.

Rules
- Use only facts from the input. Never invent concentrations, accuracies, detection limits, response times, fiber lengths, prices or results.
- Keep client facts, AFS evidence and assumptions apart. A step marked "suggested" or "open" is not a client fact.
- Cite evidence as [E3] or [E3, E5] right after the claim it supports. Only use ids from the evidence list. Do not cite the customer text.
- Recommend only the methods given, in the given order. Methods with status "conditional" may be named only with their condition.
- The reason for a method must come from its listed pros, cons and conditions. Do not add technical claims of your own (no new applications, analytes, geometries or performance), and never stretch a source beyond what its evidence line says.
- List items are plain sentences: no numbering, no bullet characters.
- A published application is a reason to test a method, never proof it will work for this customer.
- Premises marked "block" must appear as risks or in the decision basis, in plain words.
- If decision steps are still open, the assessment is provisional: say so in the decision status, put their questions first in the clarification questions, and phrase every recommendation as "worth testing if …", never as final. Where a method can still drop out or become conditional, name that answer in its text.
- Short, precise sentences. British or American English is fine, but be consistent. No marketing language.

Answer with JSON only:
{
  "decisionStatus": "one short sentence that starts with the given status",
  "requirementsStated": ["facts the client stated, one per item"],
  "keyUnknowns": ["what is not known yet and matters"],
  "clarificationQuestions": ["prioritised questions, the ones that could change the method first"],
  "recommendation": [{ "method": "method – technique", "text": "1–2 sentences: why it is worth testing and under which condition, with citations" }],
  "measurementConcept": "probe and geometry, location, fiber link – 1–3 sentences with citations",
  "spectralRange": "the relevant nominal range(s) in correct units and what still has to be checked – 1–2 sentences",
  "risks": ["what could make the recommendation wrong"],
  "feasibilityPlan": ["3–5 numbered steps of a first experiment with independent reference measurements"],
  "decisionBasis": "how the go / no-go decision will be made; acceptance targets come from the client"
}`

async function sha(text: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const str = (x: unknown) => (typeof x === 'string' ? x.trim() : '')
// list items without leading numbering or bullets (the page numbers them itself)
const list = (x: unknown) => (Array.isArray(x) ? x.map(str).map((s) => s.replace(/^(?:\d+[.)]|[-•*])\s+/, '')).filter(Boolean) : [])

export async function runReport(aiBinding: unknown, kv: KVNamespace, input: ReportInput, key: AgentModelKey = 'gptoss'): Promise<ReportResponse> {
  const started = Date.now()
  const cacheKey = `report:${REPORT_VERSION}:${key}:${await sha(JSON.stringify(input))}`
  const hit = await kv.get<ReportResponse>(cacheKey, 'json')
  if (hit) return { ...hit, latencyMs: Date.now() - started }

  const status = DECISION_STATUS_TEXT[input.decisionStatus] ?? input.decisionStatus
  const user = `Decision status: ${status}${input.decisionReasons.length ? ` (${input.decisionReasons.join(' ')})` : ''}

Customer enquiry:
"""${input.enquiry}"""

Decision steps:
${input.steps
  .map(
    (s) =>
      `- ${s.title}: ${s.value ?? 'not known'} [${s.how}]${s.customerQuote ? ` – customer wrote: "${s.customerQuote}"` : ''}${s.evidence.length ? ` – evidence ${s.evidence.join(', ')}` : ''}${s.expertNote ? ` – expert note: ${s.expertNote}` : ''}${s.question ? ` – open question: ${s.question}` : ''}`,
  )
  .join('\n')}

Other facts the client stated:
${input.facts.length ? input.facts.map((f) => `- ${f.title}: ${f.value}`).join('\n') : '- none'}

Premise check:
${input.premises.length ? input.premises.map((p) => `- [${p.severity}] ${p.text}${p.evidence.length ? ` (${p.evidence.join(', ')})` : ''}`).join('\n') : '- nothing to flag'}

Open decision steps (${input.openSteps.length}):
${input.openSteps.length ? input.openSteps.map((o) => `- ${o.title}: ${o.question}`).join('\n') : '- none – every step is decided'}

Methods (ranked):
${input.methods
  .map(
    (m) =>
      `- ${m.rank ? `#${m.rank} ` : ''}${m.name} – ${m.technique} [${m.status}], nominal range ${m.range}${m.evidence.length ? `, evidence ${m.evidence.join(', ')}` : ''}\n  pros: ${m.pros.join('; ') || 'none'}\n  cons and conditions: ${m.cons.join('; ') || 'none'}${m.canChange.length ? `\n  can still change with the open answers: ${m.canChange.join('; ')}` : ''}`,
  )
  .join('\n')}

Evidence list:
${input.evidence.map((e) => `${e.id}: ${e.source} ${e.page} – ${e.text}`).join('\n')}`

  const model = AGENT_MODELS[key]
  const { text } = await chat(aiBinding as Runner, model.id, key, SYSTEM, user, 4000)
  const raw = parseJson<Record<string, unknown>>(text)
  if (!raw) throw new Error('The language model returned no readable report. Try again.')

  // references the model made up are removed, everything else is kept as written
  const ids = new Set(input.evidence.map((e) => e.id))
  const clean = (s: string) =>
    s
      .replace(/\[(E\d+(?:\s*,\s*E\d+)*)\]/g, (_, g: string) => {
        const ok = g.split(/\s*,\s*/).filter((x) => ids.has(x))
        return ok.length ? `[${ok.join(', ')}]` : ''
      })
      .replace(/\s+([.,;])/g, '$1')
  const rec = Array.isArray(raw.recommendation) ? raw.recommendation : []
  const report: ReportOutput = {
    decisionStatus: clean(str(raw.decisionStatus)) || status,
    requirementsStated: list(raw.requirementsStated).map(clean),
    keyUnknowns: list(raw.keyUnknowns).map(clean),
    clarificationQuestions: list(raw.clarificationQuestions).map(clean),
    recommendation: rec
      .map((r) => {
        const o = (r ?? {}) as Record<string, unknown>
        return { method: str(o.method), text: clean(str(o.text)) }
      })
      .filter((r) => r.method || r.text),
    measurementConcept: clean(str(raw.measurementConcept)),
    spectralRange: clean(str(raw.spectralRange)),
    risks: list(raw.risks).map(clean),
    feasibilityPlan: list(raw.feasibilityPlan).map(clean),
    decisionBasis: clean(str(raw.decisionBasis)),
  }
  const res: ReportResponse = { report, evidence: input.evidence, model: model.name, latencyMs: Date.now() - started, cachedAt: new Date().toISOString() }
  await kv.put(cacheKey, JSON.stringify(res), { expirationTtl: 60 * 60 * 24 * 90 })
  return { ...res, cachedAt: undefined }
}
