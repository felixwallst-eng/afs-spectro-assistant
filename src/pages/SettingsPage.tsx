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
  const hi = settings.confidentAt
  const lo = settings.uncertainAt
  const premiseAt = settings.premiseAt ?? DEFAULT_SETTINGS.premiseAt ?? 0.5
  const clef = (settings.engine ?? 'clef') === 'clef'
  return (
    <section className="panel" style={{ maxWidth: 820 }}>
      <div className="panel-head">
        <h2>Classification thresholds</h2>
      </div>
      <div className="panel-body">
        <p className="hint" style={{ marginBottom: 8 }}>
          For every step Clef picks a value and says how sure it is (0–100 %). These thresholds turn that confidence into what you see in
          the decision tree. They apply to the next analysis; entries in the history keep the result they were analysed with.
        </p>
        {!clef && (
          <p className="hint" style={{ marginBottom: 8 }}>
            The language model decides by majority vote and returns no confidence, so these thresholds only apply with the Clef classifier.
          </p>
        )}

        <div className="threshold-bar" aria-hidden="true">
          <span className="tb-open" style={{ width: `${lo * 100}%` }}>open question</span>
          <span className="tb-confirm" style={{ width: `${(hi - lo) * 100}%` }}>suggestion to confirm</span>
          <span className="tb-sure" style={{ width: `${(1 - hi) * 100}%` }}>decided</span>
        </div>
        <div className="threshold-scale" aria-hidden="true">
          <span>0 %</span>
          <span>100 %</span>
        </div>

        <div className={`setting${clef ? '' : ' off'}`}>
          <label htmlFor="confident">
            Decided
            <small>at or above this confidence</small>
          </label>
          <input
            id="confident"
            type="range"
            min={0.3}
            max={0.99}
            step={0.01}
            disabled={!clef}
            value={hi}
            onChange={(e) => setSettings({ ...settings, confidentAt: Math.max(Number(e.target.value), lo + 0.01) })}
          />
          <span>{pct(hi)}</span>
        </div>
        <p className="setting-help">
          A value Clef reads from the customer text with this confidence counts as stated by the customer and is drawn as a decided step. If
          Clef is this sure from the customer text and, with the AFS knowledge cards, this sure of a different value, the step is flagged as a
          conflict. Higher: fewer automatic decisions and more steps for you to confirm. Lower: faster, but more values are taken without a
          check.
        </p>

        <div className={`setting${clef ? '' : ' off'}`}>
          <label htmlFor="uncertain">
            Suggestion to confirm
            <small>from this confidence up to “Decided”</small>
          </label>
          <input
            id="uncertain"
            type="range"
            min={0}
            max={0.9}
            step={0.01}
            disabled={!clef}
            value={lo}
            onChange={(e) => setSettings({ ...settings, uncertainAt: Math.min(Number(e.target.value), hi - 0.01) })}
          />
          <span>{pct(lo)}</span>
        </div>
        <p className="setting-help">
          In this band the most likely value is shown as a suggestion (amber “action needed”) for you to accept or change. Below it the step is
          left open and the tree asks the clarification question for the customer. Higher: more open questions, fewer guesses. Lower: more
          suggestions, some of them weak.
        </p>

        <div className={`setting${clef ? '' : ' off'}`}>
          <label htmlFor="premise">
            Premise check
            <small>facts from this confidence on</small>
          </label>
          <input
            id="premise"
            type="range"
            min={0.1}
            max={0.95}
            step={0.01}
            disabled={!clef}
            value={premiseAt}
            onChange={(e) => setSettings({ ...settings, premiseAt: Number(e.target.value) })}
          />
          <span>{pct(premiseAt)}</span>
        </div>
        <p className="setting-help">
          Besides the tree steps Clef reads facts such as “reuses an existing calibration”, “analyzer in another building” or “asks for
          approval”. From this confidence on they feed the premise check (red “!” before the methods), which warns when the request relies on
          something the AFS rules contradict. A warning only asks you to check, so this is set lower than “Decided”. Lower: fewer missed
          premises, more false alarms. Higher: the reverse.
        </p>

        <h3 className="settings-sub">Who decides the tree steps</h3>
        <div className="model-choice">
          {(
            [
              ['clef', 'Clef classifier', 'Reproducible: the same enquiry always gives the same decision. Checks the customer text against the AFS knowledge cards and flags conflicts.'],
              ['llm', 'Language model', 'One model call per step, three runs with majority vote. Writes its own reasoning, but results can vary between runs.'],
            ] as const
          ).map(([k, label, note]) => (
            <label key={k} className={(settings.engine ?? 'clef') === k ? 'on' : ''}>
              <input type="radio" name="engine" checked={(settings.engine ?? 'clef') === k} onChange={() => setSettings({ ...settings, engine: k })} />
              <span>
                <strong>{label}</strong>
                <small>{note}</small>
              </span>
            </label>
          ))}
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
            Restore defaults ({pct(DEFAULT_SETTINGS.confidentAt)} / {pct(DEFAULT_SETTINGS.uncertainAt)} / {pct(DEFAULT_SETTINGS.premiseAt ?? 0.5)})
          </button>
          <span className="note">Saved in this browser. Classifier: Cloudflare Clef via Workers AI.</span>
        </div>
      </div>
    </section>
  )
}
