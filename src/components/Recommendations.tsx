import { FIBERS, METHOD_INFO } from '../../shared/knowledge.ts'
import CiteLink from './CiteLink.tsx'
import type { Assessment, Candidate, MethodKey } from '../../shared/types.ts'

const DECISION_TEXT = {
  provisional: 'Provisional assessment',
  insufficient_information: 'Insufficient information for a method decision',
  out_of_scope: 'Outside the supported scope',
}
const EFFECT_SYM = { plus: '+', minus: '−', condition: '!', exclude: '×', info: 'i' }
const METHOD_COLOR: Record<MethodKey, string> = { uvvis: '#5b2a9c', fluorescence: '#2d4fd0', raman: '#1b9a8a', nir: '#d8642a', ir: '#8c1f30' }


function CandidateCard({ c }: { c: Candidate }) {
  const s = c.setup
  return (
    <div className="cand">
      <div className="cand-head">
        <strong>{METHOD_INFO[s.method].name}</strong>
        <span className="tech">{s.technique}</span>
        <span className="specs">
          <span>sensitivity {s.sensitivity}</span>
          <span>selectivity {s.selectivity}</span>
          <span>cost {s.cost}</span>
          {s.depthUm && <span>path {s.depthUm[0] >= 1000 ? `${s.depthUm[0] / 1000}–${s.depthUm[1] / 1000} mm` : `${s.depthUm[0]}–${s.depthUm[1]} µm`}</span>}
        </span>
      </div>
      <ul className="reasons">
        {c.reasons.map((r, i) => (
          <li key={i}>
            <span className={`e ${r.effect}`} aria-label={r.effect}>
              {EFFECT_SYM[r.effect]}
            </span>
            <span>{r.text}</span>
            <CiteLink c={r.citation} />
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Log-scale wavelength ruler: which spectral range each shortlisted method needs, and what the fiber carries. */
function SpectrumRuler({ methods, fiber }: { methods: MethodKey[]; fiber?: [number, number] }) {
  const min = Math.log10(0.15)
  const max = Math.log10(30)
  const x = (um: number) => ((Math.log10(um) - min) / (max - min)) * 100
  const ticks = [0.2, 0.5, 1, 2, 5, 10, 20]
  return (
    <div className="ruler-wrap" style={{ marginBottom: 18 }}>
      {methods.map((m) => {
        const [a, b] = METHOD_INFO[m].rangeUm
        return (
          <div key={m} style={{ display: 'grid', gridTemplateColumns: '130px 1fr', alignItems: 'center', gap: 10, height: 20 }}>
            <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{METHOD_INFO[m].name}</span>
            <div style={{ position: 'relative', height: 8 }}>
              {fiber && <div style={{ position: 'absolute', left: `${x(fiber[0])}%`, width: `${x(fiber[1]) - x(fiber[0])}%`, top: -6, bottom: -6, background: 'repeating-linear-gradient(135deg, #d8dee5 0 4px, transparent 4px 8px)' }} />}
              <div style={{ position: 'absolute', left: `${x(a)}%`, width: `${x(b) - x(a)}%`, top: 0, bottom: 0, borderRadius: 2, background: METHOD_COLOR[m] }} title={METHOD_INFO[m].rangeText} />
            </div>
          </div>
        )
      })}
      <div style={{ display: 'grid', gridTemplateColumns: '130px 1fr', gap: 10 }}>
        <span style={{ fontSize: 11, color: 'var(--faint)' }}>{fiber ? 'hatched: existing silica link' : ''}</span>
        <div style={{ position: 'relative', height: 18, borderTop: '1px solid var(--line)', marginTop: 4 }}>
          {ticks.map((t) => (
            <span key={t} style={{ position: 'absolute', left: `${x(t)}%`, transform: 'translateX(-50%)', fontSize: 11, color: 'var(--faint)', top: 2 }}>
              {t} µm
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

export default function Recommendations({ assessment }: { assessment: Assessment }) {
  const { candidates, warnings, decisionStatus, decisionReasons } = assessment
  const rec = candidates.filter((c) => c.status === 'recommended')
  const cond = candidates.filter((c) => c.status === 'conditional')
  const excl = candidates.filter((c) => c.status === 'excluded')
  const shortlisted = [...new Set((rec.length ? rec : cond).map((c) => c.setup.method))]
  const v = assessment.dimensions
  const silica = v.reuse_fiber?.value === 'yes' && v.existing_fiber_type?.value === 'silica_uv_vis_nir' ? FIBERS.find((f) => f.id === 'silica_vis_nir')!.rangeUm : undefined
  const proposed: MethodKey[] = (
    [['ir', 'proposed_mir_atr'], ['nir', 'proposed_nir'], ['raman', 'proposed_raman'], ['fluorescence', 'proposed_fluorescence'], ['uvvis', 'proposed_uv_vis']] as const
  )
    .filter(([, id]) => v[id]?.value === 'yes')
    .map(([m]) => m)
  const rulerMethods = [...new Set([...shortlisted, ...proposed])]

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Recommendation</h2>
        <span className="hint">Every statement links to the AFS source it is based on.</span>
        <span className="right hint">{assessment.knowledgeVersion}</span>
      </div>
      <div className="panel-body">
        <div className={`decision ${decisionStatus}`}>
          <div>
            <strong>{DECISION_TEXT[decisionStatus]}</strong>
            <ul>
              {decisionReasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        </div>

        {warnings.length > 0 && (
          <ul className="warnings">
            {warnings.map((w) => (
              <li key={w.id} className={w.severity}>
                <span className="sym">{w.severity === 'block' ? '×' : '!'}</span>
                <span style={{ flex: 1 }}>{w.text}</span>
                {w.citation && <CiteLink c={w.citation} />}
              </li>
            ))}
          </ul>
        )}

        {rulerMethods.length > 0 && <SpectrumRuler methods={rulerMethods} fiber={silica} />}

        <div className="cand-group">
          <h3>
            <span className="chip recommended">Worth testing</span> {rec.length} setup{rec.length === 1 ? '' : 's'}
          </h3>
          {rec.length ? rec.map((c) => <CandidateCard key={c.setup.id} c={c} />) : <p className="hint">No setup meets all stated facts without conditions.</p>}
        </div>
        {cond.length > 0 && (
          <div className="cand-group">
            <h3>
              <span className="chip conditional">Only under conditions</span> {cond.length} setups
            </h3>
            {cond.map((c) => (
              <CandidateCard key={c.setup.id} c={c} />
            ))}
          </div>
        )}
        {excl.length > 0 && (
          <div className="cand-group">
            <details className="excluded-list">
              <summary>
                <span className="chip excluded">Excluded</span> {excl.length} setups – show reasons
              </summary>
              <div style={{ marginTop: 8 }}>
                {excl.map((c) => (
                  <CandidateCard key={c.setup.id} c={c} />
                ))}
              </div>
            </details>
          </div>
        )}
      </div>
    </section>
  )
}
