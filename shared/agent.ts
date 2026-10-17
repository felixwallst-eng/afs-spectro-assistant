// Contract between the UI and the knowledge-base agent (RAG over the active documents).

export const AGENT_MODELS = {
  gptoss: { id: '@cf/openai/gpt-oss-120b', name: 'gpt-oss 120B', note: 'Open weights (Apache 2.0) · fast with low reasoning · Workers Free plan' },
  qwen: { id: '@cf/qwen/qwen3.8-27b', name: 'Qwen3.8 27B', note: 'Open weights · runs on a single server · slower (always reasons first)' },
  kimi: { id: '@cf/moonshotai/kimi-k2.6', name: 'Kimi K2.6', note: 'Open weights · reasoning switched off · needs the Workers Paid plan' },
} as const
export type AgentModelKey = keyof typeof AGENT_MODELS

export interface AgentRequest {
  text: string
  dimensionIds: string[]
  model?: AgentModelKey
}

export interface AgentSuggestion {
  dimensionId: string
  /** Suggested label, or null when the agent found nothing to go on. */
  value: string | null
  rationale: string
  /** Verbatim passage, only present when it was found in the cited document. */
  quote?: string
  docId?: string
  docTitle?: string
  page?: number
  /** 'verified' = quote found in the document; 'withheld' = the model cited something we could not find. */
  status: 'verified' | 'none' | 'withheld'
}

export interface AgentResponse {
  model: string
  selectedDocs: { id: string; title: string }[]
  pagesRead: { docId: string; page: number }[]
  suggestions: AgentSuggestion[]
  latencyMs: number
  usage: { inputTokens: number; outputTokens: number }
}

export interface BriefRequest {
  text: string
  model?: AgentModelKey
}

export interface Finding {
  statement: string
  quote: string
  docId: string
  docTitle: string
  page: number
}

export interface BriefResponse {
  model: string
  findings: Finding[]
  /** Findings dropped because their quote was not found in the cited document. */
  withheld: number
  pagesRead: { docId: string; page: number }[]
  latencyMs: number
  usage: { inputTokens: number; outputTokens: number }
}
