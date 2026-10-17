import { classify } from './clef.ts'

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

    if (url.pathname === '/api/health') {
      return Response.json({ status: 'ok' })
    }

    if (url.pathname.startsWith('/api/')) {
      return Response.json({ error: 'Not found' }, { status: 404 })
    }

    return new Response(null, { status: 404 })
  },
} satisfies ExportedHandler<Env>
