// Written assessment: the results of the decision path (Clef, rules, expert decisions) turned into a
// report in the structure of the AFS worked examples. A language model only writes the text; every fact,
// method and reference comes from the input, and the same input always returns the stored report.

export interface ReportEvidence {
  id: string // E1, E2 …
  source: string // S01
  page: string // 'p.17' or 'Table 1 (p.6)'
  text: string // what the passage supports
  quote?: string // verified sentence, highlighted in the viewer
}

export interface ReportInput {
  enquiry: string
  decisionStatus: string
  decisionReasons: string[]
  steps: { title: string; value: string | null; how: 'customer' | 'expert' | 'suggested' | 'conflict' | 'open'; customerQuote?: string; evidence: string[]; expertNote?: string; question?: string }[]
  facts: { title: string; value: string }[]
  premises: { severity: string; text: string; evidence: string[] }[]
  methods: { rank?: number; status: string; name: string; technique: string; range: string; pros: string[]; cons: string[]; evidence: string[]; canChange: string[] }[]
  /** Decision steps nobody has decided yet – everything in the report depends on their answers. */
  openSteps: { title: string; question: string }[]
  evidence: ReportEvidence[]
}

export interface ReportOutput {
  decisionStatus: string
  requirementsStated: string[]
  keyUnknowns: string[]
  clarificationQuestions: string[]
  recommendation: { method: string; text: string }[]
  measurementConcept: string
  spectralRange: string
  risks: string[]
  feasibilityPlan: string[]
  decisionBasis: string
}

export interface ReportResponse {
  report: ReportOutput
  evidence: ReportEvidence[]
  model: string
  latencyMs: number
  cachedAt?: string
}

export const DECISION_STATUS_TEXT: Record<string, string> = {
  provisional: 'Provisional feasibility assessment',
  insufficient_information: 'Insufficient information',
  out_of_scope: 'Outside the supported scope',
}
