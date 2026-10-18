// Collects everything the written assessment may use from a decided path – shared by the app
// (src/components/Report.tsx) and the batch script that writes the H01–H06 answers (scripts/answers.mjs).
import { DIMENSIONS, DIM_BY_ID } from './dimensions.ts'
import { openRisks } from './engine.ts'
import type { OpenRisk } from './engine.ts'
import { METHOD_INFO } from './knowledge.ts'
import type { ReportEvidence, ReportInput } from './report.ts'
import { TREE_NODES } from './tree.ts'
import type { TreeResponse } from './tree.ts'
import { nodeStatus } from './treeLogic.ts'
import type { Assessment, Citation } from './types.ts'

export interface ReportSource {
  text: string
  tree: TreeResponse
  assessment: Assessment
  overrides: Record<string, string>
  notes: Record<string, string>
}

const MAX_RECOMMENDED = 5
const MAX_CONDITIONAL = 3

/** “Drops out if …” / “Becomes conditional if …” for the open steps. */
export function riskLines(risks: OpenRisk[]): string[] {
  const by = (status: OpenRisk['status']) => {
    const groups = new Map<string, string[]>()
    for (const r of risks.filter((x) => x.status === status)) groups.set(r.dimensionId, [...(groups.get(r.dimensionId) ?? []), DIM_BY_ID[r.dimensionId].labels[r.label].name])
    return [...groups].map(([id, labels]) => `${DIM_BY_ID[id].title} = ${labels.join(' or ')}`)
  }
  return [...by('excluded').map((t) => `Drops out if ${t}`), ...by('conditional').map((t) => `Becomes conditional if ${t}`)]
}

/** Everything the report may use, collected from the decided path. Evidence gets stable ids E1, E2 … */
export function buildReportInput(p: ReportSource): ReportInput {
  const evidence: ReportEvidence[] = []
  const cite = (source: string, page: string, textOf: string, quote?: string) => {
    const hit = evidence.find((e) => e.source === source && e.page === page && e.text === textOf)
    if (hit) return hit.id
    const id = `E${evidence.length + 1}`
    evidence.push({ id, source, page, text: textOf, ...(quote ? { quote } : {}) })
    return id
  }
  const citeC = (c: Citation | undefined, textOf: string) => (c ? cite(c.source, c.page ?? '', textOf, c.quote) : null)

  const steps: ReportInput['steps'] = TREE_NODES.map((n) => {
    const def = DIM_BY_ID[n.id]
    const d = p.tree.decisions.find((x) => x.id === n.id)
    const status = nodeStatus(n.id, p.tree.decisions, p.overrides)
    const v = p.assessment.dimensions[n.id]?.value
    const known = v && v !== def.unknownLabel
    const shownValue = status === 'suggested' || status === 'conflict' ? (d?.value ?? null) : known ? v : null
    const how: ReportInput['steps'][number]['how'] =
      status === 'decided' ? 'customer' : status === 'expert' ? 'expert' : status === 'suggested' ? 'suggested' : status === 'conflict' ? 'conflict' : 'open'
    return {
      title: def.title,
      value: shownValue ? (def.labels[shownValue]?.name ?? shownValue) : null,
      how,
      ...(d?.enquiryQuote && how !== 'open' ? { customerQuote: d.enquiryQuote } : {}),
      evidence: (d?.refs ?? []).map((r) => cite(r.docId, `p.${r.page}`, r.claim ?? r.quote, r.quote)),
      ...(p.notes[n.id]?.trim() ? { expertNote: p.notes[n.id].trim() } : {}),
      ...(how === 'open' || how === 'suggested' || how === 'conflict' ? { question: def.clarification ?? def.question } : {}),
    }
  })

  const openIds = TREE_NODES.filter((n) => {
    const st = nodeStatus(n.id, p.tree.decisions, p.overrides)
    const v = p.assessment.dimensions[n.id]?.value
    return !(st === 'decided' || st === 'expert') || !v || v === DIM_BY_ID[n.id].unknownLabel
  }).map((n) => n.id)
  // outside the supported scope (e.g. clinical use) the step questions do not apply – the premise check explains why
  const openSteps = p.assessment.decisionStatus === 'out_of_scope' ? [] : openIds.map((id) => ({ title: DIM_BY_ID[id].title, question: DIM_BY_ID[id].clarification ?? DIM_BY_ID[id].question }))
  const values = Object.fromEntries(Object.values(p.assessment.dimensions).map((d) => [d.id, d.value]))

  const treeIds = new Set(TREE_NODES.map((n) => n.id))
  const facts = DIMENSIONS.filter((def) => !treeIds.has(def.id))
    .map((def) => ({ def, r: p.assessment.dimensions[def.id] }))
    .filter(({ def, r }) => r && r.status !== 'unknown' && (def.kind === 'flag' ? r.value === 'yes' : r.value !== def.unknownLabel))
    .map(({ def, r }) => ({ title: def.title, value: def.kind === 'flag' ? 'yes' : (def.labels[r.value]?.name ?? r.value) }))

  const premises = p.assessment.warnings.map((w) => ({ severity: w.severity, text: w.text, evidence: [citeC(w.citation, w.text)].filter((x): x is string => !!x) }))

  const pick = [
    ...p.assessment.candidates.filter((c) => c.status === 'recommended').slice(0, MAX_RECOMMENDED),
    ...p.assessment.candidates.filter((c) => c.status === 'conditional').slice(0, MAX_CONDITIONAL),
  ]
  const methods = pick.map((c) => {
    const withRef = (r: { text: string; citation?: Citation }) => {
      const id = citeC(r.citation, r.text)
      return id ? `${r.text} [${id}]` : r.text
    }
    const row = citeC(c.setup.citation, `${METHOD_INFO[c.setup.method].name} – ${c.setup.technique}: ${c.setup.phenomenon}, samples ${c.setup.sampleTypes.join(', ')}`)
    return {
      rank: c.rank,
      status: c.status,
      name: METHOD_INFO[c.setup.method].name,
      technique: c.setup.technique,
      range: METHOD_INFO[c.setup.method].rangeText,
      pros: c.reasons.filter((r) => r.effect === 'plus').map(withRef),
      cons: c.reasons.filter((r) => r.effect === 'minus' || r.effect === 'condition').map(withRef),
      evidence: row ? [row] : [],
      canChange: openIds.length ? riskLines(openRisks(c.setup, values, openIds)) : [],
    }
  })

  return { enquiry: p.text, decisionStatus: p.assessment.decisionStatus, decisionReasons: p.assessment.decisionReasons, steps, facts, premises, methods, evidence, openSteps }
}

