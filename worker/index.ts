import { classify } from './clef.ts'
import { handleDocs } from './docs.ts'
import { runAgent, runBrief } from './agent.ts'
import { runTree } from './tree.ts'
import { runSteps } from './steps.ts'
import { runClefSteps } from './clefSteps.ts'
import { buildCards, deleteCard, getCards, resetCards } from './cards.ts'
import { listDocs } from './docs.ts'
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
      const body = (await request.json().catch(() => null)) as { text?: unknown; model?: unknown; pipeline?: unknown; sources?: unknown; fresh?: unknown; votes?: unknown; seedBase?: unknown; stepsOnly?: unknown } | null
      const text = typeof body?.text === 'string' ? body.text.trim().slice(0, MAX_TEXT) : ''
      if (!text) return Response.json({ error: 'Enter the customer enquiry text.' }, { status: 400 })
      const model = body?.model === 'qwen' || body?.model === 'kimi' ? body.model : 'gptoss'
      try {
        // "single": the earlier one-call pipeline, kept for comparison in the reproducibility test
        if (body?.pipeline === 'single') return Response.json(await runTree(env.AI, env.DOCS, { text, model }))
        if (body?.pipeline === 'clef') return Response.json(await runClefSteps(env.AI, env.DOCS, { text, sources: body?.sources === 'original' ? 'original' : 'all' }))
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
