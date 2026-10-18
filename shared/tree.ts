import type { Warning } from './types.ts'
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
]
// Cost is not a decision step: no enquiry states a budget, so it appears as a pro / con of each
// recommended setup instead (shared/engine.ts).

/** Steps the AFS sources can suggest a value for. Others (e.g. the concentration the customer needs)
 *  only the customer can state – there the model may cite knowledge, but never suggest a value. */
export const SOURCE_STEPS = new Set(['sample_state', 'interface_mode', 'target_property_type', 'optical_variability'])

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
  /** Benchmark only: offset for the seeds (vary it to test the model without seed help). */
  seedBase?: number
  /** Benchmark only: skip the call for the other facts and flags (they are not part of the tree). */
  stepsOnly?: boolean
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
export type DecisionBasis = 'customer' | 'sources' | 'missing' | 'conflict'

export interface Decision {
  id: string
  /**
   * customer: stated in the enquiry (verified quote) – applied automatically.
   * sources: not stated, but the AFS passages point to a value – a suggestion the expert accepts.
   * missing: neither the enquiry nor the passages decide it.
   * conflict: the enquiry states one value, the AFS sources point to another – the expert must check.
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
  /** For basis 'conflict': the value the AFS sources point to (value = what the customer text says). */
  alternative?: string
  /** Clef pipeline: the two classifications behind the decision (shown to the expert as text, not as numbers). */
  clef?: { text: { value: string; confidence: number }; withSources: { value: string; confidence: number }; relevantCards: number }
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
  pipeline?: 'single' | 'steps' | 'clef'
  sources?: SourceMode
  /** Model calls made for this result. */
  calls?: number
  /** Set when the result comes from the cache (identical input already assessed). */
  cachedAt?: string
  /** Documents whose knowledge cards were used: every page of these was read when they were added. */
  docsRead?: { docId: string; title: string; pages: number; cards: number }[]
  /** Enabled documents that have not been read into cards yet. */
  docsUnread?: string[]
  /** Whether the model accepted the fixed seed (false = only temperature 0). */
  seedAccepted?: boolean
  /** Premise check: customer assumptions that the AFS rules and sources contradict or qualify. */
  premises?: Warning[]
  /** Clef pipeline: raw classification of the facts behind the premise check (for evaluation). */
  premiseFacts?: Record<string, { value: string; confidence: number }>
}
