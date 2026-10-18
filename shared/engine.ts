import { DIMENSIONS, DIM_BY_ID } from './dimensions.ts'
import { FIBERS, FIBER_CITATION, METHOD_INFO, TABLE1, knowledgeVersion } from './knowledge.ts'
import type {
  Assessment,
  Candidate,
  Citation,
  DecisionStatus,
  DimensionResult,
  MethodSetup,
  OpenQuestion,
  RawDimension,
  Reason,
  Settings,
  Warning,
} from './types.ts'

// ---------------------------------------------------------------------------
// 1. Thresholds + expert overrides -> effective dimension values
// ---------------------------------------------------------------------------

export function resolveDimensions(
  raw: Record<string, RawDimension>,
  overrides: Record<string, string>,
  settings: Settings,
): Record<string, DimensionResult> {
  const out: Record<string, DimensionResult> = {}
  for (const def of DIMENSIONS) {
    const r = raw[def.id]
    const override = overrides[def.id]
    if (override !== undefined) {
      out[def.id] = { id: def.id, value: override, rawValue: r?.value, confidence: r?.confidence ?? null, probabilities: r?.probabilities, status: 'confident', source: 'expert' }
      continue
    }
    if (!r) {
      const fallback = def.kind === 'flag' ? 'no' : def.unknownLabel ?? Object.keys(def.labels)[0]
      out[def.id] = { id: def.id, value: fallback, confidence: null, status: def.kind === 'fact' ? 'unknown' : 'confident', source: 'clef' }
      continue
    }
    let value = r.value
    let status: DimensionResult['status']
    if (def.kind === 'flag') {
      // a "yes" below the floor is treated as not mentioned; "no" is always taken as is
      if (value === 'yes') status = r.confidence >= settings.confidentAt ? 'confident' : r.confidence >= settings.uncertainAt ? 'uncertain' : 'unknown'
      else status = 'confident'
      if (status === 'unknown') value = 'no'
    } else if (def.unknownLabel && value === def.unknownLabel) {
      status = 'unknown'
    } else if (r.confidence >= settings.confidentAt) {
      status = 'confident'
    } else if (r.confidence >= settings.uncertainAt) {
      status = 'uncertain'
    } else {
      status = 'unknown'
      if (def.unknownLabel) value = def.unknownLabel
    }
    out[def.id] = { id: def.id, value, rawValue: r.value, confidence: r.confidence, probabilities: r.probabilities, status, source: 'clef' }
  }
  return out
}

// ---------------------------------------------------------------------------
// 2. Method setups: knock-outs, conditions and ranking, each with a source
// ---------------------------------------------------------------------------

type V = Record<string, string>
const yes = (v: V, id: string) => v[id] === 'yes'

const SAMPLE_TOKENS: Record<string, string[]> = {
  powder_or_granular: ['powder'],
  clear_liquid: ['liquid'],
  turbid_or_colloidal_liquid: ['liquid', 'colloidal', 'scattering media'],
  opaque_scattering_liquid: ['scattering media', 'colloidal', 'liquid'],
  liquid_optics_unspecified: ['liquid', 'colloidal', 'scattering media'],
  melt_or_paste: ['paste', 'soft'],
  soft_solid_or_tissue: ['soft', 'solid'],
  rigid_solid: ['solid', 'solid film', 'pill'],
}

const c = (source: string, page?: string): Citation => ({ source, page })
const isAtr = (s: MethodSetup) => s.depthUm !== null && s.depthUm[1] <= 10 && s.phenomenon === 'absorption'
const isTransmissionPath = (s: MethodSetup) =>
  (s.phenomenon === 'transmission' || s.phenomenon === 'absorption') && s.depthUm !== null && s.depthUm[0] >= 1000
const isReflection = (s: MethodSetup) => s.phenomenon === 'diffuse reflection'
const overlaps = (a: [number, number], b: [number, number]) => a[0] < b[1] && b[0] < a[1]

export function evaluateSetup(s: MethodSetup, v: V): Candidate {
  const reasons: Reason[] = []
  const add = (effect: Reason['effect'], text: string, citation?: Citation) => reasons.push({ effect, text, citation })

  // Sample type (S01 Table 1)
  const state = v.sample_state
  const tokens = SAMPLE_TOKENS[state]
  if (!tokens) {
    add('condition', 'Sample state unknown – suitability for the sample not checked.', TABLE1)
  } else {
    const hit = s.sampleTypes.filter((t) => tokens.includes(t))
    if (hit.length === 0) add('exclude', `Designed for ${s.sampleTypes.join(', ')} – not for the stated sample.`, TABLE1)
    else add('plus', `Suited to ${hit.join(', ')} samples.`, TABLE1)
  }

  // Optical density / turbidity (S01 p.16–18)
  const turbid = state === 'turbid_or_colloidal_liquid' || v.optical_variability === 'variable_over_process'
  if (state === 'opaque_scattering_liquid' && isTransmissionPath(s)) {
    if (s.method === 'nir') add('condition', 'Transmission through mm paths is limited in opaque products; reflection is the usual choice, transflection only in some cases.', c('S01', 'p.18'))
    else add('exclude', 'Light cannot penetrate an opaque sample over a mm path; the signal saturates.', c('S01', 'p.16'))
  } else if (turbid && isTransmissionPath(s)) {
    add('condition', 'Transmission signal can saturate when turbidity rises; path length must suit the optical density range.', c('S01', 'p.16, 18'))
  }
  if (isAtr(s) && (turbid || state === 'opaque_scattering_liquid')) add('plus', 'ATR uses a µm path, so turbid or opaque media can be measured without dilution.', c('S01', 'p.16'))
  if (isReflection(s) && state === 'opaque_scattering_liquid') add('plus', 'Reflection is the usual geometry for opaque or concentrated products.', c('S01', 'p.17'))
  if (isReflection(s) && state === 'clear_liquid') add('condition', 'Reflection can be less representative for clear liquids.', c('S01', 'p.18'))
  if (s.method === 'nir' && s.phenomenon === 'transmission' && state === 'clear_liquid') add('plus', 'Transmission / transflection is preferred for clear or semi-transparent liquids.', c('S01', 'p.18'))

  // Heterogeneity (S01 p.8, 14)
  if (v.sample_heterogeneity === 'locally_heterogeneous') {
    if (isAtr(s)) add('condition', 'Samples only the surface layer (µm); a combined probe is needed to compare methods at the same spot.', c('S01', 'p.8, 14'))
    else add('info', 'Sequential measurements may not hit the same spot; a combined probe measures one location.', c('S01', 'p.8'))
  }

  // Interface / location
  if (v.interface_mode === 'non_contact_at_distance' && !s.nonContact) add('exclude', 'Requires contact or sampling; the client asks for a contact-free measurement.', TABLE1)
  if (s.labOnly && (v.interface_mode === 'in_process_probe' || v.interface_mode === 'non_contact_at_distance' || v.deployment_context === 'process_monitoring'))
    add('condition', 'Laboratory setup – useful for the first feasibility test, not for in-line installation.', TABLE1)

  // What is measured
  const target = v.target_property_type
  if (target === 'chemical_composition' || target === 'sample_classification') {
    if (s.selectivity === 'high') add('plus', 'High selectivity for chemical composition.', TABLE1)
    if (s.selectivity === 'low') add('condition', 'Low selectivity – only for a defined absorbing or fluorescent species; signals overlap in mixtures.', TABLE1)
  }
  if (target === 'turbidity_or_cell_density' && s.method === 'uvvis') add('plus', 'Turbidity correlates with cell density – a robust, low-cost biomass trend.', c('S01', 'p.16'))
  if (target === 'fluorescent_species' && s.method === 'fluorescence') add('plus', 'High sensitivity for a defined fluorescent species.', c('S01', 'p.16'))
  if (target === 'sample_classification' && (s.method === 'ir' || s.method === 'fluorescence')) add('info', 'MIR ATR and fluorescence have been combined for tissue classification.', c('S04'))

  // Fluorescence needs a defined target (S01 p.16, docx section 5)
  if (s.method === 'fluorescence') {
    if (v.fluorescent_target === 'explicitly_not_identified') add('exclude', 'No fluorescent target or marker identified – fluorescence is sensitive but not selective.', c('S01', 'p.16'))
    else if (v.fluorescent_target !== 'identified' && target !== 'fluorescent_species') add('condition', 'Only meaningful for a defined fluorescent species or a justified marker.', c('S01', 'p.16'))
  }

  // Water, concentration, budget
  if (v.aqueous_matrix === 'yes') {
    if (s.method === 'raman') add('plus', 'Raman is well suited to aqueous media (low water absorbance).', c('S01', 'p.16'))
    if (s.method === 'ir') add('minus', 'Water absorbs strongly in the infrared.', c('S01', 'p.16'))
  }
  if (v.concentration_level === 'trace') {
    if (s.sensitivity === 'high') add('plus', 'High sensitivity for trace levels.', TABLE1)
    if (s.method === 'nir') add('minus', 'NIR may lack sensitivity below about 0.1 %.', c('S01', 'p.16'))
  }
  // Cost is a pro / con of every setup. It changes the ranking only if the customer states a low budget.
  if (v.budget === 'low') {
    if (s.cost === 'high') add('minus', 'Higher cost setup – the customer asks for a low budget.', TABLE1)
    if (s.cost === 'low') add('plus', 'Low-cost setup – fits the low budget.', TABLE1)
  } else if (s.cost === 'high') add('info', 'Cost: high – a larger investment than the low- and average-cost alternatives.', TABLE1)
  else if (s.cost === 'low') add('info', 'Cost: low – the most economical option for this method.', TABLE1)
  else add('info', 'Cost: average.', TABLE1)

  // Process conditions
  if (!s.labOnly && (yes(v, 'cond_high_temperature') || yes(v, 'cond_fouling')))
    add('condition', 'Probe material, temperature rating and fouling behaviour must be confirmed with AFS.', c('S02', 'p.13–14'))

  // Fiber link
  const info = METHOD_INFO[s.method]
  if (yes(v, 'reuse_fiber') && v.existing_fiber_type === 'silica_uv_vis_nir') {
    const silica = FIBERS.find((f) => f.id === 'silica_vis_nir')!.rangeUm
    if (!overlaps(silica, info.rangeUm)) add('condition', `The existing silica link (≈0.35–2.4 µm) cannot carry ${info.rangeText}; an IR fiber is needed.`, FIBER_CITATION)
  }
  if (v.analyzer_location === 'remote_from_process' && s.method === 'ir')
    add('condition', 'Remote analyzer: MIR needs an IR-transmitting fiber; link length and losses must be checked.', FIBER_CITATION)

  // Requested by the client
  const proposedKey = { ir: 'proposed_mir_atr', nir: 'proposed_nir', raman: 'proposed_raman', fluorescence: 'proposed_fluorescence', uvvis: 'proposed_uv_vis' }[s.method]
  if (yes(v, proposedKey)) add('info', 'Mentioned by the client – evaluated explicitly.')

  const status: Candidate['status'] = reasons.some((r) => r.effect === 'exclude')
    ? 'excluded'
    : reasons.some((r) => r.effect === 'condition')
      ? 'conditional'
      : 'recommended'
  const score =
    reasons.filter((r) => r.effect === 'plus').length * 2 -
    reasons.filter((r) => r.effect === 'minus').length * 2 -
    reasons.filter((r) => r.effect === 'condition').length
  return { setup: s, status, score, reasons }
}

const STATUS_ORDER = { recommended: 0, conditional: 1, excluded: 2 }

export function evaluateAll(methods: MethodSetup[], v: V): Candidate[] {
  return methods
    .map((m) => evaluateSetup(m, v))
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.score - a.score)
}

// ---------------------------------------------------------------------------
// 3. Premise checks -> warnings, decision status
// ---------------------------------------------------------------------------

function premiseWarnings(v: V, dims: Record<string, DimensionResult>): Warning[] {
  const w: Warning[] = []
  const add = (id: string, severity: Warning['severity'], text: string, citation?: Citation) => w.push({ id, severity, text, citation })

  if (v.deployment_context === 'clinical_or_in_vivo')
    add('clinical', 'block', 'Clinical or in-vivo use is outside the supported scope. The supplied studies are laboratory proofs of concept; only research feasibility steps can be proposed.', c('S03'))
  if (yes(v, 'reuse_study_as_evidence'))
    add('study-as-proof', 'block', 'A published study is a reason to test a method, not proof that a new setup works for this use. Own validation data are required.', c('S03'))
  if (yes(v, 'reuse_calibration') && v.matrix_change_vs_existing !== 'same_matrix')
    add('calibration', 'block', 'Calibrations are matrix-specific. A changed formulation needs a new or extended calibration; adding another method does not keep the old model valid.', c('S01', 'p.10'))
  // classifying sample types from the fluorescence pattern needs no single named fluorophore (S04)
  if (yes(v, 'proposed_fluorescence') && v.fluorescent_target !== 'identified' && v.target_property_type !== 'sample_classification')
    add('fluorescence-target', 'block', 'Fluorescence is highly sensitive but not selective. Without a defined fluorescent species or reference relationship it cannot report the requested variables directly.', c('S01', 'p.16'))
  if (yes(v, 'reuse_fiber')) {
    if (v.existing_fiber_type === 'silica_uv_vis_nir' && yes(v, 'proposed_mir_atr'))
      add('silica-mir', 'block', 'Silica fibers transmit about 0.35–2.4 µm. MIR ATR needs 2.5–25 µm, so the existing silica link cannot be approved for MIR; chalcogenide, polycrystalline or hollow-waveguide fibers are candidates.', FIBER_CITATION)
    else if (v.existing_fiber_type === 'silica_uv_vis_nir')
      add('silica-range', 'caution', 'The existing silica link limits the usable range to about 0.35–2.4 µm (UV/Vis, NIR, Raman); MIR is not possible over it.', FIBER_CITATION)
    else if (v.existing_fiber_type === 'not_stated')
      add('fiber-unknown', 'caution', 'Fiber type of the existing link is unknown; its transmission range must match the method.', FIBER_CITATION)
  }
  if (v.analyzer_location === 'remote_from_process')
    add('remote', 'caution', 'Analyzer is remote: fiber type, length and routing determine which spectral range reaches the probe.', FIBER_CITATION)
  if (v.matrix_count === 'multiple_distinct_matrices')
    add('multi-stream', 'caution', 'Several streams with different optical behaviour: assess each stream separately (e.g. transmission for clear, reflection for opaque).', c('S01', 'p.17–18'))
  if (v.target_property_type === 'turbidity_or_cell_density')
    add('od-not-viable', 'caution', 'Optical density follows total biomass; it is not a viable cell count.', c('S01', 'p.16'))
  const openPrio1 = DIMENSIONS.filter((d) => d.kind === 'fact' && d.priority === 1 && isRelevant(d.id, v) && dims[d.id]?.status === 'unknown')
  if ((v.certainty_requested === 'approval_or_proof' || v.certainty_requested === 'immediate_final_specification') && openPrio1.length > 0)
    add('certainty', 'block', `The requested certainty is not justified yet: ${openPrio1.length} decisive fact(s) are unknown. A provisional shortlist and a first experiment come first.`)
  return w
}

function decide(v: V, dims: Record<string, DimensionResult>): { status: DecisionStatus; reasons: string[] } {
  if (v.deployment_context === 'clinical_or_in_vivo') return { status: 'out_of_scope', reasons: ['Clinical / in-vivo use requested.'] }
  const reasons: string[] = []
  if (v.target_definition === 'undefined' || v.target_definition === 'loosely_defined') reasons.push('The measurement target is not defined yet.')
  if (v.target_property_type === 'not_stated' && v.target_definition === 'not_stated') reasons.push('No measurement target identified.')
  if (v.sample_state === 'not_stated') reasons.push('Sample state is unknown.')
  if (v.certainty_requested !== 'exploratory_assessment') {
    const open = DIMENSIONS.filter((d) => d.kind === 'fact' && d.priority === 1 && isRelevant(d.id, v) && dims[d.id]?.status === 'unknown')
    if (open.length) reasons.push('A definitive answer was requested while decisive facts are missing.')
  }
  return reasons.length ? { status: 'insufficient_information', reasons } : { status: 'provisional', reasons: ['Shortlist based on stated facts; to be confirmed by a feasibility test.'] }
}

// ---------------------------------------------------------------------------
// 4. Open questions, ranked by priority and by how many setups they could change
// ---------------------------------------------------------------------------

/** Why a follow-up dimension is currently ignored. */
export const RELEVANCE_NOTE: Record<string, string> = {
  fluorescent_target: 'Only relevant if the client mentions fluorescence or wants to measure a fluorescent species.',
  matrix_change_vs_existing: 'Only relevant if the client wants to reuse an existing calibration.',
  existing_fiber_type: 'Only relevant if the client wants to reuse an existing fiber link.',
}

export function isRelevant(id: string, v: Record<string, string>): boolean {
  if (id === 'fluorescent_target') return yes(v, 'proposed_fluorescence') || v.target_property_type === 'fluorescent_species'
  if (id === 'matrix_change_vs_existing') return yes(v, 'reuse_calibration')
  if (id === 'existing_fiber_type') return yes(v, 'reuse_fiber')
  return true
}

function questionImpact(id: string, v: V, methods: MethodSetup[], current: Candidate[]): number {
  const def = DIM_BY_ID[id]
  const now = new Map(current.map((c) => [c.setup.id, c.status]))
  let changed = 0
  let options = 0
  for (const label of Object.keys(def.labels)) {
    if (label === def.unknownLabel) continue
    options++
    const alt = evaluateAll(methods, { ...v, [id]: label })
    changed += alt.filter((c) => now.get(c.setup.id) !== c.status).length
  }
  return options ? changed / options / methods.length : 0
}

function openQuestions(dims: Record<string, DimensionResult>, v: V, methods: MethodSetup[], current: Candidate[]): OpenQuestion[] {
  const qs: OpenQuestion[] = []
  for (const def of DIMENSIONS) {
    if (def.kind !== 'fact' || !def.clarification || !isRelevant(def.id, v)) continue
    const d = dims[def.id]
    if (d.status === 'confident') continue
    const kind = d.status === 'unknown' ? 'missing' : 'confirm'
    const text = kind === 'missing' ? def.clarification : `Please confirm: ${def.title.toLowerCase()} = "${def.labels[d.value]?.name ?? d.value}"?`
    qs.push({ dimensionId: def.id, text, priority: def.priority, impact: questionImpact(def.id, v, methods, current), kind })
  }
  const anyCondition = DIMENSIONS.some((d) => d.group === 'conditions' && v[d.id] === 'yes')
  if (!anyCondition)
    qs.push({ dimensionId: 'process_conditions', text: 'What temperature, pressure, fouling and cleaning conditions apply at the measurement point?', priority: 2, impact: 0, kind: 'missing' })
  // rank: decisive facts first, then by how many setups the answer could change
  const rank = (q: OpenQuestion) => ({ 1: 3, 2: 1.5, 3: 0 })[q.priority] + q.impact * 10
  return qs.sort((a, b) => rank(b) - rank(a))
}

// ---------------------------------------------------------------------------
// 5. Full assessment
// ---------------------------------------------------------------------------

export function assess(dims: Record<string, DimensionResult>, methods: MethodSetup[]): Assessment {
  const v: V = Object.fromEntries(Object.values(dims).map((d) => [d.id, d.value]))
  const candidates = evaluateAll(methods, v)
  const decision = decide(v, dims)
  return {
    dimensions: dims,
    questions: openQuestions(dims, v, methods, candidates),
    candidates,
    warnings: premiseWarnings(v, dims),
    decisionStatus: decision.status,
    decisionReasons: decision.reasons,
    knowledgeVersion: knowledgeVersion(methods),
  }
}
