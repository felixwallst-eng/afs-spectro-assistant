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

/** Steps the rules derive from other stated facts. The usable spectral range follows from the fiber
 *  link the customer wants to reuse (S02 p.6): a silica link carries UV/Vis/NIR only, an IR fiber
 *  also mid-IR. A derived value counts as stated; if the classifier read a different value from the
 *  text, the step becomes a conflict for the expert. */
export function deriveSteps(decisions: Decision[]): void {
  const stated = (id: string) => {
    const d = decisions.find((x) => x.id === id)
    return basisOf(d) === 'customer' ? d?.value : null
  }
  if (stated('reuse_fiber') !== 'yes') return
  const fiber = stated('existing_fiber_type')
  const value = fiber === 'silica_uv_vis_nir' ? 'uv_vis_nir_only' : fiber === 'ir_fiber' ? 'mid_ir_possible' : null
  if (!value) return
  const i = decisions.findIndex((x) => x.id === 'spectral_range')
  const prev = i >= 0 ? decisions[i] : undefined
  const why =
    value === 'uv_vis_nir_only'
      ? 'Derived from the stated facts: the customer wants to reuse an existing silica fiber, which transmits about 0.35–2.4 µm (UV/Vis/NIR).'
      : 'Derived from the stated facts: the customer wants to reuse an existing IR fiber, so mid-IR light can reach the sample.'
  const next: Decision =
    prev && basisOf(prev) === 'customer' && prev.value && prev.value !== value
      ? { ...prev, basis: 'conflict', value: prev.value, alternative: value, reasoning: `The customer text points to “${DIM_BY_ID.spectral_range.labels[prev.value]?.name}”, but ${why.charAt(0).toLowerCase()}${why.slice(1)}` }
      : { ...(prev ?? { id: 'spectral_range' }), id: 'spectral_range', basis: 'customer', value, reasoning: why, missing: undefined }
  if (i >= 0) decisions[i] = next
  else decisions.push(next)
}
