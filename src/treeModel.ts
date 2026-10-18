import { DIM_BY_ID } from '../shared/dimensions.ts'
import { basisOf } from '../shared/treeLogic.ts'
import { evaluateAll } from '../shared/engine.ts'
import { TREE_NODES } from '../shared/tree.ts'
import type { Decision } from '../shared/tree.ts'
import type { MethodSetup } from '../shared/types.ts'

export { rawFromDecisions } from '../shared/treeLogic.ts'

/** decided: stated by the customer · suggested: AFS sources point to a value, expert accepts ·
 *  conflict: customer text and AFS sources disagree · expert: set or accepted by the expert ·
 *  action: missing and blocking · minor: missing, not blocking ·
 *  deferred: the expert left it open on purpose – to be asked from the customer */
export type NodeStatus = 'decided' | 'suggested' | 'conflict' | 'expert' | 'action' | 'minor' | 'deferred'

export function nodeStatus(id: string, decisions: Decision[], overrides: Record<string, string>): NodeStatus {
  if (overrides[id] !== undefined) return overrides[id] === DIM_BY_ID[id]?.unknownLabel ? 'deferred' : 'expert'
  const d = decisions.find((x) => x.id === id)
  if (basisOf(d) === 'customer' && d?.value) return 'decided'
  if (basisOf(d) === 'sources' && d?.value) return 'suggested'
  if (basisOf(d) === 'conflict') return 'conflict'
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
