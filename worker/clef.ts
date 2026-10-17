import { DIMENSIONS } from '../shared/dimensions.ts'
import type { ClassifyResponse, RawDimension } from '../shared/types.ts'

export const CLEF_MODEL = '@cf/cloudflare/clef'

type ClefRunner = { run: (model: string, input: unknown) => Promise<unknown> }

interface ClefChoiceAnswer {
  type?: string
  choice?: string
  probabilities?: Record<string, number>
  confidence?: number
}

/** One Clef call answers every dimension (max 64 questions per request). */
export async function classify(ai: unknown, text: string, only?: string[]): Promise<ClassifyResponse> {
  const defs = only?.length ? DIMENSIONS.filter((d) => only.includes(d.id)) : DIMENSIONS
  const questions = Object.fromEntries(
    defs.map((d) => [
      d.id,
      {
        type: 'choice',
        instructions: d.question,
        criteria: Object.fromEntries(Object.entries(d.labels).map(([k, l]) => [k, l.description])),
      },
    ]),
  )

  const started = Date.now()
  const result = (await (ai as ClefRunner).run(CLEF_MODEL, { model: 'clef', state: text, questions })) as {
    model?: string
    answers?: Record<string, ClefChoiceAnswer>
    usage?: ClassifyResponse['usage']
  }
  const latencyMs = Date.now() - started

  const dimensions: Record<string, RawDimension> = {}
  for (const d of defs) {
    const a = result.answers?.[d.id]
    if (!a?.choice) continue
    const probs = a.probabilities ?? {}
    dimensions[d.id] = {
      id: d.id,
      value: a.choice,
      // Clef returns a calibrated confidence; fall back to the choice probability
      confidence: typeof a.confidence === 'number' ? a.confidence : (probs[a.choice] ?? 0),
      probabilities: probs,
    }
  }
  return { model: `${CLEF_MODEL} (${result.model ?? 'clef'})`, dimensions, latencyMs, usage: result.usage }
}
