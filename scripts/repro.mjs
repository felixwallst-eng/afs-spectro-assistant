#!/usr/bin/env node
// Reproducibility benchmark: runs the same enquiries several times and measures how often the
// assistant reaches the same decision per step. Runs against the local dev server (npm run dev).
//
//   node scripts/repro.mjs                       # both pipelines, D01–D08, 5 runs each
//   node scripts/repro.mjs --runs 3 --cases D02,D06 --pipelines steps
//   node scripts/repro.mjs --votes 1             # steps pipeline without majority vote
//   node scripts/repro.mjs --sources all         # also use uploaded documents
//
// Only development cases (D01–D08) by default – the evaluation cases H01–H06 stay unseen.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']] : acc), []),
)
const BASE = args.url ?? 'http://localhost:5173'
const RUNS = Number(args.runs ?? 5)
const PIPELINES = (args.pipelines ?? 'single,steps').split(',')
const SOURCES = args.sources === 'all' ? 'all' : 'original'
const VOTES = args.votes ? Number(args.votes) : undefined
const CONCURRENCY = Number(args.concurrency ?? 2)
const MODEL = args.model ?? 'gptoss'

const TREE = ['sample_state', 'interface_mode', 'target_property_type', 'optical_variability', 'concentration_level', 'budget']

// ------------------------------------------------------------------ cases (parsed from shared/cases.ts)
const casesSrc = fs.readFileSync(path.join(root, 'shared/cases.ts'), 'utf8')
const allCases = JSON.parse(casesSrc.slice(casesSrc.indexOf('= [') + 2, casesSrc.lastIndexOf(']') + 1))
const wanted = args.cases ? args.cases.split(',') : allCases.filter((c) => c.split === 'dev').map((c) => c.id)
const cases = allCases.filter((c) => wanted.includes(c.id))

const api = async (p, init) => {
  const r = await fetch(BASE + p, init)
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data.error ?? `${p}: HTTP ${r.status}`)
  return data
}
const post = (p, body) => api(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

// ------------------------------------------------------------------ 1. make sure every document is indexed and read
async function prepareKnowledge() {
  let docs = await api('/api/docs')
  for (const d of docs.filter((x) => x.origin === 'original' && !x.indexed)) {
    const file = path.join(root, 'public/sources', `${d.id}.pdf`)
    if (!fs.existsSync(file)) {
      console.log(`  ${d.id}: ${file} missing – skipped`)
      continue
    }
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const doc = await getDocument({ data: new Uint8Array(fs.readFileSync(file)), verbosity: 0 }).promise
    const pages = []
    for (let i = 1; i <= doc.numPages; i++) {
      const tc = await (await doc.getPage(i)).getTextContent()
      pages.push(tc.items.filter((it) => 'str' in it).map((it) => it.str + (it.hasEOL ? '\n' : '')).join('').replace(/[ \t]+/g, ' ').trim())
    }
    await api(`/api/docs/${d.id}/text`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(pages) })
    console.log(`  ${d.id}: indexed ${pages.length} pages`)
  }
  docs = await api('/api/docs')
  for (const d of docs.filter((x) => x.enabled && x.indexed && x.cards === undefined && (SOURCES === 'all' || x.origin === 'original'))) {
    process.stdout.write(`  ${d.id}: reading all ${d.pages ?? '?'} pages into knowledge cards… `)
    const t = Date.now()
    const set = await post(`/api/docs/${d.id}/cards`, {})
    console.log(`${set.cards.length} cards (${set.rejected} discarded) in ${((Date.now() - t) / 1000).toFixed(0)} s`)
  }
  docs = await api('/api/docs')
  return docs.filter((d) => d.enabled && (SOURCES === 'all' || d.origin === 'original'))
}

// ------------------------------------------------------------------ 2. run
async function pool(items, n, fn) {
  const out = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i], i)
      }
    }),
  )
  return out
}

const outcome = (d) => {
  if (!d) return 'missing'
  const basis = d.basis ?? (d.value ? 'customer' : 'missing')
  return basis === 'missing' ? 'missing' : `${basis}:${d.value}`
}

async function runPipeline(pipeline) {
  const jobs = cases.flatMap((c) => Array.from({ length: RUNS }, (_, r) => ({ c, r })))
  let done = 0
  const results = await pool(jobs, CONCURRENCY, async ({ c, r }) => {
    const t = Date.now()
    try {
      const res = await post('/api/tree', { text: c.text, model: MODEL, pipeline, sources: SOURCES, fresh: true, ...(VOTES ? { votes: VOTES } : {}) })
      done++
      process.stdout.write(`\r  ${pipeline}: ${done}/${jobs.length} runs`)
      return { case: c.id, run: r, ms: Date.now() - t, calls: res.calls ?? 1, tokens: (res.usage?.inputTokens ?? 0) + (res.usage?.outputTokens ?? 0), steps: Object.fromEntries(TREE.map((id) => [id, outcome(res.decisions.find((d) => d.id === id))])) }
    } catch (e) {
      done++
      return { case: c.id, run: r, ms: Date.now() - t, error: String(e.message ?? e) }
    }
  })
  process.stdout.write('\n')
  return results
}

// ------------------------------------------------------------------ 3. measure
function summarise(pipeline, results) {
  const perCase = cases.map((c) => {
    const runs = results.filter((r) => r.case === c.id && !r.error)
    const steps = TREE.map((id) => {
      const tally = {}
      for (const r of runs) tally[r.steps[id]] = (tally[r.steps[id]] ?? 0) + 1
      const top = Math.max(0, ...Object.values(tally))
      return { id, agreement: runs.length ? top / runs.length : 0, identical: runs.length > 1 && top === runs.length, tally }
    })
    const sigs = {}
    for (const r of runs) {
      const s = TREE.map((id) => r.steps[id]).join('|')
      sigs[s] = (sigs[s] ?? 0) + 1
    }
    return { case: c.id, runs: runs.length, errors: results.filter((r) => r.case === c.id && r.error).length, steps, wholeTreeAgreement: runs.length ? Math.max(...Object.values(sigs)) / runs.length : 0 }
  })
  const ok = results.filter((r) => !r.error)
  // only cases with at least two successful runs can show (non-)reproducibility
  const allSteps = perCase.filter((c) => c.runs > 1).flatMap((c) => c.steps)
  return {
    pipeline,
    runsPerCase: RUNS,
    stepAgreement: allSteps.length ? allSteps.reduce((a, s) => a + s.agreement, 0) / allSteps.length : NaN,
    stepsFullyReproducible: allSteps.length ? allSteps.filter((s) => s.identical).length / allSteps.length : NaN,
    wholeTreeAgreement: perCase.filter((c) => c.runs > 1).reduce((a, c) => a + c.wholeTreeAgreement, 0) / Math.max(1, perCase.filter((c) => c.runs > 1).length),
    avgSeconds: ok.reduce((a, r) => a + r.ms, 0) / Math.max(1, ok.length) / 1000,
    avgCalls: ok.reduce((a, r) => a + r.calls, 0) / Math.max(1, ok.length),
    avgTokens: ok.reduce((a, r) => a + r.tokens, 0) / Math.max(1, ok.length),
    errors: results.length - ok.length,
    errorMessages: Object.entries(results.filter((r) => r.error).reduce((m, r) => ((m[r.error] = (m[r.error] ?? 0) + 1), m), {})),
    perCase,
  }
}

const pct = (x) => (Number.isNaN(x) ? 'n/a' : `${(x * 100).toFixed(0)}%`)

console.log(`Reproducibility test · ${cases.map((c) => c.id).join(', ')} · ${RUNS} runs · sources: ${SOURCES} · model: ${MODEL} · ${BASE}`)
console.log('Knowledge base:')
const docs = await prepareKnowledge()
console.log(`  using ${docs.map((d) => `${d.id} (${d.cards ?? 0} cards)`).join(', ')}`)

const summaries = []
for (const p of PIPELINES) summaries.push(summarise(p, await runPipeline(p)))

console.log('\n                         ' + summaries.map((s) => s.pipeline.padStart(10)).join(''))
const row = (label, f) => console.log(label.padEnd(25) + summaries.map((s) => f(s).padStart(10)).join(''))
row('step agreement', (s) => pct(s.stepAgreement))
row('steps fully reproducible', (s) => pct(s.stepsFullyReproducible))
row('whole tree identical', (s) => pct(s.wholeTreeAgreement))
row('seconds per analysis', (s) => s.avgSeconds.toFixed(1))
row('model calls', (s) => s.avgCalls.toFixed(0))
row('tokens per analysis', (s) => Math.round(s.avgTokens).toLocaleString('en'))
row('failed runs', (s) => String(s.errors))
for (const s of summaries) {
  if (!s.errorMessages.length) continue
  console.log(`\n${s.pipeline} – why runs failed:`)
  for (const [msg, n] of s.errorMessages) console.log(`  ×${n}  ${msg.slice(0, 300)}`)
}

for (const s of summaries) {
  console.log(`\n${s.pipeline} – steps that were not identical in every run:`)
  let any = false
  for (const c of s.perCase)
    for (const st of c.steps)
      if (!st.identical && c.runs > 1) {
        any = true
        console.log(`  ${c.case} ${st.id.padEnd(22)} ${Object.entries(st.tally).map(([k, v]) => `${k} ×${v}`).join(' | ')}`)
      }
  if (!any) console.log('  none')
}

const outDir = path.join(root, 'eval/results')
fs.mkdirSync(outDir, { recursive: true })
const file = path.join(outDir, `repro-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`)
fs.writeFileSync(file, JSON.stringify({ date: new Date().toISOString(), model: MODEL, sources: SOURCES, runs: RUNS, votes: VOTES ?? 'default', cases: cases.map((c) => c.id), summaries }, null, 2))
console.log(`\nSaved ${path.relative(root, file)}`)
