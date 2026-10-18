import { classify } from './clef.ts'
import { handleDocs } from './docs.ts'
import { runAgent, runBrief } from './agent.ts'
import { runTree } from './tree.ts'
import type { Thresholds } from '../shared/tree.ts'
import { runSteps } from './steps.ts'
import { runClefSteps } from './clefSteps.ts'
import { buildCards, deleteCard, getCards, resetCards } from './cards.ts'
import { listDocs } from './docs.ts'
import { handleCases } from './cases.ts'
import { runReport } from './report.ts'
import type { ReportInput } from '../shared/report.ts'
import type { AgentRequest } from '../shared/agent.ts'

const MAX_TEXT = 8000

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (url.pathname === '/api/classify' && request.method === 'POST') {
      let body: { text?: unknown; only?: unknown }
      try {
        body = await request.json()
      } catch {
        return Response.json({ error: 'Request body must be JSON: { "text": "..." }' }, { status: 400 })
      }
      const text = typeof body.text === 'string' ? body.text.trim() : ''
      if (!text) return Response.json({ error: 'Enter the customer enquiry text.' }, { status: 400 })
      if (text.length > MAX_TEXT) return Response.json({ error: `Text is too long (max ${MAX_TEXT} characters).` }, { status: 400 })
      const only = Array.isArray(body.only) ? body.only.filter((x): x is string => typeof x === 'string') : undefined
      try {
        return Response.json(await classify(env.AI, text, only))
      } catch (err) {
        return Response.json({ error: `Clef classification failed: ${err instanceof Error ? err.message : String(err)}` }, { status: 502 })
      }
    }

    if (url.pathname === '/api/tree' && request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as { text?: unknown; model?: unknown; pipeline?: unknown; sources?: unknown; fresh?: unknown; votes?: unknown; seedBase?: unknown; stepsOnly?: unknown; thresholds?: unknown; citations?: unknown } | null
      const text = typeof body?.text === 'string' ? body.text.trim().slice(0, MAX_TEXT) : ''
      if (!text) return Response.json({ error: 'Enter the customer enquiry text.' }, { status: 400 })
      const model = body?.model === 'qwen' || body?.model === 'kimi' ? body.model : 'gptoss'
      try {
        // "single": the earlier one-call pipeline, kept for comparison in the reproducibility test
        if (body?.pipeline === 'single') return Response.json(await runTree(env.AI, env.DOCS, { text, model }))
        if (body?.pipeline === 'clef')
          return Response.json(await runClefSteps(env.AI, env.DOCS, { text, sources: body?.sources === 'original' ? 'original' : 'all', thresholds: parseThresholds(body?.thresholds), citations: body?.citations === 'relevance' ? 'relevance' : 'support' }))
        return Response.json(
          await runSteps(env.AI, env.DOCS, {
            text,
            model,
            sources: body?.sources === 'original' ? 'original' : 'all',
            fresh: body?.fresh === true,
            votes: typeof body?.votes === 'number' ? Math.max(1, Math.min(5, Math.round(body.votes))) : undefined,
            seedBase: typeof body?.seedBase === 'number' ? Math.round(body.seedBase) : undefined,
            stepsOnly: body?.stepsOnly === true,
          }),
        )
      } catch (err) {
        return Response.json({ error: `Assessment failed: ${err instanceof Error ? err.message : String(err)}` }, { status: 502 })
      }
    }

    if (url.pathname === '/api/agent/brief' && request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as { text?: unknown; model?: unknown } | null
      const text = typeof body?.text === 'string' ? body.text.trim().slice(0, MAX_TEXT) : ''
      if (!text) return Response.json({ error: 'Send the enquiry text.' }, { status: 400 })
      try {
        return Response.json(await runBrief(env.AI, env.DOCS, { text, model: body?.model === 'qwen' || body?.model === 'kimi' ? body.model : 'gptoss' }))
      } catch (err) {
        return Response.json({ error: `Agent failed: ${err instanceof Error ? err.message : String(err)}` }, { status: 502 })
      }
    }

    if (url.pathname === '/api/agent' && request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as Partial<AgentRequest> | null
      const text = typeof body?.text === 'string' ? body.text.trim().slice(0, MAX_TEXT) : ''
      const dimensionIds = Array.isArray(body?.dimensionIds) ? body.dimensionIds.filter((x): x is string => typeof x === 'string') : []
      if (!text || !dimensionIds.length) return Response.json({ error: 'Send the enquiry text and the open dimension ids.' }, { status: 400 })
      try {
        return Response.json(await runAgent(env.AI, env.DOCS, { text, dimensionIds, model: body?.model }))
      } catch (err) {
        return Response.json({ error: `Agent failed: ${err instanceof Error ? err.message : String(err)}` }, { status: 502 })
      }
    }

    if (url.pathname === '/api/health') {
      return Response.json({ status: 'ok' })
    }

    // knowledge cards: /api/docs/:id/cards[/:cardId]
    const cardRoute = url.pathname.match(/^\/api\/docs\/([^/]+)\/cards(?:\/([^/]+))?$/)
    if (cardRoute) {
      const docId = decodeURIComponent(cardRoute[1])
      try {
        if (request.method === 'GET') {
          const set = await getCards(env.DOCS, docId)
          return set ? Response.json(set) : Response.json({ error: 'This document has not been read yet.' }, { status: 404 })
        }
        if (request.method === 'POST' && !cardRoute[2]) {
          const doc = (await listDocs(env.DOCS)).find((d) => d.id === docId)
          if (!doc) return Response.json({ error: 'Document not found.' }, { status: 404 })
          return Response.json(await buildCards(env.AI, env.DOCS, docId, doc.title))
        }
        if (request.method === 'DELETE' && !cardRoute[2]) {
          const set = await resetCards(env.DOCS, docId)
          return set ? Response.json(set) : Response.json({ error: 'No curated cards for this document.' }, { status: 404 })
        }
        if (request.method === 'DELETE' && cardRoute[2]) {
          const set = await deleteCard(env.DOCS, docId, decodeURIComponent(cardRoute[2]))
          return set ? Response.json(set) : Response.json({ error: 'No cards for this document.' }, { status: 404 })
        }
      } catch (err) {
        return Response.json({ error: `Reading the document failed: ${err instanceof Error ? err.message : String(err)}` }, { status: 502 })
      }
    }

    // written assessment from the decided path: /api/report
    if (url.pathname === '/api/report' && request.method === 'POST') {
      const raw = await request.text()
      if (raw.length > 200_000) return Response.json({ error: 'The assessment input is too large.' }, { status: 413 })
      const body = (() => {
        try {
          return JSON.parse(raw) as { input?: ReportInput; model?: unknown }
        } catch {
          return null
        }
      })()
      const input = body?.input
      if (!input || typeof input.enquiry !== 'string' || !Array.isArray(input.steps) || !Array.isArray(input.evidence))
        return Response.json({ error: 'Send the decided assessment as { input }.' }, { status: 400 })
      try {
        const key = body?.model === 'qwen' || body?.model === 'kimi' ? body.model : 'gptoss'
        return Response.json(await runReport(env.AI, env.DOCS, input, key))
      } catch (err) {
        return Response.json({ error: `Writing the assessment failed: ${err instanceof Error ? err.message : String(err)}` }, { status: 502 })
      }
    }

    // solved cases added by the expert: /api/cases[/:id]
    const caseRoute = url.pathname.match(/^\/api\/cases(?:\/([^/]+))?$/)
    if (caseRoute) {
      try {
        const res = await handleCases(request, env.DOCS, caseRoute[1] ? decodeURIComponent(caseRoute[1]) : undefined)
        if (res) return res
      } catch (err) {
        return Response.json({ error: `Saving the case failed: ${err instanceof Error ? err.message : String(err)}` }, { status: 500 })
      }
    }

    if (url.pathname.startsWith('/api/docs')) {
      try {
        const res = await handleDocs(request, env.DOCS)
        if (res) return res
      } catch (err) {
        return Response.json({ error: `Knowledge base request failed: ${err instanceof Error ? err.message : String(err)}` }, { status: 500 })
      }
    }

    if (url.pathname.startsWith('/api/')) {
      return Response.json({ error: 'Not found' }, { status: 404 })
    }

    return new Response(null, { status: 404 })
  },
} satisfies ExportedHandler<Env>

/** Thresholds from the settings page, clamped to sensible ranges; anything invalid falls back to the defaults. */
function parseThresholds(x: unknown): Thresholds | undefined {
  if (!x || typeof x !== 'object') return undefined
  const o = x as Record<string, unknown>
  const num = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null)
  const confidentAt = num(o.confidentAt, 0.3, 0.99)
  const uncertainAt = num(o.uncertainAt, 0, 0.9)
  const premiseAt = num(o.premiseAt, 0.1, 0.95)
  if (confidentAt === null || uncertainAt === null || premiseAt === null || uncertainAt >= confidentAt) return undefined
  return { confidentAt, uncertainAt, premiseAt }
}
