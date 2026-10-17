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
}

export const store = {
  history: () => load<HistoryEntry[]>('afs.history', []),
  saveHistory: (h: HistoryEntry[]) => save('afs.history', h.slice(0, 30)),
  settings: (fallback: Settings) => load<Settings>('afs.settings', fallback),
  saveSettings: (s: Settings) => save('afs.settings', s),
  methods: (fallback: MethodSetup[]) => load<MethodSetup[]>('afs.methods', fallback),
  saveMethods: (m: MethodSetup[]) => save('afs.methods', m),
}
