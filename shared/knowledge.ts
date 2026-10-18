import type { Citation, MethodKey, MethodSetup } from './types.ts'

// Knowledge base transcribed from the supplied AFS material.
// Method setups: S01 Table 1 (p.6) via AFS_method_comparison_table.xlsx.
// Fiber ranges: S02 p.6 (as transcribed in AFS_Examples_and_Reference.docx, section 5).

export const TABLE1: Citation = { source: 'S01', page: 'Table 1 (p.6)' }

const row = (
  id: string,
  method: MethodKey,
  technique: string,
  phenomenon: string,
  sampleTypes: string[],
  depthUm: [number, number] | null,
  sensitivity: MethodSetup['sensitivity'],
  selectivity: MethodSetup['selectivity'],
  cost: MethodSetup['cost'],
  labOnly: boolean,
  nonContact = false,
): MethodSetup => ({ id, method, technique, phenomenon, sampleTypes, depthUm, sensitivity, selectivity, cost, labOnly, nonContact, citation: TABLE1 })

export const BASE_METHODS: MethodSetup[] = [
  row('ir-atr-platform', 'ir', 'ATR platform', 'absorption', ['liquid', 'paste', 'soft'], [1, 6], 'average', 'high', 'high', true),
  row('ir-atr-probe', 'ir', 'ATR probe', 'absorption', ['liquid', 'paste', 'soft'], [1, 6], 'average', 'high', 'high', false),
  row('ir-cuvette', 'ir', 'Cuvette', 'absorption', ['liquid'], [10, 100], 'high', 'high', 'average', true),
  row('ir-sample-layer', 'ir', 'Sample layer', 'absorption', ['solid film'], [5, 50], 'high', 'high', 'average', true),
  row('ir-sample-surface', 'ir', 'Sample surface', 'diffuse reflection', ['solid'], [10, 10], 'average', 'high', 'average', true),
  row('nir-cuvette', 'nir', 'Cuvette', 'transmission', ['liquid'], [1000, 5000], 'average', 'average', 'average', true),
  row('nir-transmission-probe', 'nir', 'Transmission / transflection probe', 'transmission', ['liquid', 'colloidal'], [1000, 10000], 'average', 'average', 'average', false),
  row('nir-diffuse-reflection-probe', 'nir', 'Diffuse reflection probe', 'diffuse reflection', ['scattering media', 'powder'], [500, 1000], 'average', 'average', 'average', false),
  row('nir-integrating-sphere', 'nir', 'Integrating sphere', 'diffuse reflection', ['solid', 'powder'], [5000, 10000], 'average', 'average', 'average', true),
  row('nir-surface-distance', 'nir', 'Surface at a distance', 'diffuse reflection', ['solid', 'powder'], [2000, 5000], 'average', 'average', 'average', false, true),
  row('raman-cuvette', 'raman', 'Cuvette 90°', 'Raman scattering', ['liquid'], [2000, 5000], 'average', 'high', 'high', true),
  row('raman-probe', 'raman', 'Raman probe', 'Raman scattering', ['liquid', 'powder', 'solid'], [2000, 5000], 'average', 'high', 'high', false),
  row('uvvis-cuvette', 'uvvis', 'Cuvette', 'absorption', ['liquid'], [1000, 5000], 'high', 'low', 'low', true),
  row('uvvis-atr-probe', 'uvvis', 'ATR probe', 'absorption', ['liquid'], [0.1, 1], 'low', 'low', 'average', false),
  row('uvvis-diffuse-reflection-probe', 'uvvis', 'Diffuse reflection probe', 'diffuse reflection', ['solid', 'pill'], [1000, 5000], 'low', 'low', 'low', false),
  row('uvvis-transmission-probe', 'uvvis', 'Transmission / transflection probe', 'transmission', ['liquid'], [1000, 10000], 'low', 'low', 'low', false),
  row('uvvis-probe-lens', 'uvvis', 'Probe with lens', 'emission of an external source', ['radiating sample'], null, 'high', 'low', 'low', false, true),
  row('fluo-cuvette', 'fluorescence', 'Cuvette 90°', 'fluorescence', ['liquid'], [10000, 10000], 'high', 'low', 'low', true),
  row('fluo-probe', 'fluorescence', 'Fluorimetric probe', 'fluorescence', ['liquid', 'solid'], [1000, 5000], 'high', 'low', 'low', false),
]

export interface MethodInfo {
  name: string
  rangeText: string
  rangeUm: [number, number] // wavelengths that must reach the probe through the fiber
  citation: Citation
}

export const METHOD_INFO: Record<MethodKey, MethodInfo> = {
  ir: { name: 'Mid-IR (MIR)', rangeText: '4000–400 cm⁻¹ (2.5–25 µm)', rangeUm: [2.5, 25], citation: { source: 'S01', page: 'p.6, 9–10' } },
  nir: { name: 'Near-IR (NIR)', rangeText: '780–2500 nm', rangeUm: [0.78, 2.5], citation: { source: 'S01', page: 'p.10' } },
  raman: { name: 'Raman', rangeText: 'visible / short-wave NIR detection (400–1100 nm), e.g. 785 nm excitation', rangeUm: [0.4, 1.1], citation: { source: 'S01', page: 'p.11, 15' } },
  uvvis: { name: 'UV/Vis', rangeText: 'UV and visible', rangeUm: [0.19, 0.78], citation: { source: 'S01', page: 'p.5–6' } },
  fluorescence: { name: 'Fluorescence', rangeText: 'UV/visible excitation and emission', rangeUm: [0.2, 0.8], citation: { source: 'S01', page: 'p.12' } },
}

export interface FiberFamily {
  id: string
  name: string
  rangeUm: [number, number]
}

/** Approximate transmission ranges, S02 p.6 (figure). */
export const FIBERS: FiberFamily[] = [
  { id: 'silica_uv_vis', name: 'Silica UV-Vis', rangeUm: [0.19, 1.2] },
  { id: 'silica_vis_nir', name: 'Silica Vis-NIR', rangeUm: [0.35, 2.4] },
  { id: 'cir', name: 'Chalcogenide As-S (CIR)', rangeUm: [1.1, 6.5] },
  { id: 'pir', name: 'Polycrystalline IR (PIR)', rangeUm: [3, 17] },
  { id: 'hwg', name: 'Hollow glass waveguide (HWG)', rangeUm: [2, 18] },
  { id: 'inf3', name: 'Indium fluoride', rangeUm: [0.3, 5.5] },
  { id: 'zrf4', name: 'Zirconium fluoride', rangeUm: [0.3, 4.5] },
]
export const FIBER_CITATION: Citation = { source: 'S02', page: 'p.6' }

export interface SourceDoc {
  id: string
  title: string
  kind: string
  use: string
}

export const SOURCES: SourceDoc[] = [
  { id: 'S01', title: 'Multispectral Laboratory of Optical Analysis Methods', kind: 'Technical overview, 19 pages', use: 'Main technical source: methods, combinations, probes, application cases.' },
  { id: 'S02', title: 'AFS Process Control Slides', kind: 'Slides, 20 pages', use: 'Fiber types and transmission ranges, probes, process applications.' },
  { id: 'S03', title: 'LED NIR Kidney Study (2017)', kind: 'Research paper', use: 'In-vitro proof of concept on 14 samples from 7 patients.' },
  { id: 'S04', title: 'Combined MIR / Fluorescence Probe (2021)', kind: 'Research paper', use: 'Simultaneous MIR ATR and fluorescence on model tissues.' },
  { id: 'A01', title: 'Mishra et al. 2025, Spectroscopy Journal 3(2):12', kind: 'Open-access review (CC BY 4.0), added source', use: 'Bioprocess monitoring: UV/Vis, NIR, MIR, Raman, fluorescence – applications, accuracy, cost, limits. doi:10.3390/spectroscj3020012' },
  { id: 'S05', title: 'AFS Flyer', kind: 'Company overview', use: 'Business context only.' },
  { id: 'S06', title: 'Laboratory link', kind: 'Website', use: 'Business context only.' },
  { id: 'Table', title: 'AFS method comparison table', kind: 'Spreadsheet', use: 'Machine-readable S01 Table 1: method, technique, sample type, ratings.' },
]

/** Stable short hash of the method table, shown with every assessment. */
export function knowledgeVersion(methods: MethodSetup[]): string {
  const s = JSON.stringify(methods)
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return 'kb-' + (h >>> 0).toString(16).padStart(8, '0')
}
