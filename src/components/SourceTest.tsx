import { useOpenSource } from '../sourceContext.ts'
import type { SourceRef } from '../sources.ts'

/** Test links: open an AFS PDF at the cited page and highlight the quoted passage. */
const SAMPLES: (SourceRef & { label: string })[] = [
  {
    label: 'NIR reflection for opaque dairy products',
    source: 'S01',
    page: 17,
    quote: 'Inline NIR Reflection is primarily used for opaque or highly concentrated dairy products, such as yogurt, butter, or whole milk concentrates.',
  },
  {
    label: 'Raman in aqueous media',
    source: 'S01',
    page: 16,
    quote: 'Raman is particularly well-suited for aqueous environments, as it exhibits low absorbance for water molecules compared to infrared methods.',
  },
  {
    label: 'Same-spot measurement on heterogeneous samples',
    source: 'S01',
    page: 8,
    quote: 'It is crucial that the spectral information obtained by different methods—Mid-IR, NIR, Raman, and fluorescence spectra—is collected from the same small, even pinpoint, area of the sample.',
  },
  {
    label: 'Fiber transmission ranges (slide without text layer)',
    source: 'S02',
    page: 6,
  },
]

export default function SourceTest() {
  const open = useOpenSource()
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Source links – test</h2>
        <span className="hint">Click a source: the PDF opens at the page and the quoted passage is highlighted.</span>
      </div>
      <div className="panel-body">
        <ul className="source-test">
          {SAMPLES.map((s) => (
            <li key={s.label}>
              <span>{s.label}</span>
              <button className="cite cite-link" onClick={() => open(s)}>
                {s.source} p.{s.page}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
