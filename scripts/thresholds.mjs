// Threshold study for the Clef pipeline – no model calls.
// Re-applies the decision rules of worker/clefSteps.ts to the raw Clef answers saved by repro.mjs
// (field `clef` in each run) for a grid of thresholds, and scores the development cases against
// eval/gold/assessment_gold.json. Choose the thresholds on D only; the final cases are reported, not tuned.
//
//   node scripts/thresholds.mjs                       # newest result file with D cases
//   node scripts/thresholds.mjs eval/results/<file>   # a given file
//   node scripts/thresholds.mjs --final <file>        # also show how H cases would be distributed (report only)

import fs from 'node:fs'
import path from 'node:path'

const SOURCE_STEPS = new Set(['sample_state', 'interface_mode', 'target_property_type', 'optical_variability'])
const STATED_ONLY = new Set(['spectral_range'])
const UNKNOWN = 'not_stated'

const args = process.argv.slice(2)
const finalIdx = args.indexOf('--final')
const finalFile = finalIdx >= 0 ? args.splice(finalIdx, 2)[1] : null
const dir = 'eval/results'
const newestWith = (pred) =>
  fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('repro-') && f.endsWith('.json'))
    .sort()
    .reverse()
    .map((f) => path.join(dir, f))
    .find((f) => pred(JSON.parse(fs.readFileSync(f, 'utf8'))))
const hasTrace = (d) => (d.raw?.clef ?? []).some((r) => r.clef && r.case.startsWith('D'))
const file = args[0] ?? newestWith(hasTrace)
if (!file) {
  console.error('No result file with Clef traces for the D cases. Run first:  node scripts/repro.mjs --experiments clef --runs 1')
  process.exit(1)
}
const gold = JSON.parse(fs.readFileSync('eval/gold/assessment_gold.json', 'utf8'))
const runsOf = (f) => (JSON.parse(fs.readFileSync(f, 'utf8')).raw?.clef ?? []).filter((r) => r.clef)

/** The rules of clefSteps.ts for one step: stated / suggested / missing (conflict counts as missing). */
function decide(id, t, HI, LO) {
  if (!t) return 'missing'
  if (t.derived) return `stated:${t.derived}`
  const A = { v: t.a[0], c: t.a[1] }
  const C = t.c ? { v: t.c[0], c: t.c[1] } : null
  const aReal = A.v && A.v !== UNKNOWN
  const cReal = C && C.v && C.v !== UNKNOWN
  const aSure = aReal && A.c >= HI
  const cSure = cReal && C.c >= HI
  if (aSure && cSure && C.v !== A.v) return 'missing'
  if (aSure) return `stated:${A.v}`
  if (SOURCE_STEPS.has(id) && cSure) return `suggested:${C.v}`
  const cands = [aReal && !STATED_ONLY.has(id) ? A : null, SOURCE_STEPS.has(id) && cReal ? C : null].filter((p) => p && p.c >= LO)
  const best = cands.sort((x, y) => y.c - x.c)[0]
  return best ? `suggested:${best.v}` : 'missing'
}

function score(runs, HI, LO) {
  const q = { steps: 0, correct: 0, wrongStated: 0, wrongSuggested: 0, overCaution: 0, stated: 0, suggested: 0, missing: 0, errors: [] }
  for (const r of runs) {
    const g = gold.steps[r.case]
    for (const [id, t] of Object.entries(r.clef)) {
      const o = decide(id, t, HI, LO)
      const [kind, val] = o.includes(':') ? o.split(':') : [o, 'missing']
      q[kind]++
      if (!g?.[id]) continue
      q.steps++
      const value = kind === 'missing' ? 'missing' : val
      if (g[id].includes(value)) q.correct++
      else if (kind === 'missing') q.overCaution++
      else if (kind === 'stated') (q.wrongStated++, q.errors.push(`${r.case} ${id}: stated ${val}`))
      else (q.wrongSuggested++, q.errors.push(`${r.case} ${id}: suggested ${val}`))
    }
  }
  return q
}

const devRuns = runsOf(file).filter((r) => r.case.startsWith('D'))
const firstRun = new Map()
for (const r of devRuns) if (!firstRun.has(r.case)) firstRun.set(r.case, r) // Clef is deterministic: one run per case is enough
const dev = [...firstRun.values()]
console.log(`\nThreshold study on ${dev.length} development cases (${file})\n`)
console.log('Decided  Suggest │ correct  wrong-stated  wrong-suggested  over-caution │ stated  suggested  missing')
const his = [0.45, 0.5, 0.55, 0.6, 0.65, 0.7]
const los = [0.2, 0.25, 0.3, 0.35]
const rows = []
for (const HI of his)
  for (const LO of los) {
    if (LO >= HI) continue
    const q = score(dev, HI, LO)
    rows.push({ HI, LO, q })
    const mark = HI === 0.5 && LO === 0.3 ? '  ← current' : ''
    console.log(
      `${HI.toFixed(2).padStart(7)}  ${LO.toFixed(2).padStart(7)} │ ${`${q.correct}/${q.steps}`.padStart(7)}  ${String(q.wrongStated).padStart(12)}  ${String(q.wrongSuggested).padStart(15)}  ${String(q.overCaution).padStart(12)} │ ${String(q.stated).padStart(6)}  ${String(q.suggested).padStart(9)}  ${String(q.missing).padStart(7)}${mark}`,
    )
  }
// best: no wrong "stated" (a wrong value that is applied automatically is the worst error), then most stated, then most correct
const safe = rows.filter((r) => r.q.wrongStated === 0 && r.q.correct === r.q.steps)
const pick = (safe.length ? safe : rows).sort((a, b) => b.q.stated - a.q.stated || b.q.correct - a.q.correct || a.HI - b.HI)[0]
console.log(`\nLowest-effort setting without errors on D: Decided ${pick.HI}, Suggestion ${pick.LO} (stated ${pick.q.stated}, suggested ${pick.q.suggested}, missing ${pick.q.missing})`)
if (pick.q.errors.length) console.log('Errors:', pick.q.errors.join('; '))

if (finalFile) {
  const fin = runsOf(finalFile).filter((r) => r.case.startsWith('H'))
  console.log(`\nFinal cases (report only, not used for the choice): ${fin.length} runs from ${finalFile}`)
  for (const [HI, LO] of [[0.5, 0.3], [pick.HI, pick.LO]]) {
    const q = score(fin, HI, LO)
    console.log(`  Decided ${HI} / Suggestion ${LO}: stated ${q.stated}, suggested ${q.suggested}, missing ${q.missing}`)
    for (const r of fin) console.log(`    ${r.case}: ${Object.entries(r.clef).map(([id, t]) => `${id}=${decide(id, t, HI, LO)}`).join('  ')}`)
  }
}
