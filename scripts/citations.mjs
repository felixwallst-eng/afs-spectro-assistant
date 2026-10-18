// Citation quality on the development cases: are the references shown per step relevant for this customer?
// Scores the runs saved by repro.mjs (field `cites`) against eval/gold/citation_gold.json.
//
//   node scripts/repro.mjs --experiments clef,clef-relevance --runs 1    # new vs earlier citations, D01–D08
//   node scripts/citations.mjs                                           # newest file with citation traces
//   node scripts/citations.mjs eval/results/<file> --show                # also print every reference and reasoning

import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const show = args.includes('--show')
const fileArg = args.find((a) => a.endsWith('.json'))
const dir = 'eval/results'
const file =
  fileArg ??
  fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('repro-') && f.endsWith('.json'))
    .sort()
    .reverse()
    .map((f) => path.join(dir, f))
    .find((f) => Object.values(JSON.parse(fs.readFileSync(f, 'utf8')).raw ?? {}).some((runs) => runs.some((r) => r.cites && r.case.startsWith('D'))))
if (!file) {
  console.error('No result file with citation traces. Run first:  node scripts/repro.mjs --experiments clef,clef-relevance --runs 1')
  process.exit(1)
}
const gold = JSON.parse(fs.readFileSync('eval/gold/citation_gold.json', 'utf8')).cases
const data = JSON.parse(fs.readFileSync(file, 'utf8'))
console.log(`\nCitation quality on the development cases (${file})\n`)
console.log('Setup                       │ refs shown  per step │ relevant (precision) │ expected found (recall) │ steps with quote')
for (const [exp, runs] of Object.entries(data.raw ?? {})) {
  const seen = new Set()
  let shown = 0, relevant = 0, expected = 0, found = 0, steps = 0, withQuote = 0, stated = 0
  const wrong = []
  for (const r of runs) {
    if (!r.cites || !r.case.startsWith('D') || seen.has(r.case)) continue
    seen.add(r.case)
    for (const [id, c] of Object.entries(r.cites)) {
      const g = gold[r.case]?.[id]
      if (!g || !c) continue
      steps++
      const ok = new Set([...g.show, ...g.ok])
      shown += c.refs.length
      relevant += c.refs.filter((x) => ok.has(x)).length
      expected += g.show.length
      found += g.show.filter((x) => c.refs.includes(x)).length
      for (const x of c.refs) if (!ok.has(x)) wrong.push(`${r.case} ${id}: ${x}`)
      if (String(r.steps?.[id] ?? '').startsWith('stated')) {
        stated++
        if (c.quote) withQuote++
      }
      if (show) console.log(`   ${exp} ${r.case} ${id} [${c.refs.join(', ')}]${c.quote ? `  quote: “${c.quote}”` : ''}\n      ${c.reasoning}`)
    }
  }
  if (!steps) continue
  const pct = (a, b) => (b ? `${Math.round((100 * a) / b)} %` : 'n/a')
  console.log(
    `${exp.padEnd(28)}│ ${String(shown).padStart(10)}  ${(shown / steps).toFixed(1).padStart(8)} │ ${`${relevant}/${shown}  ${pct(relevant, shown)}`.padStart(20)} │ ${`${found}/${expected}  ${pct(found, expected)}`.padStart(23)} │ ${`${withQuote}/${stated}`.padStart(16)}`,
  )
  if (wrong.length) console.log(`   not relevant: ${wrong.join('; ')}`)
}
