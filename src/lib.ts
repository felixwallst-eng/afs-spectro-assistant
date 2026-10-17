import type { TreeResponse } from '../shared/tree.ts'
import type { AgentModelKey, AgentResponse, BriefResponse } from '../shared/agent.ts'
import type { DocMeta, DocPatch } from '../shared/docs.ts'
import type { ClassifyResponse, MethodSetup, RawDimension, Settings } from '../shared/types.ts'

export async function classifyText(text: string, only?: string[]): Promise<ClassifyResponse> {
  const res = await fetch('/api/classify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, only }),
  })
  const data = await res.json().catch(() => ({ error: `Server returned ${res.status}` }))
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Server returned ${res.status}`)
  return data as ClassifyResponse
}

// ------------------------------------------------------------ local storage
// Per-browser convenience only (history, settings, edited method table).

function load<T>(key: string, fallback: T): T {
  try {
    const s = localStorage.getItem(key)
    return s ? (JSON.parse(s) as T) : fallback
  } catch {
    return fallback
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage unavailable */
  }
}

export interface HistoryEntry {
  id: string
  title: string
  text: string
  raw: Record<string, RawDimension>
  overrides: Record<string, string>
  model: string
  createdAt: string
  /** Evidence-backed decisions from the tree endpoint (absent in old entries). */
  tree?: TreeResponse
}

export const store = {
  history: () => load<HistoryEntry[]>('afs.history', []),
  saveHistory: (h: HistoryEntry[]) => save('afs.history', h.slice(0, 30)),
  settings: (fallback: Settings) => load<Settings>('afs.settings', fallback),
  saveSettings: (s: Settings) => save('afs.settings', s),
  methods: (fallback: MethodSetup[]) => load<MethodSetup[]>('afs.methods', fallback),
  saveMethods: (m: MethodSetup[]) => save('afs.methods', m),
}

// ------------------------------------------------------------ knowledge base

async function api<T>(res: Promise<Response>): Promise<T> {
  const r = await res
  const data = await r.json().catch(() => ({ error: `Server returned ${r.status}` }))
  if (!r.ok) throw new Error((data as { error?: string }).error ?? `Server returned ${r.status}`)
  return data as T
}

export const docsApi = {
  list: () => api<DocMeta[]>(fetch('/api/docs')),
  upload: (file: File, pageTexts: string[], fields: { title?: string; summary?: string; notes?: string }) => {
    const form = new FormData()
    form.append('file', file)
    form.append('pageTexts', JSON.stringify(pageTexts))
    Object.entries(fields).forEach(([k, v]) => v && form.append(k, v))
    return api<DocMeta>(fetch('/api/docs', { method: 'POST', body: form }))
  },
  update: (id: string, patch: DocPatch) =>
    api<DocMeta>(fetch(`/api/docs/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })),
  remove: (id: string) => api<{ deleted: string }>(fetch(`/api/docs/${encodeURIComponent(id)}`, { method: 'DELETE' })),
}

export type AgentState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'done'; data: AgentResponse }

export const agentApi = {
  brief: (text: string, model: AgentModelKey) =>
    api<BriefResponse>(fetch('/api/agent/brief', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, model }) })),
  suggest: (text: string, dimensionIds: string[], model: AgentModelKey) =>
    api<AgentResponse>(
      fetch('/api/agent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, dimensionIds, model }) }),
    ),
}

export const treeApi = {
  run: (text: string, model: AgentModelKey) =>
    api<TreeResponse>(fetch('/api/tree', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, model }) })),
}

/** Index bundled original PDFs (page texts -> KV) so the agent can search and cite them. */
export async function ensureOriginalsIndexed(extract: (url: string) => Promise<string[]>) {
  const docs = await docsApi.list()
  for (const d of docs.filter((x) => x.origin === 'original' && !x.indexed)) {
    try {
      const pages = await extract(d.url)
      await api(fetch(`/api/docs/${encodeURIComponent(d.id)}/text`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(pages) }))
    } catch (e) {
      console.warn(`Could not index ${d.id}:`, e)
    }
  }
}
