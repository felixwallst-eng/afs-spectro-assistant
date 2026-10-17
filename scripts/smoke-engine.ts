import { resolveDimensions, assess } from '../shared/engine.ts'
import { BASE_METHODS } from '../shared/knowledge.ts'
import { DEFAULT_SETTINGS } from '../shared/types.ts'
import type { RawDimension } from '../shared/types.ts'

const mk = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).map(([id, value]) => [id, { id, value, confidence: 0.9 } as RawDimension]))
const cases: Record<string, Record<string, string>> = {
  D02: { sample_state: 'opaque_scattering_liquid', target_property_type: 'chemical_composition', target_definition: 'clearly_defined', deployment_context: 'process_monitoring', interface_mode: 'in_process_probe', optical_variability: 'variable_over_process', certainty_requested: 'exploratory_assessment', cond_temperature_variation: 'yes' },
  H04: { sample_state: 'liquid_optics_unspecified', target_property_type: 'chemical_composition', target_definition: 'clearly_defined', deployment_context: 'process_monitoring', analyzer_location: 'remote_from_process', proposed_mir_atr: 'yes', reuse_fiber: 'yes', existing_fiber_type: 'silica_uv_vis_nir', certainty_requested: 'approval_or_proof' },
  H03: { sample_state: 'liquid_optics_unspecified', target_property_type: 'chemical_composition', target_definition: 'clearly_defined', deployment_context: 'process_monitoring', proposed_fluorescence: 'yes', reuse_instrument: 'yes', fluorescent_target: 'explicitly_not_identified', certainty_requested: 'exploratory_assessment' },
  H06: { sample_state: 'soft_solid_or_tissue', target_property_type: 'sample_classification', target_definition: 'clearly_defined', deployment_context: 'clinical_or_in_vivo', reuse_study_as_evidence: 'yes', certainty_requested: 'approval_or_proof' },
}
for (const [id, vals] of Object.entries(cases)) {
  const a = assess(resolveDimensions(mk(vals), {}, DEFAULT_SETTINGS), BASE_METHODS)
  console.log(`\n=== ${id}: ${a.decisionStatus} (${a.decisionReasons.join(' ')})  ${a.knowledgeVersion}`)
  a.warnings.forEach((w) => console.log(`  ! [${w.severity}] ${w.text.slice(0, 90)}`))
  a.candidates.filter((c) => c.status !== 'excluded').slice(0, 6).forEach((c) => console.log(`  ${c.status.padEnd(11)} ${String(c.score).padStart(3)} ${c.setup.method}/${c.setup.technique}  | ${c.reasons.map((r) => r.effect[0]).join('')}`))
  console.log(`  excluded: ${a.candidates.filter((c) => c.status === 'excluded').length}`)
  a.questions.slice(0, 5).forEach((q) => console.log(`  ? p${q.priority} ${(q.impact * 100).toFixed(0)}% ${q.dimensionId}: ${q.text.slice(0, 70)}`))
}
