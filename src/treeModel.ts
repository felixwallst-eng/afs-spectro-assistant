import { DIMENSIONS, DIM_BY_ID } from '../shared/dimensions.ts'
import { evaluateAll } from '../shared/engine.ts'
import { TREE_NODES } from '../shared/tree.ts'
import type { Decision } from '../shared/tree.ts'
import type { MethodSetup, RawDimension } from '../shared/types.ts'

/** Model decisions -> raw dimensions for the rule engine. Only customer-stated values are applied;
 *  suggestions from the AFS sources count only once the expert accepts them. */
export function rawFromDecisions(decisions: Decision[]): Record<string, RawDimension> {
  const out: Record<string, RawDimension> = {}
  for (const def of DIMENSIONS) {
    const d = decisions.find((x) => x.id === def.id)
    const stated = basisOf(d) === 'customer' ? (d?.value ?? null) : null
    const value = def.kind === 'flag' ? (stated === 'yes' ? 'yes' : 'no') : (stated ?? def.unknownLabel ?? Object.keys(def.labels)[0])
    out[def.id] = { id: def.id, value, confidence: 1 }
  }
  return out
}

/** decided: stated by the customer · suggested: AFS sources point to a value, expert accepts ·
 *  expert: set or accepted by the expert · action: missing and blocking · minor: missing, not blocking */
/** Entries saved before suggestions existed have no basis: a value then means stated by the customer. */
const basisOf = (d?: Decision) => d?.basis ?? (d?.value ? 'customer' : 'missing')

export type NodeStatus = 'decided' | 'suggested' | 'expert' | 'action' | 'minor'

export function nodeStatus(id: string, decisions: Decision[], overrides: Record<string, string>): NodeStatus {
  if (overrides[id] !== undefined) return 'expert'
  const d = decisions.find((x) => x.id === id)
  if (basisOf(d) === 'customer' && d?.value) return 'decided'
  if (basisOf(d) === 'sources' && d?.value) return 'suggested'
  return (DIM_BY_ID[id]?.priority ?? 3) <= 2 ? 'action' : 'minor'
}

/** How many method setups remain possible after each tree level is applied (19 → … → n). */
export function remainingPerLevel(values: Record<string, string>, methods: MethodSetup[]): number[] {
  const counts: number[] = []
  for (let k = 0; k <= TREE_NODES.length; k++) {
    const v = { ...values }
    TREE_NODES.slice(k).forEach((n) => (v[n.id] = DIM_BY_ID[n.id].unknownLabel ?? v[n.id]))
    counts.push(evaluateAll(methods, v).filter((c) => c.status !== 'excluded').length)
  }
  return counts
}
