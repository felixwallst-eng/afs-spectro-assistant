import { useEffect, useState } from 'react'
import { BASE_METHODS, knowledgeVersion } from '../shared/knowledge.ts'
import { DEFAULT_SETTINGS } from '../shared/types.ts'
import type { MethodSetup, Settings } from '../shared/types.ts'
import { ensureOriginalsIndexed, store } from './lib.ts'
import { extractPageTextsFromUrl } from './pdfText.ts'
import SourceViewer from './components/SourceViewer.tsx'
import type { SourceRef } from './sources.ts'
import { SourceContext } from './sourceContext.ts'
import AssessPage from './pages/AssessPage.tsx'
import KnowledgePage from './pages/KnowledgePage.tsx'
import MethodsPage from './pages/MethodsPage.tsx'
import SettingsPage from './pages/SettingsPage.tsx'

const TABS = [
  { id: 'assess', label: 'Assessment' },
  { id: 'knowledge', label: 'Knowledge base' },
  { id: 'methods', label: 'Method table' },
  { id: 'settings', label: 'Settings' },
] as const
type TabId = (typeof TABS)[number]['id']

export default function App() {
  const [tab, setTab] = useState<TabId>('assess')
  // a solved case to open in the knowledge base (sent by the similar-case hint on the assessment page)
  const [focusCase, setFocusCase] = useState<string | null>(null)
  useEffect(() => {
    const onOpen = (e: Event) => {
      const id = (e as CustomEvent<string>).detail
      if (!id) return
      setFocusCase(id)
      setTab('knowledge')
    }
    window.addEventListener('afs:open-case', onOpen)
    return () => window.removeEventListener('afs:open-case', onOpen)
  }, [])
  const [source, setSource] = useState<SourceRef | null>(null)
  const [settings, setSettingsState] = useState<Settings>(() => {
    const saved = { ...DEFAULT_SETTINGS, ...store.settings(DEFAULT_SETTINGS) }
    // saved thresholds from before a default change are replaced by the new defaults
    return saved.thresholdsVersion === DEFAULT_SETTINGS.thresholdsVersion
      ? saved
      : { ...saved, confidentAt: DEFAULT_SETTINGS.confidentAt, uncertainAt: DEFAULT_SETTINGS.uncertainAt, premiseAt: DEFAULT_SETTINGS.premiseAt, thresholdsVersion: DEFAULT_SETTINGS.thresholdsVersion }
  })
  const [methods, setMethodsState] = useState<MethodSetup[]>(() => store.methods(BASE_METHODS))

  // make the bundled AFS PDFs searchable for the knowledge agent (runs once, skips indexed ones)
  useEffect(() => {
    void ensureOriginalsIndexed(extractPageTextsFromUrl).catch((e) => console.warn('Indexing skipped:', e))
  }, [])

  const setSettings = (s: Settings) => {
    setSettingsState(s)
    store.saveSettings(s)
  }
  const setMethods = (m: MethodSetup[]) => {
    setMethodsState(m)
    store.saveMethods(m)
  }

  return (
    <SourceContext.Provider value={setSource}>
      <header className="topbar">
        <div className="brand">
          <strong>AFS Spectroscopy Assessment</strong>
          <span>by Team Hallucination Nation</span>
        </div>
        <nav className="tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} role="tab" className="tab" aria-selected={tab === t.id} onClick={() => (setTab(t.id), setFocusCase(null))}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="meta">Knowledge {knowledgeVersion(methods)}</div>
      </header>
      <main className="page">
        {/* kept mounted so the current case survives tab switches */}
        <div hidden={tab !== 'assess'}>
          <AssessPage settings={settings} methods={methods} />
        </div>
        {tab === 'knowledge' && <KnowledgePage key={focusCase ?? 'kb'} focusCase={focusCase} />}
        {tab === 'methods' && <MethodsPage methods={methods} setMethods={setMethods} />}
        {tab === 'settings' && <SettingsPage settings={settings} setSettings={setSettings} />}
      </main>
      <footer className="site-foot">
        <span>
          Greetings from Karlsruhe <span aria-label="castle" role="img">🏰</span>
        </span>
        <span className="sep">·</span>
        <span>
          Made by <strong>Team Hallucination Nation</strong>
        </span>
        <span className="sep">·</span>
        <span>National AI Hackathon 2026 by SchubKI for Art Fiber Systems</span>
      </footer>
      {source && <SourceViewer key={JSON.stringify(source)} refTo={source} onClose={() => setSource(null)} />}
    </SourceContext.Provider>
  )
}
