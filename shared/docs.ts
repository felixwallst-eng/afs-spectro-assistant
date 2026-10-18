// Knowledge-base documents: the supplied AFS originals, curated additional sources bundled with the app,
// and PDFs uploaded by experts.

export interface DocMeta {
  id: string // 'S01'… for originals, 'u-…' for uploads
  title: string
  fileName: string
  /** original: supplied by AFS · added: curated extra source in the repository · uploaded: by an expert */
  origin: 'original' | 'added' | 'uploaded'
  url: string // where the PDF is served
  pages: number | null
  size: number | null // bytes
  addedAt: string
  /** Short description the assistant reads first to decide which documents to open. */
  summary: string
  /** Expert remarks, e.g. limits of a study or how (not) to cite it. */
  notes: string
  /** Whether the assistant may use this document. */
  enabled: boolean
  notesUpdatedAt?: string
  /** Page texts stored, so the assistant can search and cite this document. */
  indexed?: boolean
  /** Number of knowledge cards extracted from the whole document (undefined = not read yet). */
  cards?: number
  cardsAt?: string
  /** true = the curated cards from the repository are in use (no edits stored). */
  cardsCurated?: boolean
}

/** Fields an expert can edit. */
export type DocPatch = Partial<Pick<DocMeta, 'title' | 'summary' | 'notes' | 'enabled'>>

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024

export const ORIGINAL_DOCS: DocMeta[] = [
  {
    id: 'S01',
    title: 'Multispectral Laboratory of Optical Analysis Methods',
    fileName: 'S01_Multispectral_Laboratory.pdf',
    origin: 'original',
    url: '/sources/S01.pdf',
    pages: 19,
    size: 912728,
    addedAt: '2026-10-16',
    summary:
      'Main technical source. Overview of optical analysis methods (MIR, NIR, Raman, UV/Vis, fluorescence) with comparison table (p.6), combining methods (p.7–9), measurement kits and fiber probes (p.10–12) and application cases: medical tissue, pharmaceutical blends, bioprocess monitoring, dairy (p.13–18).',
    notes: '',
    enabled: true,
  },
  {
    id: 'S02',
    title: 'AFS Process Control Slides',
    fileName: 'S02_AFS_Process_Control_Slides.pdf',
    origin: 'original',
    url: '/sources/S02.pdf',
    pages: 20,
    size: 7134716,
    addedAt: '2026-10-16',
    summary:
      'Slides on process control: fiber types and transmission ranges (p.6–10), probes, application slides for water in petroleum (p.13) and API in polymer extrusion (p.14), combined probes (p.15–16).',
    notes: 'Mostly images – the text layer contains little more than slide titles, so passages cannot be highlighted.',
    enabled: true,
  },
  {
    id: 'S03',
    title: 'LED-based NIR Sensor for Kidney Tumour Diagnostics (2017)',
    fileName: 'S03_LED_Kidney_Study_2017.pdf',
    origin: 'original',
    url: '/sources/S03.pdf',
    pages: 17,
    size: 1012740,
    addedAt: '2026-10-16',
    summary: 'Research paper: LED-based NIR sensor for kidney tumour diagnostics, tested on 14 in-vitro samples from 7 patients.',
    notes: 'Proof of concept only. Do not cite as evidence for clinical or in-vivo readiness.',
    enabled: true,
  },
  {
    id: 'S04',
    title: 'Combined MIR ATR and Fluorescence Fiber Probe (2021)',
    fileName: 'S04_Combi_MIR_Fluorescence_2021.pdf',
    origin: 'original',
    url: '/sources/S04.pdf',
    pages: 6,
    size: 462094,
    addedAt: '2026-10-16',
    summary: 'Research paper: fiber probe for simultaneous MIR (ATR) and fluorescence measurement at the same spot, demonstrated on model biological tissues.',
    notes: 'Laboratory demonstration on model tissues.',
    enabled: true,
  },
]

/** Additional sources bundled with the app (curated cards in knowledge/cards). Used only with
 *  “Originals + added sources”; the evaluation runs on the AFS originals alone. */
export const ADDED_DOCS: DocMeta[] = [
  {
    id: 'A01',
    title: 'Mishra et al. (2025): Spectroscopic advances in real time monitoring of pharmaceutical bioprocesses',
    fileName: 'Mishra_2025_SpectroscJ_3_12.pdf',
    origin: 'added',
    url: '/sources/A01.pdf',
    pages: 24,
    size: 1253398,
    addedAt: '2026-10-18',
    summary:
      'Open-access review (Spectroscopy Journal 3(2):12, CC BY 4.0), cited by S01 p.16. In-line, on-line and at-line monitoring of fermentations and cell cultures with UV/Vis, NIR, MIR, Raman and fluorescence: applications, accuracy, cost and limitations (p.6–16), method selection and cost comparison (p.18–20).',
    notes: 'Review of published studies – a reason to test a method, not proof for a specific process. Cost figures are indicative (USD, 2025).',
    enabled: true,
  },
]

/** Documents shipped with the app: originals plus curated additional sources. */
export const BUNDLED_DOCS: DocMeta[] = [...ORIGINAL_DOCS, ...ADDED_DOCS]
