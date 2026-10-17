import { useState } from 'react'
import { BASE_METHODS, knowledgeVersion } from '../shared/knowledge.ts'
import { DEFAULT_SETTINGS } from '../shared/types.ts'
import type { MethodSetup, Settings } from '../shared/types.ts'
import { store } from './lib.ts'
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
  const [settings, setSettingsState] = useState<Settings>(() => store.settings(DEFAULT_SETTINGS))
  const [methods, setMethodsState] = useState<MethodSetup[]>(() => store.methods(BASE_METHODS))

  const setSettings = (s: Settings) => {
    setSettingsState(s)
    store.saveSettings(s)
  }
  const setMethods = (m: MethodSetup[]) => {
    setMethodsState(m)
    store.saveMethods(m)
  }

  return (
    <>
      <div className="spectrum" aria-hidden="true" />
      <header className="topbar">
        <div className="brand">
          <strong>Spectroscopy Assessment</strong>
          <span>First technical review of in-line measurement enquiries</span>
        </div>
        <nav className="tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} role="tab" className="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
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
        {tab === 'knowledge' && <KnowledgePage />}
        {tab === 'methods' && <MethodsPage methods={methods} setMethods={setMethods} />}
        {tab === 'settings' && <SettingsPage settings={settings} setSettings={setSettings} />}
      </main>
    </>
  )
}
