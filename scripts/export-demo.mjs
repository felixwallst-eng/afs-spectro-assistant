// Freezes the results of the evaluation cases H01–H06 for the demo: the app shows them pinned in the
// sidebar, so the jury can click through them without running an analysis.
// Clef is deterministic, so these are exactly the results a live run gives with the same code and cards.
//
//   npm run dev                                   # in another terminal
//   node scripts/export-demo.mjs                  # writes public/demo/evaluation-cases.json
//   node scripts/export-demo.mjs --url https://<your-worker>.workers.dev
//   node scripts/export-demo.mjs --set dev        # development cases D01–D08 instead (public/demo/development-cases.json)

import fs from 'node:fs'

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true] : null))
    .filter(Boolean),
)
const BASE = args.url ?? 'http://localhost:5173'
const SET = args.set === 'dev' ? 'dev' : 'test'
const OUT = SET === 'dev' ? 'public/demo/development-cases.json' : 'public/demo/evaluation-cases.json'

const cases = JSON.parse(fs.readFileSync('eval/cases.json', 'utf8')).cases.filter((c) => c.split === SET)
const out = []
for (const c of cases) {
  process.stdout.write(`${c.id} … `)
  const r = await fetch(`${BASE}/api/tree`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: c.text, pipeline: 'clef', sources: 'original', fresh: true }),
  })
  const tree = await r.json()
  if (!r.ok) {
    console.error(`failed: ${tree.error ?? r.status}`)
    process.exit(1)
  }
  out.push({ id: `demo-${c.id}`, caseId: c.id, title: `${c.id} · ${c.title}`, text: c.text, tree, createdAt: new Date().toISOString() })
  console.log(`${(tree.latencyMs / 1000).toFixed(1)} s, ${tree.premises?.length ?? 0} premise findings`)
}
fs.writeFileSync(OUT, JSON.stringify({ exportedAt: new Date().toISOString(), pipeline: out[0]?.tree?.model, cases: out }, null, 2))
console.log(`\nWrote ${out.length} cases to ${OUT}`)
