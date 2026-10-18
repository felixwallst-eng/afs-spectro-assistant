// Solved cases: an enquiry the expert walked through, with every step decision and the expert's notes.
// They are added to the knowledge base as worked examples next to the PDFs. (For the demo they are
// stored and shown only; the classifier does not read them yet.)

export interface SolvedStep {
  id: string
  title: string
  /** What the assistant proposed: basis (customer / sources / missing / conflict) and value. */
  model: { basis: string; value: string | null; valueName: string | null }
  /** The final value after the expert's review. */
  value: string
  valueName: string
  /** The expert changed, confirmed or filled in this step (it was not simply stated by the customer). */
  byExpert: boolean
  note?: string
}

export interface SolvedCase {
  id: string
  createdAt: string
  updatedAt?: string
  title: string
  enquiry: string
  steps: SolvedStep[]
  methods: { name: string; technique: string; rank?: number }[]
  premises: { id: string; severity: string; text: string }[]
  engine: string
  /** reference: worked example from the AFS material, shipped with the app (cannot be deleted). */
  origin?: 'expert' | 'reference'
}

export const MAX_CASE_BYTES = 64 * 1024

const str = (x: unknown, max: number) => (typeof x === 'string' ? x.slice(0, max) : '')

/** Accepts only the expected shape (the body comes from the browser). */
export function parseSolvedCase(x: unknown): SolvedCase | null {
  if (!x || typeof x !== 'object') return null
  const o = x as Record<string, unknown>
  const enquiry = str(o.enquiry, 8000).trim()
  if (!enquiry || !Array.isArray(o.steps) || !o.steps.length) return null
  const steps: SolvedStep[] = o.steps.slice(0, 20).map((s) => {
    const r = (s ?? {}) as Record<string, unknown>
    const m = (r.model ?? {}) as Record<string, unknown>
    const note = str(r.note, 2000).trim()
    return {
      id: str(r.id, 60),
      title: str(r.title, 120),
      model: { basis: str(m.basis, 20), value: typeof m.value === 'string' ? m.value.slice(0, 60) : null, valueName: typeof m.valueName === 'string' ? m.valueName.slice(0, 120) : null },
      value: str(r.value, 60),
      valueName: str(r.valueName, 120),
      byExpert: r.byExpert === true,
      ...(note ? { note } : {}),
    }
  })
  const list = <T,>(v: unknown, f: (r: Record<string, unknown>) => T, max: number): T[] => (Array.isArray(v) ? v.slice(0, max).map((e) => f((e ?? {}) as Record<string, unknown>)) : [])
  return {
    id: /^[a-z0-9-]{8,64}$/i.test(str(o.id, 64)) ? str(o.id, 64) : crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    title: str(o.title, 140).trim() || enquiry.slice(0, 70),
    enquiry,
    steps,
    methods: list(o.methods, (r) => ({ name: str(r.name, 80), technique: str(r.technique, 120), rank: typeof r.rank === 'number' ? r.rank : undefined }), 12),
    premises: list(o.premises, (r) => ({ id: str(r.id, 60), severity: str(r.severity, 20), text: str(r.text, 600) }), 12),
    engine: str(o.engine, 80),
  }
}
