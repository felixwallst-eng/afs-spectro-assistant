import type { AgentModelKey } from './agent.ts'

// Decision tree: each node is one decision dimension from the AFS method table.
// The model must back every decision with a verbatim quote from the enquiry;
// without such evidence the node is left open ("action needed") for the expert.

/** Tree levels, top to bottom. Each maps to a column of the method table (S01 Table 1). */
export const TREE_NODES: { id: string; column: string }[] = [
  { id: 'sample_state', column: 'Sample type' },
  { id: 'interface_mode', column: 'Measurement technique' },
  { id: 'target_property_type', column: 'Physical phenomenon / selectivity' },
  { id: 'optical_variability', column: 'Optical path / depth' },
  { id: 'concentration_level', column: 'Sensitivity' },
  { id: 'budget', column: 'Cost' },
]

export interface TreeRequest {
  text: string
  model?: AgentModelKey
}

/** Which documents an assessment may use: only the supplied AFS originals, or also uploaded sources. */
export type SourceMode = 'original' | 'all'

export interface StepsRequest {
  text: string
  model?: AgentModelKey
  sources?: SourceMode
  /** Ignore a cached result and run the models again. */
  fresh?: boolean
  /** Independent runs per step (majority vote). Default 3. */
  votes?: number
}

/** A verbatim passage from an AFS document, verified against the indexed page text. */
export interface SourcePassage {
  docId: string
  docTitle: string
  page: number
  /** Text to highlight in the viewer (a key sentence, or the whole retrieved passage). */
  quote: string
  /** Knowledge card the reference comes from, and its statement. */
  cardId?: string
  claim?: string
}

/** Where a step's value comes from. */
export type DecisionBasis = 'customer' | 'sources' | 'missing'

export interface Decision {
  id: string
  /**
   * customer: stated in the enquiry (verified quote) – applied automatically.
   * sources: not stated, but the AFS passages point to a value – a suggestion the expert accepts.
   * missing: neither the enquiry nor the passages decide it.
   */
  basis: DecisionBasis
  /** Stated value (customer) or suggested value (sources); null when missing. */
  value: string | null
  /** Verbatim passage from the customer enquiry that supports the value (verified). */
  enquiryQuote?: string
  /** Reasoning over the enquiry and the AFS passages. Contains markers [1], [2] … that refer to `refs`. */
  reasoning?: string
  /** Numbered AFS references used in the reasoning (verified). */
  refs?: SourcePassage[]
  /** Where the AFS sources contradict or qualify what the customer states. */
  check?: string
  /** For basis 'missing': the information that is needed. */
  missing?: string
  /** Further passages retrieved for this step but not used in the reasoning. */
  related?: SourcePassage[]
  /** Why a proposed value was not accepted, e.g. its quote is not in the enquiry. */
  rejected?: string
  /** Majority vote over independent runs: how many agreed with the result, and what each run said. */
  votes?: { runs: number; agree: number; outcomes: { label: string; count: number }[] }
}

export interface TreeResponse {
  model: string
  decisions: Decision[]
  latencyMs: number
  /** Number of knowledge passages the model read. */
  passagesRead: number
  usage: { inputTokens: number; outputTokens: number }
  stats: { decided: number; suggested: number; open: number; rejectedQuotes: number; verifiedSources: number }
  /** steps: one call per step with majority vote; single: one call for everything (earlier pipeline). */
  pipeline?: 'single' | 'steps'
  sources?: SourceMode
  /** Model calls made for this result. */
  calls?: number
  /** Set when the result comes from the cache (identical input already assessed). */
  cachedAt?: string
  /** Documents whose knowledge cards were used: every page of these was read when they were added. */
  docsRead?: { docId: string; title: string; pages: number; cards: number }[]
  /** Enabled documents that have not been read into cards yet. */
  docsUnread?: string[]
}
