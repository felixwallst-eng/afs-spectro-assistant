import { DIMENSIONS, DIM_BY_ID } from './dimensions.ts'
import { assess, resolveDimensions } from './engine.ts'
import { BASE_METHODS } from './knowledge.ts'
import type { Decision } from './tree.ts'
import { DEFAULT_SETTINGS } from './types.ts'
import type { MethodSetup, RawDimension, Settings, Warning } from './types.ts'

/** Entries saved before suggestions existed have no basis: a value then means stated by the customer. */
export const basisOf = (d?: Decision) => d?.basis ?? (d?.value ? 'customer' : 'missing')

/** Model decisions -> raw dimensions for the rule engine. Only customer-stated values are applied;
 *  suggestions and conflicts count only once the expert decides them. */
export function rawFromDecisions(decisions: Decision[], withSuggestions = false): Record<string, RawDimension> {
  const out: Record<string, RawDimension> = {}
  for (const def of DIMENSIONS) {
    const d = decisions.find((x) => x.id === def.id)
    const basis = basisOf(d)
    const stated = basis === 'customer' || (withSuggestions && basis === 'sources') ? (d?.value ?? null) : null
    const value = def.kind === 'flag' ? (stated === 'yes' ? 'yes' : 'no') : (stated ?? def.unknownLabel ?? Object.keys(def.labels)[0])
    out[def.id] = { id: def.id, value, confidence: 1 }
  }
  return out
}

/** Premise check: the warnings of the rule engine for these decisions (same rules as the UI).
 *  Warnings come from the customer-stated facts. A blocking warning that disappears once the open
 *  suggestions are taken as well (e.g. a suggested "sample classification" task) is shown as a caution:
 *  it only holds if the expert rejects those suggestions. */
export function premisesFor(decisions: Decision[], settings: Settings = DEFAULT_SETTINGS, methods: MethodSetup[] = BASE_METHODS): Warning[] {
  const warn = (withSuggestions: boolean) => assess(resolveDimensions(rawFromDecisions(decisions, withSuggestions), {}, settings), methods).warnings
  const likely = new Set(warn(true).map((w) => w.id))
  return warn(false).map((w) =>
    w.severity !== 'block' || likely.has(w.id) ? w : { ...w, severity: 'caution' as const, text: `${w.text} This may not apply if the suggested values are confirmed.` },
  )
}

export const isBlocking = (id: string) => (DIM_BY_ID[id]?.priority ?? 3) <= 2
