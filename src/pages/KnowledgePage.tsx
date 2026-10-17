import { FIBERS, SOURCES } from '../../shared/knowledge.ts'

export default function KnowledgePage() {
  return (
    <div className="stack">
      <section className="panel">
        <div className="panel-head">
          <h2>AFS source material</h2>
          <span className="hint">Every recommendation cites one of these documents with page number.</span>
        </div>
        <div className="panel-body">
          <div className="sources">
            {SOURCES.map((s) => (
              <div key={s.id} className="source">
                <span className="id">{s.id}</span>
                {s.title}
                <p>
                  {s.kind}. {s.use}
                </p>
              </div>
            ))}
          </div>
          <div className="dropzone" aria-disabled="true">
            <strong>Add studies and application notes</strong>
            Planned: upload PDFs to extend the knowledge base. Uploaded documents would be indexed and cited as external sources, with the
            quoted passage, next to the AFS material. Not active in this prototype.
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Fiber transmission ranges</h2>
          <span className="hint">Used to check whether a fiber link can carry a method's spectral range. Source: S02 p.6.</span>
        </div>
        <div className="panel-body table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Fiber family</th>
                <th>Approximate transmission</th>
              </tr>
            </thead>
            <tbody>
              {FIBERS.map((f) => (
                <tr key={f.id}>
                  <td>{f.name}</td>
                  <td>
                    {f.rangeUm[0]}–{f.rangeUm[1]} µm
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
