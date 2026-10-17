// Shared data contracts between worker (Clef classification), rule engine and UI.

export type DimStatus = 'confident' | 'uncertain' | 'unknown'
export type DimSource = 'clef' | 'llm' | 'expert'
export type Level = 'low' | 'average' | 'high'
export type MethodKey = 'ir' | 'nir' | 'raman' | 'uvvis' | 'fluorescence'

/** A pointer into the AFS material, e.g. { source: 'S01', page: 'p.17' }. */
export interface Citation {
  source: string
  page?: string
  quote?: string
}

export interface LabelDef {
  name: string // short display name
  description: string // sent to Clef as the option criterion
}

export interface DimensionDef {
  id: string
  group: 'case' | 'request' | 'conditions' | 'proposed' | 'reuse'
  kind: 'fact' | 'request' | 'flag'
  title: string
  question: string // typed question for Clef
  labels: Record<string, LabelDef>
  unknownLabel?: string
  priority: 1 | 2 | 3
  clarification?: string // question shown to the expert when the value is unknown
  sources?: Citation[]
}

/** Raw classifier output for one dimension. */
export interface RawDimension {
  id: string
  value: string
  confidence: number
  probabilities?: Record<string, number>
}

export interface ClassifyResponse {
  model: string
  dimensions: Record<string, RawDimension>
  latencyMs: number
  usage?: { input_tokens?: number; output_tokens?: number }
}

/** Dimension after thresholds and expert overrides are applied. */
export interface DimensionResult {
  id: string
  value: string // effective value used by the rule engine
  rawValue?: string // what the classifier said
  confidence: number | null
  probabilities?: Record<string, number>
  status: DimStatus
  source: DimSource
  rationale?: string
  citations?: Citation[]
}

export interface MethodSetup {
  id: string
  method: MethodKey
  technique: string
  phenomenon: string
  sampleTypes: string[]
  depthUm: [number, number] | null
  sensitivity: Level
  selectivity: Level
  cost: Level
  labOnly: boolean
  nonContact: boolean
  citation: Citation
}

export type ReasonEffect = 'exclude' | 'condition' | 'plus' | 'minus' | 'info'

export interface Reason {
  text: string
  effect: ReasonEffect
  citation?: Citation
}

export interface Candidate {
  setup: MethodSetup
  status: 'recommended' | 'conditional' | 'excluded'
  score: number
  reasons: Reason[]
}

export interface OpenQuestion {
  dimensionId: string
  text: string
  priority: 1 | 2 | 3
  impact: number // share of method setups whose status could change (0..1)
  kind: 'missing' | 'confirm'
}

export interface Warning {
  id: string
  text: string
  severity: 'block' | 'caution'
  citation?: Citation
}

export type DecisionStatus = 'provisional' | 'insufficient_information' | 'out_of_scope'

export interface Assessment {
  dimensions: Record<string, DimensionResult>
  questions: OpenQuestion[]
  candidates: Candidate[]
  warnings: Warning[]
  decisionStatus: DecisionStatus
  decisionReasons: string[]
  knowledgeVersion: string
}

export interface Settings {
  confidentAt: number // >= -> confident
  uncertainAt: number // >= -> uncertain, below -> unknown
}

export const DEFAULT_SETTINGS: Settings = { confidentAt: 0.65, uncertainAt: 0.3 }
