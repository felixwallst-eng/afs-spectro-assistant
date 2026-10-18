import { DIM_BY_ID } from '../shared/dimensions.ts'
import { evaluateAll } from '../shared/engine.ts'
import { TREE_NODES } from '../shared/tree.ts'
import type { MethodSetup } from '../shared/types.ts'

export { rawFromDecisions } from '../shared/treeLogic.ts'

export { nodeStatus } from '../shared/treeLogic.ts'
export type { NodeStatus } from '../shared/treeLogic.ts'

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
