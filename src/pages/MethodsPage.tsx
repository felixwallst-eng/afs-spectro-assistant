import { BASE_METHODS, METHOD_INFO, knowledgeVersion } from '../../shared/knowledge.ts'
import type { Level, MethodKey, MethodSetup } from '../../shared/types.ts'

interface Props {
  methods: MethodSetup[]
  setMethods: (m: MethodSetup[]) => void
}

const LEVELS: Level[] = ['low', 'average', 'high']

export default function MethodsPage({ methods, setMethods }: Props) {
  const update = (i: number, patch: Partial<MethodSetup>) => setMethods(methods.map((m, j) => (j === i ? { ...m, ...patch } : m)))
  const edited = knowledgeVersion(methods) !== knowledgeVersion(BASE_METHODS)

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Method table</h2>
        <span className="hint">The rule engine uses this table for every assessment. Source: S01 Table 1 (p.6).</span>
      </div>
      <div className="panel-body">
        <div className="toolbar">
          <button
            className="btn"
            onClick={() =>
              setMethods([
                ...methods,
                { ...BASE_METHODS[0], id: `custom-${Date.now()}`, technique: 'New setup', sampleTypes: ['liquid'], citation: { source: 'Expert' } },
              ])
            }
          >
            Add setup
          </button>
          <button className="btn" disabled={!edited} onClick={() => setMethods(BASE_METHODS)}>
            Reset to AFS table
          </button>
          <span className="note">
            Version {knowledgeVersion(methods)}
            {edited ? ' · edited in this browser – assessments show this version so results stay traceable' : ' · original AFS table'}
          </span>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Method</th>
                <th>Technique</th>
                <th>Phenomenon</th>
                <th>Sample types</th>
                <th>Path / depth (µm)</th>
                <th>Sensitivity</th>
                <th>Selectivity</th>
                <th>Cost</th>
                <th>Lab only</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {methods.map((m, i) => (
                <tr key={m.id}>
                  <td>
                    <select value={m.method} onChange={(e) => update(i, { method: e.target.value as MethodKey })}>
                      {(Object.keys(METHOD_INFO) as MethodKey[]).map((k) => (
                        <option key={k} value={k}>
                          {METHOD_INFO[k].name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input value={m.technique} onChange={(e) => update(i, { technique: e.target.value })} />
                  </td>
                  <td>
                    <input value={m.phenomenon} onChange={(e) => update(i, { phenomenon: e.target.value })} />
                  </td>
                  <td>
                    <input
                      value={m.sampleTypes.join(', ')}
                      onChange={(e) => update(i, { sampleTypes: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
                    />
                  </td>
                  <td>
                    <input
                      value={m.depthUm ? `${m.depthUm[0]}–${m.depthUm[1]}` : 'any'}
                      onChange={(e) => {
                        const n = e.target.value.match(/[\d.]+/g)?.map(Number)
                        update(i, { depthUm: n && n.length ? [n[0], n[1] ?? n[0]] : null })
                      }}
                    />
                  </td>
                  {(['sensitivity', 'selectivity', 'cost'] as const).map((k) => (
                    <td key={k}>
                      <select value={m[k]} onChange={(e) => update(i, { [k]: e.target.value as Level })}>
                        {LEVELS.map((l) => (
                          <option key={l}>{l}</option>
                        ))}
                      </select>
                    </td>
                  ))}
                  <td style={{ textAlign: 'center' }}>
                    <input type="checkbox" style={{ width: 'auto' }} checked={m.labOnly} onChange={(e) => update(i, { labOnly: e.target.checked })} aria-label="Laboratory only" />
                  </td>
                  <td>
                    <button className="linkbtn" onClick={() => setMethods(methods.filter((_, j) => j !== i))}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  )
}
