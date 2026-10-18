#!/usr/bin/env node
// Reproducibility and quality test for the assessment. Runs the same enquiries several times against
// the local dev server, measures how often each step ends with the same result, and scores every run
// against the gold standard in eval/gold/assessment_gold.json (correct decisions, premise checks).
//
//   node scripts/repro.mjs                         # default: clef vs llm, D01–D08, 5 runs
//   node scripts/repro.mjs --experiments clef --runs 3      # Clef only
//   node scripts/repro.mjs --experiments clef --set traps --runs 1   # own premise cases T01–T10
//   node scripts/repro.mjs --set final --runs 1 --experiments clef   # final evaluation H01–H06 (run once)
//   node scripts/repro.mjs --cases D02,D06 --runs 3          # quick check
//   node scripts/repro.mjs --experiments votes3             # production setting (3 runs per step, majority)
//   node scripts/repro.mjs --experiments single             # earlier one-call pipeline, for comparison
//   node scripts/repro.mjs --plan                           # only print how many model calls a run would make
//
// Experiments
//   clef       Clef classifier: customer text, card relevance, text + cards; conflicts flagged; references checked against the decision
//   clef-relevance  same decisions, references from the earlier single relevance check (citation comparison)
//   llm        language model, one call per step, 3 runs with majority vote (production setting)
//   same-seed  one call per step, identical seed every run   → what a user sees when re-running a case
//   new-seed   one call per step, different seed every run   → how stable the model is without seed help
//   votes3     three calls per step, majority vote, new seeds → the production setting
//   single     earlier pipeline: one call for all steps        → baseline
//
// Only the development cases D01–D08 are used by default; H01–H06 stay unseen.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']] : acc), []),
)
const BASE = args.url ?? 'http://localhost:5173'
const RUNS = Number(args.runs ?? 5)
const EXPERIMENTS = (args.experiments ?? 'clef,llm').split(',')
const CONCURRENCY = Number(args.concurrency ?? 2)
const MODEL = args.model ?? 'gptoss'
// Rough price per million tokens for the cost estimate – check the current Workers AI price list.
const PRICE_IN = Number(args['price-in'] ?? 0.35)
const PRICE_OUT = Number(args['price-out'] ?? 0.75)

// references shown per step (card ids, role), the customer quote and the reasoning – for scripts/citations.mjs
const citeTrace = (d) => (d ? { refs: (d.refs ?? []).map((r) => r.cardId).filter(Boolean), roles: (d.refs ?? []).map((r) => r.role ?? null), quote: d.enquiryQuote ?? null, reasoning: d.reasoning ?? '' } : null)
// Clef's raw classification per step (for scripts/thresholds.mjs: re-apply other thresholds without new calls)
const clefTrace = (d) =>
  d?.clef ? { a: [d.clef.text.value, d.clef.text.confidence], c: d.clef.relevantCards ? [d.clef.withSources.value, d.clef.withSources.confidence] : null, derived: /^Derived/.test(d.reasoning ?? '') ? d.value : null } : null
const TREE = ['sample_state', 'interface_mode', 'spectral_range', 'target_property_type', 'optical_variability', 'concentration_level']
const SETUPS = {
  clef: { label: 'Clef', body: () => ({ pipeline: 'clef' }), callsPerRun: 15 },
  'clef-relevance': { label: 'Clef (earlier citations)', body: () => ({ pipeline: 'clef', citations: 'relevance' }), callsPerRun: 8 },
  llm: { label: 'LLM 3 votes', body: (run) => ({ pipeline: 'steps', votes: 3, seedBase: 100 * (run + 1) }), callsPerRun: 18 },
  'same-seed': { label: 'same seed', body: (run) => ({ pipeline: 'steps', votes: 1, stepsOnly: true, seedBase: 0 }), callsPerRun: 5 },
  'new-seed': { label: 'new seed', body: (run) => ({ pipeline: 'steps', votes: 1, stepsOnly: true, seedBase: 100 * (run + 1) }), callsPerRun: 5 },
  votes3: { label: '3 votes', body: (run) => ({ pipeline: 'steps', votes: 3, stepsOnly: true, seedBase: 100 * (run + 1) }), callsPerRun: 15 },
  single: { label: 'one call', body: () => ({ pipeline: 'single' }), callsPerRun: 1 },
}
for (const e of EXPERIMENTS) if (!SETUPS[e]) throw new Error(`Unknown experiment "${e}". Use: ${Object.keys(SETUPS).join(', ')}`)

// ------------------------------------------------------------------ cases (from shared/cases.ts)
const casesSrc = fs.readFileSync(path.join(root, 'shared/cases.ts'), 'utf8')
const trapFile = JSON.parse(fs.readFileSync(path.join(root, 'eval/gold/trap_cases.json'), 'utf8'))
const allCases = [...JSON.parse(casesSrc.slice(casesSrc.indexOf('= [') + 2, casesSrc.lastIndexOf(']') + 1)), ...trapFile.cases.map((c) => ({ ...c, split: 'trap' }))]
// --set dev (D01–D08) · traps (own premise cases T01–T10) · final (H01–H06, run once) · or --cases D02,T04
const SETS = { dev: (c) => c.split === 'dev', traps: (c) => c.split === 'trap', final: (c) => c.split === 'test' }
const wanted = args.cases ? args.cases.split(',') : allCases.filter(SETS[args.set ?? 'dev'] ?? SETS.dev).map((c) => c.id)
const cases = allCases.filter((c) => wanted.includes(c.id))

const gold = JSON.parse(fs.readFileSync(path.join(root, 'eval/gold/assessment_gold.json'), 'utf8'))
for (const c of trapFile.cases) gold.premises[c.id] = c.premises

const plannedCalls = EXPERIMENTS.reduce((a, e) => a + SETUPS[e].callsPerRun * RUNS * cases.length, 0)
console.log(`Reproducibility test · ${cases.map((c) => c.id).join(', ')} · ${RUNS} runs · experiments: ${EXPERIMENTS.join(', ')} · model: ${MODEL}`)
console.log(`Planned: about ${plannedCalls} model calls`)
if (args.plan) process.exit(0)

const api = async (p, init) => {
  const r = await fetch(BASE + p, init)
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data.error ?? `${p}: HTTP ${r.status}`)
  return data
}

// ------------------------------------------------------------------ knowledge: curated cards must be in use
let docs
try {
  docs = (await api('/api/docs')).filter((d) => d.enabled && d.origin === 'original')
} catch (e) {
  console.error(`\nCannot reach ${BASE} – is "npm run dev" running? (${e.message})`)
  process.exit(1)
}
console.log(`Knowledge: ${docs.map((d) => `${d.id} ${d.cards ?? 0} cards${d.cardsCurated ? ' (curated)' : ''}`).join(' · ')}`)
if (docs.some((d) => !d.cards)) console.log('  ⚠ a document has no cards – its knowledge is missing from the test')

// ------------------------------------------------------------------ run
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
  if (basis === 'conflict') return `conflict:${d.value}>${d.alternative}`
  if (basis === 'missing') return d.votes && d.votes.runs > 1 && d.votes.agree <= d.votes.runs / 2 ? 'open (runs disagree)' : 'missing'
  return `${basis === 'customer' ? 'stated' : 'suggested'}:${d.value}`
}

let seedInfo = null
async function runExperiment(name) {
  const setup = SETUPS[name]
  const jobs = cases.flatMap((c) => Array.from({ length: RUNS }, (_, r) => ({ c, r })))
  let done = 0
  const results = await pool(jobs, CONCURRENCY, async ({ c, r }) => {
    const t = Date.now()
    try {
      const res = await api('/api/tree', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: c.text, model: MODEL, sources: 'original', fresh: true, ...setup.body(r) }) })
      if (res.seedAccepted !== undefined) seedInfo = res.seedAccepted
      return { case: c.id, run: r, ms: Date.now() - t, calls: res.calls ?? 1, tin: res.usage?.inputTokens ?? 0, tout: res.usage?.outputTokens ?? 0, steps: Object.fromEntries(TREE.map((id) => [id, outcome(res.decisions.find((d) => d.id === id))])), premises: (res.premises ?? []).map((w) => ({ id: w.id, severity: w.severity })), premiseFacts: res.premiseFacts, clef: Object.fromEntries(TREE.map((id) => [id, clefTrace(res.decisions.find((d) => d.id === id))])), cites: Object.fromEntries(TREE.map((id) => [id, citeTrace(res.decisions.find((d) => d.id === id))])) }
    } catch (e) {
      return { case: c.id, run: r, ms: Date.now() - t, error: String(e.message ?? e) }
    } finally {
      done++
      process.stdout.write(`\r  ${setup.label}: ${done}/${jobs.length} runs`)
    }
  })
  process.stdout.write('\n')
  return results
}

// ------------------------------------------------------------------ measure
/** Probability that two independent 3-vote majorities end with the same result, from an outcome distribution. */
function majority3Agreement(tally, n) {
  const outs = Object.keys(tally)
  const p = outs.map((o) => tally[o] / n)
  const res = {}
  for (let a = 0; a < outs.length; a++)
    for (let b = 0; b < outs.length; b++)
      for (let c = 0; c < outs.length; c++) {
        const pr = p[a] * p[b] * p[c]
        const k = a === b || a === c ? outs[a] : b === c ? outs[b] : 'open'
        res[k] = (res[k] ?? 0) + pr
      }
  return Object.values(res).reduce((s, x) => s + x * x, 0)
}

function summarise(name, results) {
  const ok = results.filter((r) => !r.error)
  const perCase = cases.map((c) => {
    const runs = ok.filter((r) => r.case === c.id)
    const steps = TREE.map((id) => {
      const tally = {}
      const vtally = {}
      for (const r of runs) {
        tally[r.steps[id]] = (tally[r.steps[id]] ?? 0) + 1
        const v = r.steps[id].replace(/^(stated|suggested):/, '')
        vtally[v] = (vtally[v] ?? 0) + 1
      }
      const top = Math.max(0, ...Object.values(tally))
      const vtop = Math.max(0, ...Object.values(vtally))
      return { id, n: runs.length, agreement: runs.length ? top / runs.length : NaN, identical: runs.length > 1 && top === runs.length, valueIdentical: runs.length > 1 && vtop === runs.length, maj3: runs.length > 1 ? majority3Agreement(tally, runs.length) : NaN, tally }
    })
    const sigs = {}
    for (const r of runs) {
      const s = TREE.map((id) => r.steps[id]).join('|')
      sigs[s] = (sigs[s] ?? 0) + 1
    }
    return { case: c.id, runs: runs.length, steps, wholeTree: runs.length > 1 ? Math.max(...Object.values(sigs)) / runs.length : NaN }
  })
  const valid = perCase.filter((c) => c.runs > 1)
  const steps = valid.flatMap((c) => c.steps)
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN)
  // quality against the gold standard
  const q = { steps: 0, correct: 0, wrongStated: 0, wrongSuggested: 0, overCaution: 0, conflicts: 0, premExpected: 0, premFound: 0, falseAlarms: 0, runsWithPremiseGold: 0, details: [] }
  for (const r of ok) {
    const g = gold.steps[r.case]
    if (g)
      for (const id of TREE) {
        const accept = g[id]
        if (!accept) continue
        const o = r.steps[id]
        const [kind, rest] = o.includes(':') ? [o.slice(0, o.indexOf(':')), o.slice(o.indexOf(':') + 1)] : [o, '']
        const value = kind === 'stated' || kind === 'suggested' ? rest : 'missing' // open / conflict count as "ask the expert"
        q.steps++
        if (kind === 'conflict') q.conflicts++
        if (accept.includes(value)) q.correct++
        else if (value === 'missing') q.overCaution++
        else if (kind === 'stated') q.wrongStated++
        else q.wrongSuggested++
        if (!accept.includes(value)) q.details.push(`${r.case} ${id}: ${o} (expected ${accept.join(' / ')})`)
      }
    const gp = gold.premises[r.case]
    if (gp) {
      q.runsWithPremiseGold++
      const found = new Set(r.premises.map((p) => p.id))
      q.premExpected += gp.length
      q.premFound += gp.filter((id) => found.has(id)).length
      const extra = r.premises.filter((p) => p.severity === 'block' && !gp.includes(p.id))
      q.falseAlarms += extra.length
      for (const id of gp.filter((x) => !found.has(x))) q.details.push(`${r.case} premise missed: ${id}`)
      for (const p of extra) q.details.push(`${r.case} false alarm: ${p.id}`)
    }
  }
  const tin = ok.reduce((a, r) => a + r.tin, 0)
  const tout = ok.reduce((a, r) => a + r.tout, 0)
  return {
    name,
    label: SETUPS[name].label,
    stepAgreement: mean(steps.map((s) => s.agreement)),
    stepsIdentical: mean(steps.map((s) => (s.identical ? 1 : 0))),
    valueIdentical: mean(steps.map((s) => (s.valueIdentical ? 1 : 0))),
    wholeTree: mean(valid.map((c) => c.wholeTree)),
    maj3: name === 'new-seed' ? mean(steps.map((s) => s.maj3)) : NaN,
    byStep: Object.fromEntries(TREE.map((id) => [id, mean(valid.map((c) => c.steps.find((s) => s.id === id).agreement))])),
    seconds: mean(ok.map((r) => r.ms / 1000)),
    calls: mean(ok.map((r) => r.calls)),
    tokens: ok.length ? (tin + tout) / ok.length : NaN,
    costPerAnalysis: ok.length ? ((tin * PRICE_IN + tout * PRICE_OUT) / 1e6) / ok.length : NaN,
    failed: results.length - ok.length,
    quality: q,
    errors: Object.entries(results.filter((r) => r.error).reduce((m, r) => ((m[r.error] = (m[r.error] ?? 0) + 1), m), {})),
    perCase,
  }
}

const pct = (x) => (Number.isNaN(x) ? 'n/a' : `${(x * 100).toFixed(0)}%`)
const summaries = []
const rawRuns = {}
for (const e of EXPERIMENTS) {
  const results = await runExperiment(e)
  rawRuns[e] = results
  summaries.push(summarise(e, results))
}

const W = 14
const row = (label, f) => console.log(label.padEnd(34) + summaries.map((s) => f(s).padStart(W)).join(''))
console.log('\n' + ''.padEnd(34) + summaries.map((s) => s.label.padStart(W)).join(''))
row('step agreement (modal share)', (s) => pct(s.stepAgreement))
row('steps identical in every run', (s) => pct(s.stepsIdentical))
row('  … value only (ignoring stated/suggested)', (s) => pct(s.valueIdentical))
row('whole tree identical', (s) => pct(s.wholeTree))
if (summaries.some((s) => !Number.isNaN(s.maj3))) row('≈ with 3-vote majority (estimate)', (s) => pct(s.maj3))
row('seconds per analysis', (s) => s.seconds.toFixed(1))
row('model calls per analysis', (s) => s.calls.toFixed(0))
row('tokens per analysis', (s) => (Number.isNaN(s.tokens) ? 'n/a' : Math.round(s.tokens).toLocaleString('en')))
row('≈ cost per analysis (USD)', (s) => (Number.isNaN(s.costPerAnalysis) ? 'n/a' : s.costPerAnalysis.toFixed(4)))
row('failed runs', (s) => String(s.failed))
const anyQ = summaries.some((s) => s.quality.steps || s.quality.runsWithPremiseGold)
if (anyQ) {
  console.log('\nQuality (gold standard, eval/gold/assessment_gold.json)')
  const qr = (label, f) => console.log(label.padEnd(34) + summaries.map((s) => f(s.quality).padStart(W)).join(''))
  qr('decisions correct', (q) => (q.steps ? pct(q.correct / q.steps) : 'n/a'))
  qr('  wrong value stated (severe)', (q) => (q.steps ? pct(q.wrongStated / q.steps) : 'n/a'))
  qr('  wrong value suggested', (q) => (q.steps ? pct(q.wrongSuggested / q.steps) : 'n/a'))
  qr('  asked although stated', (q) => (q.steps ? pct(q.overCaution / q.steps) : 'n/a'))
  qr('  conflicts flagged', (q) => String(q.conflicts))
  qr('premise checks found', (q) => (q.premExpected ? `${q.premFound}/${q.premExpected}` : 'n/a'))
  qr('false premise alarms', (q) => (q.runsWithPremiseGold ? String(q.falseAlarms) : 'n/a'))
}
console.log(`seed accepted by the model: ${seedInfo === null ? 'unknown' : seedInfo ? 'yes' : 'no (temperature 0 only)'}`)

console.log('\nAgreement per step')
for (const id of TREE) console.log('  ' + id.padEnd(32) + summaries.map((s) => pct(s.byStep[id]).padStart(W)).join(''))

for (const s of summaries) {
  if (s.errors.length) {
    console.log(`\n${s.label} – why runs failed:`)
    for (const [msg, n] of s.errors) console.log(`  ×${n}  ${msg.slice(0, 300)}`)
  }
  if (s.quality.details.length) {
    const counts = s.quality.details.reduce((m, d) => ((m[d] = (m[d] ?? 0) + 1), m), {})
    console.log(`\n${s.label} – deviations from the gold standard (×runs):`)
    for (const [d, n] of Object.entries(counts)) console.log(`  ×${n}  ${d}`)
  }
  const unstable = s.perCase.flatMap((c) => c.steps.filter((st) => !st.identical && st.n > 1).map((st) => ({ c: c.case, st })))
  console.log(`\n${s.label} – steps that changed between runs:${unstable.length ? '' : ' none'}`)
  for (const { c, st } of unstable) console.log(`  ${c} ${st.id.padEnd(22)} ${Object.entries(st.tally).map(([k, v]) => `${k} ×${v}`).join(' | ')}`)
}

const outDir = path.join(root, 'eval/results')
fs.mkdirSync(outDir, { recursive: true })
const file = path.join(outDir, `repro-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`)
fs.writeFileSync(file, JSON.stringify({ date: new Date().toISOString(), model: MODEL, runs: RUNS, cases: cases.map((c) => c.id), seedAccepted: seedInfo, summaries, raw: rawRuns }, null, 2))
console.log(`\nSaved ${path.relative(root, file)}`)
