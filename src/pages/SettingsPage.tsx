import { AGENT_MODELS } from '../../shared/agent.ts'
import type { AgentModelKey } from '../../shared/agent.ts'
import { DEFAULT_SETTINGS } from '../../shared/types.ts'
import type { Settings } from '../../shared/types.ts'

interface Props {
  settings: Settings
  setSettings: (s: Settings) => void
}

export default function SettingsPage({ settings, setSettings }: Props) {
  const pct = (n: number) => `${Math.round(n * 100)} %`
  return (
    <section className="panel" style={{ maxWidth: 820 }}>
      <div className="panel-head">
        <h2>Classification thresholds</h2>
      </div>
      <div className="panel-body">
        <p className="hint" style={{ marginBottom: 8 }}>
          Clef returns a confidence for every dimension. These thresholds decide when a value is used as is, when the expert is asked to
          confirm it, and when it counts as unknown and becomes an open question.
        </p>
        <div className="setting">
          <label htmlFor="confident">
            Use value directly
            <small>at or above this confidence</small>
          </label>
          <input
            id="confident"
            type="range"
            min={0.3}
            max={0.99}
            step={0.01}
            value={settings.confidentAt}
            onChange={(e) => setSettings({ ...settings, confidentAt: Math.max(Number(e.target.value), settings.uncertainAt + 0.01) })}
          />
          <span>{pct(settings.confidentAt)}</span>
        </div>
        <div className="setting">
          <label htmlFor="uncertain">
            Ask the expert to confirm
            <small>between this and the value above; below counts as unknown</small>
          </label>
          <input
            id="uncertain"
            type="range"
            min={0}
            max={0.9}
            step={0.01}
            value={settings.uncertainAt}
            onChange={(e) => setSettings({ ...settings, uncertainAt: Math.min(Number(e.target.value), settings.confidentAt - 0.01) })}
          />
          <span>{pct(settings.uncertainAt)}</span>
        </div>
        <h3 className="settings-sub">Knowledge agent model</h3>
        <p className="hint" style={{ marginBottom: 8 }}>
          All models have open weights, so the same model can later run on AFS hardware without sending enquiries to a third party. In
          this prototype they are hosted on Cloudflare Workers AI.
        </p>
        <div className="model-choice">
          {(Object.keys(AGENT_MODELS) as AgentModelKey[]).map((k) => (
            <label key={k} className={settings.agentModel === k ? 'on' : ''}>
              <input type="radio" name="agent-model" checked={settings.agentModel === k} onChange={() => setSettings({ ...settings, agentModel: k })} />
              <span>
                <strong>{AGENT_MODELS[k].name}</strong>
                <small>{AGENT_MODELS[k].note}</small>
              </span>
            </label>
          ))}
        </div>
        <div className="toolbar" style={{ marginTop: 16 }}>
          <button className="btn" onClick={() => setSettings(DEFAULT_SETTINGS)}>
            Restore defaults ({pct(DEFAULT_SETTINGS.confidentAt)} / {pct(DEFAULT_SETTINGS.uncertainAt)})
          </button>
          <span className="note">Saved in this browser. Classifier: Cloudflare Clef via Workers AI.</span>
        </div>
      </div>
    </section>
  )
}
