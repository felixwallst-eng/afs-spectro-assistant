import { useEffect, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { DIM_BY_ID } from '../../shared/dimensions.ts'
import { openRisks } from '../../shared/engine.ts'
import type { SolvedCase } from '../../shared/solvedCases.ts'
import { basisOf } from '../../shared/treeLogic.ts'
import type { OpenRisk } from '../../shared/engine.ts'
import { METHOD_INFO } from '../../shared/knowledge.ts'
import { TREE_NODES } from '../../shared/tree.ts'
import type { Decision, SourcePassage, TreeResponse } from '../../shared/tree.ts'
import type { Assessment, Candidate, Level as Grade, MethodSetup } from '../../shared/types.ts'
import { DEFAULT_SETTINGS } from '../../shared/types.ts'
import { useOpenSource } from '../sourceContext.ts'
import { nodeStatus, remainingPerLevel } from '../treeModel.ts'
import type { NodeStatus } from '../treeModel.ts'
import CiteLink from './CiteLink.tsx'

interface Props {
  tree: TreeResponse
  text: string
  assessment: Assessment
  methods: MethodSetup[]
  overrides: Record<string, string>
  onOverride: (id: string, value: string | undefined) => void
  /** Empty path shown before the first analysis: greyed out, not interactive, with this message on top. */
  placeholder?: { title: string; text: string }
  /** Expert notes per step and saving the walked-through case to the knowledge base. */
  caseId?: string | null
  notes?: Record<string, string>
  onNote?: (id: string, text: string) => void
  savedAt?: string
  onSaveCase?: (c: Omit<SolvedCase, 'createdAt'>) => Promise<void>
}

// ---------------------------------------------------------------- layout (SVG user units)
// Each column is fed through a splice point ("gate") just before it. A decided step is a plain
// splice; an open step turns its gate into the "?" junction from which the options branch.
// Option positions never move – only the light changes its path.
const COL_W = 166
const ROW_H = 52
const X0 = 40
const COL_X = (k: number) => 168 + k * COL_W
const GATE_DX = 31
const HEAD = 58
const OPT_TOP = HEAD + 90

const STATUS_TEXT: Record<NodeStatus, string> = {
  decided: 'Stated by the customer',
  suggested: 'Suggestion – please confirm',
  conflict: 'Conflict – customer text and AFS sources disagree',
  expert: 'Decided by the expert',
  action: 'Information missing – blocks the decision',
  minor: 'Information missing – does not block the decision',
  deferred: 'Left open by the expert – ask the customer',
}
const STATUS_CHIP: Record<NodeStatus, string> = { decided: 'confident', suggested: 'uncertain', conflict: 'unknown', expert: 'expert', action: 'unknown', minor: 'clef', deferred: 'clef' }

const curve = (x1: number, y1: number, x2: number, y2: number) => {
  const dx = Math.max(24, (x2 - x1) * 0.45)
  return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`
}
const line = (x1: number, y1: number, x2: number, y2: number) => (y1 === y2 ? `M${x1},${y1} L${x2},${y2}` : curve(x1, y1, x2, y2))

function wrap(label: string, max = 13): string[] {
  const lines: string[] = ['']
  for (const w of label.split(' ')) {
    const cur = lines[lines.length - 1]
    if ((cur + ' ' + w).trim().length > max && cur) lines.push(w)
    else lines[lines.length - 1] = (cur + ' ' + w).trim()
  }
  return lines.slice(0, 3)
}
/** Approximate rendered width of a wrapped label (13 px, partly bold) – the fiber leaves after the label. */
const labelEnd = (x: number, label: string) => x + 13 + Math.max(...wrap(label).map((l) => l.length)) * 7.3 + 6

type Selection = { kind: 'root' } | { kind: 'node'; id: string } | { kind: 'leaf'; setupId: string } | { kind: 'premises' } | { kind: 'compare' }
const keyOf = (s: Selection) => (s.kind === 'node' ? `n:${s.id}` : s.kind === 'leaf' ? `l:${s.setupId}` : s.kind)
const NEEDS: NodeStatus[] = ['suggested', 'action', 'conflict']

export default function DecisionTree({ tree, text, assessment, methods, overrides, onOverride, placeholder, caseId, notes = {}, onNote, savedAt, onSaveCase }: Props) {
  // the detail panel is always open and starts at the enquiry; the expert walks through from there
  const [selState, setSel] = useState<Selection>({ kind: 'root' })
  const [draft, setDraft] = useState<string | null>(null)
  const panelRef = useRef<HTMLElement>(null)
  const values = Object.fromEntries(Object.values(assessment.dimensions).map((d) => [d.id, d.value]))
  const decisionOf = (id: string): Decision | undefined => tree.decisions.find((d) => d.id === id)
  const counts = remainingPerLevel(values, methods)

  const levels = TREE_NODES.map((n, k) => {
    const def = DIM_BY_ID[n.id]
    const options = Object.keys(def.labels).filter((l) => l !== def.unknownLabel)
    const status = nodeStatus(n.id, tree.decisions, overrides)
    const decided = status === 'decided' || status === 'expert'
    const d = tree.decisions.find((x) => x.id === n.id)
    const chosen = decided ? options.indexOf(values[n.id]) : -1
    const suggested = status === 'suggested' && d?.value ? options.indexOf(d.value) : -1
    // conflict: both the customer's value and the value the sources point to are marked
    const conflicting = status === 'conflict' && d ? [d.value, d.alternative].map((v) => (v ? options.indexOf(v) : -1)).filter((i) => i >= 0) : []
    return { node: n, def, options, status, chosen, suggested, conflicting, decided: decided && chosen >= 0, x: COL_X(k) }
  })
  const maxOpts = Math.max(...levels.map((l) => l.options.length))
  const optY = (n: number, i: number) => OPT_TOP + ((maxOpts - n) * ROW_H) / 2 + i * ROW_H
  const midY = OPT_TOP + ((maxOpts - 1) * ROW_H) / 2
  const MAX_LEAVES = 6
  const recommended = assessment.candidates.filter((c) => c.status === 'recommended')
  // results stay provisional until every step is decided; per setup we check what the open steps could still do
  const openIds = levels.filter((l) => !l.decided).map((l) => l.node.id)
  // steps nobody has looked at yet (left open on purpose by the expert does not count)
  const unhandled = levels.filter((l) => !l.decided && l.status !== 'deferred').length
  const deferred = levels.filter((l) => l.status === 'deferred')
  const suggestions = levels.filter((l) => l.status === 'suggested')
  const provisional = openIds.length > 0
  const risks = new Map(assessment.candidates.filter((c) => c.status !== 'excluded').map((c) => [c.setup.id, openRisks(c.setup, values, openIds)]))
  const leaves = recommended.slice(0, MAX_LEAVES)
  const rankLabel = (c: Candidate) => (c.rank ? `#${c.rank}${c.tied ? '=' : ''}` : '')
  const condCount = assessment.candidates.filter((c) => c.status === 'conditional').length
  const leafX = COL_X(TREE_NODES.length) + 4
  const leafY = (i: number) => midY + (i - (leaves.length - 1) / 2) * ROW_H
  const W = leafX + 225
  const H = Math.max(OPT_TOP + maxOpts * ROW_H, leafY(Math.min(MAX_LEAVES, recommended.length) - 1) + (recommended.length > MAX_LEAVES ? 46 : 26))
  const premises = assessment.warnings
  const blocks = premises.filter((w) => w.severity === 'block').length

  // walk order: enquiry → steps → premise check → methods (left to right)
  const seq: Selection[] = [
    { kind: 'root' },
    ...levels.map((l): Selection => ({ kind: 'node', id: l.node.id })),
    ...(premises.length ? [{ kind: 'premises' } as Selection] : []),
    ...leaves.map((c): Selection => ({ kind: 'leaf', setupId: c.setup.id })),
    ...(recommended.length > 1 ? [{ kind: 'compare' } as Selection] : []),
  ]
  // a selection that no longer exists (e.g. a method that dropped out) falls back to the enquiry
  const sel: Selection = seq.find((x) => keyOf(x) === keyOf(selState)) ?? seq[0]
  const idx = seq.findIndex((x) => keyOf(x) === keyOf(sel))

  const pickNode = (id: string, value: string | null = null) => {
    const lv = levels.find((l) => l.node.id === id)
    setSel({ kind: 'node', id })
    // an open suggestion is pre-selected, so the expert only has to confirm it
    setDraft(value ?? (lv && lv.suggested >= 0 ? lv.options[lv.suggested] : null))
  }
  const keyAct = (fn: () => void) => (e: React.KeyboardEvent) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), fn())

  // ------------------------------------------------------------ fibers and light
  // A decided step branches straight from the previous node. Only an open step gets a junction
  // ("?") in front of it. The stretch from an unconfirmed step to the next confirmed one is drawn
  // as an amber dashed, provisional path; everything confirmed stays blue.
  // Where the light comes from: one point after a decided step or a suggestion; after an unresolved
  // step every option is a possible route, so the light continues from all of them.
  type Pt = { x: number; y: number }
  let from: Pt[] = [{ x: X0, y: midY }]
  let unsure = false
  const fans: ReactElement[] = []
  const lit: ReactElement[] = []
  const amber: ReactElement[] = [] // provisional light, kept out of the blue glow
  const nodes: ReactElement[] = []
  const core = (key: string, d: string) => fans.push(<path key={key} d={d} className={`fiber fiber-core ${unsure ? 'unsure' : ''}`} />)
  const light = (key: string, d: string) => (unsure ? amber : lit).push(<path key={key} d={d} className={unsure ? 'fiber-sugg' : 'fiber-light'} />)
  const unknown = (key: string, d: string) => fans.push(<path key={key} d={d} className="fiber fiber-unknown" />)
  /** Brings the light to (x, y): one solid fiber from a single point, open dashed routes from several. */
  const feed = (key: string, x: number, y: number) => {
    if (from.length === 1) {
      const [p] = from
      if (p.x !== x || p.y !== y) {
        core(key, line(p.x, p.y, x, y))
        light(`l${key}`, line(p.x, p.y, x, y))
      }
    } else from.forEach((p, i) => unknown(`${key}-${i}`, curve(p.x, p.y, x, y)))
  }
  /** Several open routes meet again in a small splice before a decided step or the methods. */
  const merge = (key: string, x: number) => {
    if (from.length === 1) return from[0]
    const m = { x, y: midY }
    feed(key, m.x, m.y)
    nodes.push(<circle key={`m${key}`} cx={m.x} cy={m.y} r={3} className="merge-dot" />)
    from = [m]
    return m
  }
  let selPos: (Pt & { leaf?: boolean; h?: number }) | null =
    sel.kind === 'root' ? { x: X0, y: midY } : sel.kind === 'compare' && leaves.length ? { x: leafX, y: leafY(0), leaf: true, h: leafY(leaves.length - 1) - leafY(0) + 46 } : null

  levels.forEach((lv, k) => {
    const isSel = sel.kind === 'node' && sel.id === lv.node.id
    const open = !lv.decided
    const resolved = lv.decided || lv.suggested >= 0
    // branch origin: the previous node, or the junction ("?") in front of an open step
    let bx: number
    let by: number
    if (open) {
      bx = lv.x - GATE_DX
      by = from.length === 1 ? from[0].y : midY
      feed(`t${k}`, bx, by)
    } else ({ x: bx, y: by } = merge(`mg${k}`, lv.x - GATE_DX))
    if (isSel && open) selPos = { x: bx, y: by }
    lv.options.forEach((opt, i) => {
      const y = optY(lv.options.length, i)
      const isChosen = lv.decided && i === lv.chosen
      const isSugg = i === lv.suggested
      const isConflict = lv.conflicting.includes(i)
      const d = curve(bx, by, lv.x, y)
      if (isSel && !open && isChosen) selPos = { x: lv.x, y }
      if (isChosen) {
        core(`f${k}-${i}`, d)
        light(`l${k}`, d)
      } else if (!resolved) unknown(`f${k}-${i}`, d) // nobody knows yet which way it goes
      else fans.push(<path key={`f${k}-${i}`} d={d} className={`fiber ${open ? 'fiber-open' : 'fiber-dim'}`} />)
      if (isSugg) amber.push(<path key={`s${k}`} d={d} className="fiber-sugg" />)
      if (isConflict) amber.push(<path key={`c${k}-${i}`} d={d} className="fiber-conflict" />)
      const lines2 = wrap(lv.def.labels[opt].name)
      nodes.push(
        <g
          key={`n${k}-${i}`}
          className={`tnode ${isChosen ? 'chosen' : ''} ${isSugg ? 'sugg' : ''} ${isConflict ? 'conflict' : ''} ${isSel && (isChosen || isSugg) ? 'sel' : ''} ${lv.status === 'expert' && isChosen ? 'expert' : ''}`}
          role="button"
          tabIndex={0}
          aria-label={`${lv.def.title}: ${lv.def.labels[opt].name}`}
          onClick={() => pickNode(lv.node.id, isChosen ? null : opt)}
          onKeyDown={keyAct(() => pickNode(lv.node.id, isChosen ? null : opt))}
        >
          <rect x={lv.x - 10} y={y - 18} width={COL_W - GATE_DX - 8} height={36} className="hit" />
          <circle cx={lv.x} cy={y} r={isChosen ? 8 : isSugg ? 7 : 5} />
          <text x={lv.x + 13} y={y + 4.5 - (lines2.length - 1) * 7.5}>
            {lines2.map((t, j) => (
              <tspan key={j} x={lv.x + 13} dy={j ? 15 : 0}>
                {t}
              </tspan>
            ))}
          </text>
        </g>,
      )
    })
    if (open) {
      nodes.push(
        <g
          key={`g${k}`}
          className={`gate ${lv.status} ${isSel ? 'sel' : ''}`}
          role="button"
          tabIndex={0}
          aria-label={`${lv.def.title}: ${STATUS_TEXT[lv.status]}`}
          onClick={() => pickNode(lv.node.id)}
          onKeyDown={keyAct(() => pickNode(lv.node.id))}
        >
          <circle cx={bx} cy={by} r={13} />
          <text x={bx} y={by + 5} textAnchor="middle" className="gate-q">
            {lv.status === 'conflict' ? '!' : '?'}
          </text>
          <text x={bx} y={by - 20} textAnchor="middle" className="gate-label">
            {lv.status === 'suggested' ? 'Confirm' : lv.status === 'conflict' ? 'Conflict' : lv.status === 'action' ? 'Missing' : lv.status === 'deferred' ? 'Ask customer' : 'Not stated'}
          </text>
        </g>,
      )
    }
    const out = (i: number): Pt => ({ x: Math.min(labelEnd(lv.x, lv.def.labels[lv.options[i]].name), lv.x + COL_W - GATE_DX - 14), y: optY(lv.options.length, i) })
    if (lv.decided) {
      // a confirmed step ends the uncertain stretch: from here the light is blue again
      unsure = false
      from = [out(lv.chosen)]
    } else if (lv.suggested >= 0) {
      // provisional path through the suggestion – everything after it stays uncertain
      unsure = true
      from = [out(lv.suggested)]
    } else {
      // unresolved: every option (a conflict: both disputed options) stays a possible route
      if (lv.status === 'action' || lv.status === 'conflict') unsure = true
      const routes = lv.conflicting.length ? lv.conflicting : lv.options.map((_, i) => i)
      from = routes.map(out)
    }
  })
  // premise check: customer assumptions the AFS rules contradict (block) or qualify (caution)
  if (premises.length) {
    const gx = leafX - 46
    const gy = from.length === 1 ? from[0].y : midY
    const isSel = sel.kind === 'premises'
    if (isSel) selPos = { x: gx, y: gy }
    feed('pt', gx, gy)
    nodes.push(
      <g
        key="premises"
        className={`gate premise ${blocks ? 'block' : 'caution'} ${isSel ? 'sel' : ''}`}
        role="button"
        tabIndex={0}
        aria-label={`Premise check: ${premises.length} findings`}
        onClick={() => setSel({ kind: 'premises' })}
        onKeyDown={keyAct(() => setSel({ kind: 'premises' }))}
      >
        <circle cx={gx} cy={gy} r={14} />
        <text x={gx} y={gy + 5} textAnchor="middle" className="gate-q">
          !
        </text>
        <text x={gx} y={gy - 22} textAnchor="middle" className="gate-label">
          {blocks ? `${blocks} premise${blocks > 1 ? 's' : ''} to check` : 'Check premises'}
        </text>
      </g>,
    )
    if (blocks) unsure = true
    from = [{ x: gx, y: gy }]
  }
  const src = merge('ml', leafX - 46)
  leaves.forEach((c, i) => {
    const y = leafY(i)
    const isSel = (sel.kind === 'leaf' && sel.setupId === c.setup.id) || sel.kind === 'compare'
    if (isSel && sel.kind === 'leaf') selPos = { x: leafX, y, leaf: true }
    core(`lf${i}`, curve(src.x, src.y, leafX, y))
    light(`ll${i}`, curve(src.x, src.y, leafX, y))
    nodes.push(
      <g
        key={`leaf${i}`}
        className={`leaf ${isSel ? 'sel' : ''} ${provisional ? 'provisional' : ''} ${risks.get(c.setup.id)?.length ? 'at-risk' : ''}`}
        role="button"
        tabIndex={0}
        aria-label={`${METHOD_INFO[c.setup.method].name} – ${c.setup.technique}: why it is worth testing`}
        onClick={() => setSel({ kind: 'leaf', setupId: c.setup.id })}
        onKeyDown={keyAct(() => setSel({ kind: 'leaf', setupId: c.setup.id }))}
      >
        <rect x={leafX - 4} y={y - 19} width={222} height={38} rx={6} className="leaf-hit" />
        <rect x={leafX} y={y - 12} width={8} height={24} rx={2} className="leaf-bar" />
        <text x={leafX + 18} y={y - 2}>
          <tspan className="leaf-rank">{rankLabel(c)} </tspan>
          <tspan className="leaf-m">{METHOD_INFO[c.setup.method].name}</tspan>
          <tspan x={leafX + 18} dy={15} className="leaf-t">
            {c.setup.technique.length > 26 ? c.setup.technique.slice(0, 25).trimEnd() + '…' : c.setup.technique}
          </tspan>
          <title>{`${rankLabel(c)} ${METHOD_INFO[c.setup.method].name} – ${c.setup.technique}`}</title>
        </text>
      </g>,
    )
  })
  if (recommended.length > leaves.length) {
    const y = leafY(leaves.length - 1) + 34
    nodes.push(
      <g key="more" className="leaf-more" role="button" tabIndex={0} onClick={() => setSel({ kind: 'compare' })} onKeyDown={keyAct(() => setSel({ kind: 'compare' }))}>
        <text x={leafX + 18} y={y}>
          +{recommended.length - leaves.length} more worth testing – compare all
        </text>
      </g>,
    )
  }

  const needs = levels.filter((l) => NEEDS.includes(l.status))
  const level = sel.kind === 'node' ? levels.find((l) => l.node.id === sel.id) : undefined
  const leaf = sel.kind === 'leaf' ? assessment.candidates.find((c) => c.setup.id === sel.setupId) : undefined

  // ------------------------------------------------------------ walking through the path
  const go = (s: Selection) => {
    if (s.kind === 'node') pickNode(s.id)
    else {
      setSel(s)
      setDraft(null)
    }
  }
  const prev = idx > 0 ? seq[idx - 1] : null
  const next = idx < seq.length - 1 ? seq[idx + 1] : null
  const isOpenItem = (s: Selection) => (s.kind === 'node' ? needs.some((l) => l.node.id === s.id) : s.kind === 'premises' && blocks > 0)
  const nextOpen = [...seq.slice(idx + 1), ...seq.slice(0, idx)].find(isOpenItem) ?? null
  const titleOf = (s: Selection) => {
    if (s.kind === 'root') return 'Customer enquiry'
    if (s.kind === 'premises') return 'Premise check'
    if (s.kind === 'compare') return 'Compare all methods'
    if (s.kind === 'node') return DIM_BY_ID[s.id].title
    const c = assessment.candidates.find((x) => x.setup.id === s.setupId)
    return c ? `${METHOD_INFO[c.setup.method].name} – ${c.setup.technique}` : 'Method'
  }
  /** The walked-through case as it goes into the knowledge base. */
  const buildCase = (): Omit<SolvedCase, 'createdAt'> => ({
    id: caseId ?? crypto.randomUUID(),
    title: text.trim().slice(0, 90),
    enquiry: text,
    engine: tree.model,
    steps: levels.map((l) => {
      const d = decisionOf(l.node.id)
      const name = (v?: string | null) => (v ? (l.def.labels[v]?.name ?? v) : null)
      const note = notes[l.node.id]?.trim()
      return {
        id: l.node.id,
        title: l.def.title,
        model: { basis: basisOf(d), value: d?.value ?? null, valueName: name(d?.value) },
        value: values[l.node.id],
        valueName: l.status === 'deferred' ? 'Unknown – ask the customer' : (name(values[l.node.id]) ?? values[l.node.id]),
        byExpert: overrides[l.node.id] !== undefined,
        ...(note ? { note } : {}),
      }
    }),
    methods: recommended.map((c) => ({ name: METHOD_INFO[c.setup.method].name, technique: c.setup.technique, rank: c.rank })),
    premises: premises.map((w) => ({ id: w.id, severity: w.severity, text: w.text })),
  })

  // ← / → walk through the path (not while typing, and not while a source document is open)
  const nav = useRef({ prev: () => {}, next: () => {} })
  useEffect(() => {
    nav.current = { prev: () => prev && go(prev), next: () => next && go(next) }
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return
      const t = e.target as HTMLElement | null
      if (t?.closest('input, textarea, select, [contenteditable="true"]')) return
      if (document.querySelector('.viewer-backdrop')) return
      if (!panelRef.current || panelRef.current.offsetParent === null) return
      e.preventDefault()
      if (e.key === 'ArrowLeft') nav.current.prev()
      else nav.current.next()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <section className={`panel tree-panel ${placeholder ? 'is-empty' : ''}`} ref={panelRef} aria-busy={placeholder ? true : undefined}>
      <div className="panel-head">
        <h2>Decision path</h2>
        <span className="hint">Each step is a column of the AFS method table. Click any point or walk through the path with ← →.</span>
      </div>
      <div className="panel-body">
        {placeholder ? null : needs.length > 0 ? (
          <p className="tree-actions">
            Your decision is needed:{' '}
            {needs.map((l, i) => (
              <span key={l.node.id}>
                {i > 0 && ', '}
                <button className="linkbtn" onClick={() => pickNode(l.node.id)}>
                  {l.def.title}
                </button>
                <span className="needs-kind">{l.status === 'suggested' ? ' (suggestion ready)' : l.status === 'conflict' ? ' (customer and sources disagree)' : ' (information missing)'}</span>
              </span>
            ))}
            {suggestions.length > 1 && (
              <>
                {' · '}
                <button className="linkbtn accept-all" onClick={() => suggestions.forEach((l) => onOverride(l.node.id, l.options[l.suggested]))} title={suggestions.map((l) => `${l.def.title}: ${l.def.labels[l.options[l.suggested]].name}`).join('\n')}>
                  Accept all {suggestions.length} suggestions
                </button>
              </>
            )}
            {blocks > 0 && (
              <>
                {' · '}
                <button className="linkbtn" onClick={() => setSel({ kind: 'premises' })}>
                  {blocks} premise{blocks > 1 ? 's' : ''} of the request
                </button>{' '}
                contradict the AFS knowledge
              </>
            )}
          </p>
        ) : blocks > 0 ? (
          <p className="tree-actions conflict">
            <button className="linkbtn" onClick={() => setSel({ kind: 'premises' })}>
              {blocks} premise{blocks > 1 ? 's' : ''} of the request
            </button>{' '}
            contradict the AFS knowledge – check them before answering the customer.
          </p>
        ) : (
          <p className="tree-actions ok">Every blocking step is decided – by a verified quote from the enquiry or by you.</p>
        )}

        {!placeholder && deferred.length > 0 && (
          <p className="tree-actions deferred">
            To ask the customer:{' '}
            {deferred.map((l, i) => (
              <span key={l.node.id}>
                {i > 0 && ' · '}
                <button className="linkbtn" onClick={() => pickNode(l.node.id)} title={l.def.clarification}>
                  {l.def.title}
                </button>
              </span>
            ))}
          </p>
        )}
        <div className="tree-stage">
          {placeholder && (
            <div className="tree-empty-msg">
              <strong>{placeholder.title}</strong>
              <span>{placeholder.text}</span>
            </div>
          )}
          <div className="tree-scroll" inert={placeholder ? true : undefined}>
            <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ minWidth: W * 0.78 }} className="tree-svg" role="group" aria-label="Decision path from the enquiry to the method setups">
              {levels.map((lv, k) => (
                <g
                  key={`h${k}`}
                  className={`thead ${sel.kind === 'node' && sel.id === lv.node.id ? 'sel' : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => pickNode(lv.node.id)}
                  onKeyDown={keyAct(() => pickNode(lv.node.id))}
                >
                  <text x={lv.x - 10} y={18} className="thead-title">
                    {wrap(lv.def.title, 17).map((t, j) => (
                      <tspan key={j} x={lv.x - 10} dy={j ? 15 : 0}>
                        {t}
                      </tspan>
                    ))}
                  </text>
                  <text x={lv.x - 10} y={52} className="thead-sub">
                    {counts[k] === counts[k + 1] ? `${counts[k + 1]} setups · ranks only` : `${counts[k]} → ${counts[k + 1]} setups`}
                  </text>
                </g>
              ))}
              <g
                className={`thead ${sel.kind === 'compare' ? 'sel' : ''}`}
                role="button"
                tabIndex={0}
                aria-label="Compare all methods worth testing"
                onClick={() => recommended.length > 1 && go({ kind: 'compare' })}
                onKeyDown={keyAct(() => recommended.length > 1 && go({ kind: 'compare' }))}
              >
                <text x={leafX} y={18} className="thead-title">
                  {provisional ? 'Provisional shortlist' : 'Worth testing'}
                </text>
                <text x={leafX} y={35} className={`thead-sub ${provisional ? 'thead-prov' : ''}`}>
                  {provisional ? `${openIds.length} step${openIds.length > 1 ? 's' : ''} still open` : 'all steps decided'}
                </text>
                <text x={leafX} y={52} className="thead-sub">
                  {recommended.length} setups{condCount ? ` · ${condCount} conditional` : ''}
                  {recommended.length > 1 ? ' · compare' : ''}
                </text>
              </g>
              <g className="col-sep" aria-hidden="true">
                {levels.map((lv, k) => (
                  <line key={k} x1={lv.x - GATE_DX - 18} x2={lv.x - GATE_DX - 18} y1={2} y2={H - 6} />
                ))}
                <line x1={leafX - 12} x2={leafX - 12} y1={2} y2={H - 6} />
              </g>
              <g>{fans}</g>
              <g className="light">{lit}</g>
              <g>{amber}</g>
              <g
                className={`root ${sel.kind === 'root' ? 'sel' : ''}`}
                role="button"
                tabIndex={0}
                aria-label="Show the customer enquiry"
                onClick={() => setSel({ kind: 'root' })}
                onKeyDown={keyAct(() => setSel({ kind: 'root' }))}
              >
                <rect x={X0 - 34} y={midY - 22} width={68} height={76} className="hit" />
                <circle cx={X0} cy={midY} r={11} />
                <text x={X0} y={midY + 31} textAnchor="middle">
                  Enquiry
                </text>
                <text x={X0} y={midY + 46} textAnchor="middle" className="root-hint">
                  read text
                </text>
              </g>
              <g>{nodes}</g>
              {selPos && (
                <g key={keyOf(sel)} className="sel-ring" aria-hidden="true">
                  {selPos.leaf ? (
                    <rect x={selPos.x - 8} y={selPos.y - 23} width={230} height={selPos.h ?? 46} rx={9} />
                  ) : (
                    <circle cx={selPos.x} cy={selPos.y} r={sel.kind === 'root' ? 21 : 20} />
                  )}
                </g>
              )}
            </svg>
          </div>
          {!placeholder && <div className="tree-nav">
            <button className="tree-nav-btn" disabled={!prev} onClick={() => prev && go(prev)} title={prev ? `Back to ${titleOf(prev)} (←)` : undefined}>
              ‹ Previous
            </button>
            <span className="tree-nav-pos">
              <span className="tree-nav-count">
                {idx + 1} / {seq.length}
              </span>
              {titleOf(sel)}
            </span>
            <button className="tree-nav-btn" disabled={!next} onClick={() => next && go(next)} title={next ? `On to ${titleOf(next)} (→)` : undefined}>
              Next ›
            </button>
            {nextOpen && (
              <button className="tree-nav-open" onClick={() => go(nextOpen)}>
                Next open decision: {titleOf(nextOpen)}
              </button>
            )}
          </div>}
        </div>

        {!placeholder && (
          <>
        {sel.kind === 'root' && <EnquiryDetail text={text} tree={tree} onPick={(id) => pickNode(id)} />}
        {level && (
          <NodeDetail
            key={level.node.id}
            level={level}
            decision={decisionOf(level.node.id)}
            current={values[level.node.id]}
            draft={draft}
            setDraft={setDraft}
            overridden={overrides[level.node.id] !== undefined}
            onOverride={(v) => (onOverride(level.node.id, v), setDraft(null))}
            note={notes[level.node.id] ?? ''}
            onNote={onNote ? (t) => onNote(level.node.id, t) : undefined}
          />
        )}
        {leaf && <LeafDetail c={leaf} all={assessment.candidates} openCount={openIds.length} risks={risks.get(leaf.setup.id) ?? []} />}
        {sel.kind === 'premises' && <PremiseDetail warnings={premises} />}
        {sel.kind === 'compare' && (
          <CompareDetail
            recommended={recommended}
            conditional={assessment.candidates.filter((c) => c.status === 'conditional')}
            inTree={new Set(leaves.map((c) => c.setup.id))}
            openCount={openIds.length}
            risks={risks}
            onOpen={(id) => go({ kind: 'leaf', setupId: id })}
          />
        )}

        <p className="ev-meta">
          {tree.model} · {(tree.latencyMs / 1000).toFixed(1)} s
          {tree.pipeline === 'steps' ? (
            <>
              {' '}· {tree.calls} model calls (one per step, {tree.decisions.find((d) => d.votes)?.votes?.runs ?? 1} runs each, majority vote)
              {tree.docsRead && tree.docsRead.length > 0 && ` · knowledge: ${tree.docsRead.length} documents read completely (${tree.docsRead.reduce((a, d) => a + d.pages, 0)} pages, ${tree.passagesRead} cards)`}
              {tree.sources === 'original' && ' · AFS originals only'}
              {tree.docsUnread && tree.docsUnread.length > 0 && ` · not read yet: ${tree.docsUnread.join(', ')}`}
            </>
          ) : (
            ` · read ${tree.passagesRead} knowledge passages`
          )}
          {' '}· {tree.stats.decided} stated by the customer · {tree.stats.suggested ?? 0} suggested from sources · {tree.stats.verifiedSources} references verified
          {tree.stats.rejectedQuotes > 0 && ` · ${tree.stats.rejectedQuotes} quotes rejected (not found)`}
          {tree.cachedAt && ' · stored result'}
        </p>
          </>
        )}
        {!placeholder && onSaveCase && (
          <CaseSaveBar
            openSteps={unhandled}
            expertSteps={levels.filter((l) => l.status === 'expert').length}
            noted={levels.filter((l) => notes[l.node.id]?.trim()).length}
            savedAt={savedAt}
            onSave={() => onSaveCase(buildCase())}
          />
        )}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------- detail panels

function DetailHead({ title, sub, chip }: { title: string; sub?: string; chip?: ReactNode }) {
  return (
    <div className="td-head">
      <div>
        <strong>{title}</strong>
        {sub && <span className="td-col">{sub}</span>}
      </div>
      {chip}
    </div>
  )
}

/** The customer's text with every verified quote marked; a mark opens its step. */
function EnquiryDetail({ text, tree, onPick }: { text: string; tree: TreeResponse; onPick: (id: string) => void }) {
  const treeIds = new Set(TREE_NODES.map((n) => n.id))
  const quotes = tree.decisions.filter((d) => d.value && d.enquiryQuote)
  // locate quotes in the original text (exact first, then case-insensitive)
  const spans: { start: number; end: number; d: Decision }[] = []
  for (const d of quotes) {
    const q = d.enquiryQuote!.trim()
    let i = text.indexOf(q)
    if (i < 0) i = text.toLowerCase().indexOf(q.toLowerCase())
    if (i >= 0 && !spans.some((s) => i < s.end && i + q.length > s.start)) spans.push({ start: i, end: i + q.length, d })
  }
  spans.sort((a, b) => a.start - b.start)
  const parts: ReactNode[] = []
  let at = 0
  spans.forEach((s, k) => {
    parts.push(text.slice(at, s.start))
    const def = DIM_BY_ID[s.d.id]
    const label = def.kind === 'flag' ? def.title : `${def.title}: ${def.labels[s.d.value!]?.name}`
    parts.push(
      treeIds.has(s.d.id) ? (
        <button key={k} className="eq-mark tree" title={label} onClick={() => onPick(s.d.id)}>
          {text.slice(s.start, s.end)}
        </button>
      ) : (
        <mark key={k} className="eq-mark" title={label}>
          {text.slice(s.start, s.end)}
        </mark>
      ),
    )
    at = s.end
  })
  parts.push(text.slice(at))
  return (
    <div className="tree-detail root-detail">
      <DetailHead title="Customer enquiry" sub="Marked passages are the verified evidence the model used. Click a blue one to open its step." />
      <p className="eq-text">{parts}</p>
      {spans.length > 0 && (
        <ul className="eq-legend">
          {spans.map((s, k) => {
            const def = DIM_BY_ID[s.d.id]
            return (
              <li key={k}>
                <span className="td-label">{def.title}</span>
                {def.kind === 'flag' ? 'mentioned' : def.labels[s.d.value!]?.name}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/** Reasoning text with [1], [2, 3] markers turned into reference chips that open the cited page. */
function ReasoningText({ text, refs }: { text: string; refs: SourcePassage[] }) {
  const open = useOpenSource()
  const parts = text.split(/(\[\d+(?:,\s*\d+)*\])/g)
  return (
    <p className="td-text">
      {parts.map((part, i) => {
        const m = part.match(/^\[(\d+(?:,\s*\d+)*)\]$/)
        if (!m) return <span key={i}>{part}</span>
        return (
          <span key={i} className="ref-group">
            {m[1].split(/,\s*/).map((n) => {
              const r = refs[Number(n) - 1]
              if (!r) return null
              return (
                <button key={n} className="ref-chip" title={`${r.claim ? r.claim + '\n' : ''}${r.docTitle}, p.${r.page} – open with the passage highlighted`} onClick={() => open({ source: r.docId, page: r.page, quote: r.quote, title: r.docTitle })}>
                  {n}
                </button>
              )
            })}
          </span>
        )
      })}
    </p>
  )
}

function RefList({ refs, numbered }: { refs: SourcePassage[]; numbered: boolean }) {
  const open = useOpenSource()
  return (
    <ol className={`ref-list ${numbered ? '' : 'plain'}`}>
      {refs.map((r, i) => (
        <li key={i}>
          <button className="ref-line" title={`${r.docTitle}: “${r.quote}”`} onClick={() => open({ source: r.docId, page: r.page, quote: r.quote, title: r.docTitle })}>
            {numbered && <span className="ref-chip static">{i + 1}</span>}
            <span className="ref-doc">
              {r.docId} p.{r.page}
            </span>
            <span className="ref-title">{r.claim ?? r.docTitle}</span>
            <span className="ref-open">open ›</span>
          </button>
        </li>
      ))}
    </ol>
  )
}

interface Level {
  node: { id: string; column: string }
  def: (typeof DIM_BY_ID)[string]
  options: string[]
  status: NodeStatus
  decided: boolean
}

function NodeDetail(p: {
  level: Level
  decision?: Decision
  current: string
  draft: string | null
  setDraft: (v: string | null) => void
  overridden: boolean
  onOverride: (v: string | undefined) => void
  note: string
  onNote?: (text: string) => void
}) {
  const { level: lv, decision: d } = p
  const refs = d?.refs ?? []
  const related = d?.related ?? []
  const name = (v?: string | null) => (v ? lv.def.labels[v]?.name : undefined)
  const suggestion = lv.status === 'suggested' ? d?.value : null

  let headline: ReactNode
  if (lv.status === 'decided') headline = <>Stated by the customer: <strong>{name(p.current)}</strong></>
  else if (lv.status === 'expert') headline = <>Decided by you: <strong>{name(p.current)}</strong>{d?.value && d.value !== p.current ? <span className="td-small"> (model: {name(d.value)})</span> : null}</>
  else if (lv.status === 'conflict' && d?.value)
    headline = (
      <>
        Conflict: the customer text says <strong>{name(d.value)}</strong>, the AFS sources point to <strong>{name(d.alternative)}</strong>
      </>
    )
  else if (suggestion)
    headline = refs.length ? (
      <>
        Suggested from the AFS sources: <strong>{name(suggestion)}</strong>
      </>
    ) : (
      <>
        Likely from the customer text: <strong>{name(suggestion)}</strong> – please confirm
      </>
    )
  else if (lv.status === 'deferred')
    headline = (
      <>
        Left open by you – ask the customer: <span className="td-missing">{lv.def.clarification ?? lv.def.question}</span>
      </>
    )
  else headline = <>Information missing{d?.missing ? <>: <span className="td-missing">{d.missing}</span></> : null}</>

  return (
    <div className={`tree-detail ${lv.status}`}>
      <div className="td-head">
        <div>
          <strong>{lv.def.title}</strong>
          <span className="td-col">Method table column: {lv.node.column}</span>
        </div>
        <span className={`chip ${STATUS_CHIP[lv.status]}`}>{STATUS_TEXT[lv.status]}</span>
      </div>

      {/* decision first: the expert sees the proposal and can accept or change it right away */}
      <div className={`td-decide ${lv.status}`}>
        <p className="td-headline">
          {headline}
          {d?.votes && d.votes.runs > 1 && (
            <span className={`votes ${d.votes.agree === d.votes.runs ? 'all' : d.votes.agree > d.votes.runs / 2 ? 'most' : 'none'}`} title={d.votes.outcomes.map((o) => `${o.label} ×${o.count}`).join('\n')}>
              {d.votes.agree > d.votes.runs / 2 ? `${d.votes.agree}/${d.votes.runs} runs agree` : `runs disagree`}
            </span>
          )}
        </p>
        <div className="td-choose">
          {lv.options.map((o) => (
            <button key={o} className={`pill ${p.draft === o ? 'on' : ''} ${lv.decided && p.current === o ? 'current' : ''} ${suggestion === o ? 'sugg' : ''}`} onClick={() => p.setDraft(o)}>
              {lv.def.labels[o].name}
            </button>
          ))}
          <button className="btn small primary" disabled={!p.draft || (lv.decided && p.draft === p.current)} onClick={() => p.draft && p.onOverride(p.draft)}>
            {suggestion && p.draft === suggestion ? 'Accept suggestion' : 'Confirm'}
          </button>
          {lv.status !== 'deferred' && lv.def.unknownLabel && (
            <button className="btn small ask-btn" onClick={() => p.onOverride(lv.def.unknownLabel)} title="The information is not available: leave the step open and collect it as a question for the customer">
              Still unknown – ask the customer
            </button>
          )}
          {p.overridden && (
            <button className="linkbtn" onClick={() => p.onOverride(undefined)}>
              Reset to model
            </button>
          )}
        </div>
      </div>

      <div className="td-body">
        {d?.clef && <ClefTrace d={d} def={lv.def} />}
        <h4>Reasoning</h4>
        {d?.reasoning ? <ReasoningText text={d.reasoning} refs={refs} /> : <p className="td-small">No reasoning available for this step.</p>}
        {d?.basis === 'customer' && d.enquiryQuote && (
          <p className="td-small">
            Customer wrote: <q className="td-q">{d.enquiryQuote}</q>
          </p>
        )}
        {d?.rejected && <p className="td-rejected">{d.rejected}</p>}
        {d?.check && (
          <div className="td-check">
            <strong>Check against AFS knowledge</strong>
            <p>{d.check}</p>
          </div>
        )}

        {refs.length > 0 && (
          <>
            <h4>References</h4>
            <RefList refs={refs} numbered />
          </>
        )}
        {related.length > 0 && (
          <details className="td-related">
            <summary>Other passages searched for this step ({related.length})</summary>
            <RefList refs={related} numbered={false} />
          </details>
        )}
      </div>

      {p.onNote && (
        <label className={`td-note ${lv.status === 'decided' && !p.note ? 'quiet' : ''}`}>
          <span>
            Expert note <small>– why you decided this way. It is saved with the case when you add it to the knowledge base.</small>
          </span>
          <textarea
            rows={2}
            value={p.note}
            onChange={(e) => p.onNote!(e.target.value)}
            placeholder={lv.status === 'decided' ? 'Optional – e.g. confirmed with the customer.' : 'e.g. Customer confirmed by phone that the slurry is opaque and varies with solids content.'}
          />
        </label>
      )}
    </div>
  )
}

const certainty = (c: number) => (c >= DEFAULT_SETTINGS.confidentAt ? 'clear' : c >= 0.3 ? 'tentative' : 'unclear')

/** How the classifier reached the decision – in words, not percentages. */
function ClefTrace({ d, def }: { d: Decision; def: Level['def'] }) {
  const c = d.clef!
  const lab = (v: string) => (v === def.unknownLabel ? 'not stated' : (def.labels[v]?.name ?? v))
  return (
    <div className="clef-trace">
      <span>
        <span className="td-label">Customer text</span>
        {lab(c.text.value)} <em>({certainty(c.text.confidence)})</em>
      </span>
      <span>
        <span className="td-label">With AFS knowledge</span>
        {c.relevantCards ? (
          <>
            {lab(c.withSources.value)} <em>({certainty(c.withSources.confidence)})</em> · {c.relevantCards} statement{c.relevantCards > 1 ? 's' : ''} apply
          </>
        ) : (
          'no statement applies to this case'
        )}
      </span>
    </div>
  )
}

function PremiseDetail({ warnings }: { warnings: Assessment['warnings'] }) {
  return (
    <div className="tree-detail premise-detail">
      <div className="td-head">
        <div>
          <strong>Premise check</strong>
          <span className="td-col">Assumptions in the request, checked against the AFS rules and sources</span>
        </div>
      </div>
      <ul className="premise-list">
        {warnings.map((w) => (
          <li key={w.id} className={w.severity}>
            <span className={`chip premise-${w.severity}`}>{w.severity === 'block' ? 'Contradicts AFS knowledge' : 'Needs checking'}</span>
            <span>{w.text}</span>
            <CiteLink c={w.citation} />
          </li>
        ))}
      </ul>
    </div>
  )
}

const EFFECT_MARK: Record<string, string> = { plus: '+', minus: '–', condition: '!', exclude: '×', info: 'i' }

/** Where a setup stands in the ranking and why, in one sentence. */
function rankText(c: Candidate, all: Candidate[]): string {
  if (!c.rank) return ''
  const open = all.filter((x) => x.status === c.status)
  const peers = all.filter((x) => x !== c && x.rank === c.rank).map((x) => `${METHOD_INFO[x.setup.method].name} ${x.setup.technique}`)
  const pos = `Rank #${c.rank} of ${open.length} ${c.status === 'recommended' ? 'setups worth testing' : 'conditional setups'}`
  if (c.tied && peers.length) return `${pos}, tied with ${peers.slice(0, 2).join(' and ')}${peers.length > 2 ? ` and ${peers.length - 2} more` : ''}: the AFS material gives no reason to prefer one of them.`
  return c.aheadBecause ? `${pos}. Ahead of the next setup because of ${c.aheadBecause}.` : `${pos}.`
}

/** “Drops out if …” / “Becomes conditional if …” for the open steps. */
function riskLines(risks: OpenRisk[]): string[] {
  const by = (status: OpenRisk['status']) => {
    const groups = new Map<string, string[]>()
    for (const r of risks.filter((x) => x.status === status)) groups.set(r.dimensionId, [...(groups.get(r.dimensionId) ?? []), DIM_BY_ID[r.dimensionId].labels[r.label].name])
    return [...groups].map(([id, labels]) => `${DIM_BY_ID[id].title} = ${labels.join(' or ')}`)
  }
  return [...by('excluded').map((t) => `Drops out if ${t}`), ...by('conditional').map((t) => `Becomes conditional if ${t}`)]
}

function ProvisionalNote({ openCount, risks }: { openCount: number; risks: OpenRisk[] }) {
  if (!openCount) return null
  const lines = riskLines(risks)
  return (
    <div className="prov-note">
      <strong>Provisional – {openCount} step{openCount > 1 ? 's are' : ' is'} still open.</strong>{' '}
      {lines.length ? 'The open steps can still change this setup:' : 'None of the open steps can remove this setup; only its rank can still change.'}
      {lines.length > 0 && (
        <ul>
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

function LeafDetail({ c, all, openCount, risks }: { c: Candidate; all: Candidate[]; openCount: number; risks: OpenRisk[] }) {
  const m = METHOD_INFO[c.setup.method]
  const pros = c.reasons.filter((r) => r.effect === 'plus')
  const rest = c.reasons.filter((r) => r.effect !== 'plus')
  const depth = c.setup.depthUm ? `${c.setup.depthUm[0]}–${c.setup.depthUm[1]} µm` : 'n/a'
  return (
    <div className="tree-detail leaf-detail">
      <DetailHead title={`${m.name} · ${c.setup.technique}`} sub={`${c.setup.phenomenon} · ${m.rangeText}`} chip={openCount ? <span className="chip conditional">Provisional</span> : <span className="chip recommended">Worth testing</span>} />
      {c.rank && <p className="leaf-rank-text">{rankText(c, all)}</p>}
      <ProvisionalNote openCount={openCount} risks={risks} />
      <p className="td-text">
        {pros.length
          ? `Worth testing because ${pros.map((r) => r.text.replace(/\.$/, '').replace(/^./, (x) => x.toLowerCase())).join('; ')}.`
          : 'No rule from the AFS material speaks against this setup for the stated facts.'}
        {' '}It is a starting point for a feasibility test, not a final specification.
      </p>
      <dl className="leaf-facts">
        <div>
          <dt>Sensitivity</dt>
          <dd>{c.setup.sensitivity}</dd>
        </div>
        <div>
          <dt>Selectivity</dt>
          <dd>{c.setup.selectivity}</dd>
        </div>
        <div>
          <dt>Cost</dt>
          <dd>{c.setup.cost}</dd>
        </div>
        <div>
          <dt>Optical path</dt>
          <dd>{depth}</dd>
        </div>
        <div>
          <dt>Samples</dt>
          <dd>{c.setup.sampleTypes.join(', ')}</dd>
        </div>
      </dl>
      <ul className="leaf-reasons">
        {[...pros, ...rest].map((r, i) => (
          <li key={i} className={r.effect}>
            <span className="mark">{EFFECT_MARK[r.effect]}</span>
            <span>{r.text}</span>
            <CiteLink c={r.citation} />
          </li>
        ))}
        <li className="info">
          <span className="mark">i</span>
          <span>Row in the AFS method comparison table</span>
          <CiteLink c={c.setup.citation} />
        </li>
      </ul>
    </div>
  )
}

// ---------------------------------------------------------------- comparison of the final methods

const LEVEL_TEXT: Record<Grade, string> = { low: 'Low', average: 'Average', high: 'High' }
const LEVEL_RANK: Record<Grade, number> = { low: 0, average: 1, high: 2 }

/** All setups worth testing side by side: the same rows for every method, best value per row marked. */
const TOP_N = 3

function CompareDetail({
  recommended,
  conditional,
  inTree,
  openCount,
  risks,
  onOpen,
}: {
  recommended: Candidate[]
  conditional: Candidate[]
  inTree: Set<string>
  openCount: number
  risks: Map<string, OpenRisk[]>
  onOpen: (setupId: string) => void
}) {
  type View = 'top' | 'all' | 'conditional'
  const [view, setView] = useState<View>(recommended.length > TOP_N ? 'top' : 'all')
  const list = view === 'top' ? recommended.slice(0, TOP_N) : view === 'all' ? recommended : [...recommended, ...conditional]
  const views: [View, string][] = [
    ...(recommended.length > TOP_N ? [['top', `Top ${TOP_N}`] as [View, string]] : []),
    ['all', `All ${recommended.length} worth testing`],
    ...(conditional.length ? [['conditional', `+ ${conditional.length} conditional`] as [View, string]] : []),
  ]
  // for sensitivity and selectivity higher is better, for cost lower is better
  const best = (get: (c: Candidate) => Grade, higher: boolean) => {
    const ranks = list.map((c) => LEVEL_RANK[get(c)])
    const top = higher ? Math.max(...ranks) : Math.min(...ranks)
    return (c: Candidate) => ranks.some((r) => r !== top) && LEVEL_RANK[get(c)] === top
  }
  const levelRows: { label: string; get: (c: Candidate) => Grade; higher: boolean; hint: string }[] = [
    { label: 'Sensitivity', get: (c) => c.setup.sensitivity, higher: true, hint: 'higher is better' },
    { label: 'Selectivity', get: (c) => c.setup.selectivity, higher: true, hint: 'higher is better' },
    { label: 'Cost', get: (c) => c.setup.cost, higher: false, hint: 'lower is better' },
  ]
  const depth = (c: Candidate) => (c.setup.depthUm ? `${c.setup.depthUm[0]}–${c.setup.depthUm[1]} µm` : 'n/a')
  const pros = (c: Candidate) => c.reasons.filter((r) => r.effect === 'plus')
  const cons = (c: Candidate) => c.reasons.filter((r) => r.effect === 'minus' || r.effect === 'condition')
  const notes = (c: Candidate) => c.reasons.filter((r) => r.effect === 'info')
  const reasonCell = (rs: Candidate['reasons'], kind: string) =>
    rs.length ? (
      <ul className={`cmp-reasons ${kind}`}>
        {rs.map((r, i) => (
          <li key={i}>
            <span className="mark">{EFFECT_MARK[r.effect]}</span>
            <span>
              {r.text} <CiteLink c={r.citation} />
            </span>
          </li>
        ))}
      </ul>
    ) : (
      <span className="cmp-none">–</span>
    )

  return (
    <div className="tree-detail compare-detail">
      <DetailHead
        title={openCount ? 'Compare the provisional shortlist' : 'Compare the methods worth testing'}
        sub="Ranked by fit (#1 first), with the same criteria for every setup from the AFS method table and the rules. Green marks the best value in a row."
        chip={
          views.length > 1 ? (
            <div className="cmp-views" role="group" aria-label="Setups to compare">
              {views.map(([k, label]) => (
                <button key={k} className={view === k ? 'on' : ''} aria-pressed={view === k} onClick={() => setView(k)}>
                  {label}
                </button>
              ))}
            </div>
          ) : undefined
        }
      />
      {openCount > 0 && (
        <p className="prov-note">
          <strong>Provisional – {openCount} step{openCount > 1 ? 's are' : ' is'} still open.</strong> The row “Can still change” shows which answers would remove or
          restrict a setup.
        </p>
      )}
      <div className="cmp-scroll">
        <table className="cmp-table">
          <thead>
            <tr>
              <th />
              {list.map((c) => (
                <th key={c.setup.id} className={c.status}>
                  <button className="cmp-head" onClick={() => onOpen(c.setup.id)} disabled={!inTree.has(c.setup.id)} title={inTree.has(c.setup.id) ? 'Open this method in the path' : undefined}>
                    {c.rank && (
                      <span className="cmp-rank" title={c.tied ? 'Tied – the AFS material gives no reason to prefer one of them' : c.aheadBecause ? `Ahead of the next because of ${c.aheadBecause}` : undefined}>
                        #{c.rank}
                        {c.tied ? ' (tied)' : ''}
                      </span>
                    )}
                    <strong>{METHOD_INFO[c.setup.method].name}</strong>
                    <span>{c.setup.technique}</span>
                  </button>
                  <span className={`chip ${c.status}`}>{c.status === 'recommended' ? 'Worth testing' : 'Conditional'}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <th>Principle</th>
              {list.map((c) => (
                <td key={c.setup.id}>
                  {c.setup.phenomenon}
                  <span className="cmp-sub">{METHOD_INFO[c.setup.method].rangeText}</span>
                </td>
              ))}
            </tr>
            {levelRows.map((row) => {
              const isBest = best(row.get, row.higher)
              return (
                <tr key={row.label}>
                  <th>
                    {row.label}
                    <span className="cmp-sub">{row.hint}</span>
                  </th>
                  {list.map((c) => (
                    <td key={c.setup.id} className={isBest(c) ? 'best' : ''}>
                      <span className={`lvl lvl-${row.get(c)} ${row.higher ? '' : 'inverse'}`}>
                        <span className="lvl-bar" aria-hidden="true">
                          <i />
                          <i />
                          <i />
                        </span>
                        {LEVEL_TEXT[row.get(c)]}
                      </span>
                    </td>
                  ))}
                </tr>
              )
            })}
            <tr>
              <th>Optical path</th>
              {list.map((c) => (
                <td key={c.setup.id}>{depth(c)}</td>
              ))}
            </tr>
            <tr>
              <th>Samples</th>
              {list.map((c) => (
                <td key={c.setup.id}>{c.setup.sampleTypes.join(', ')}</td>
              ))}
            </tr>
            <tr>
              <th>Installation</th>
              {list.map((c) => (
                <td key={c.setup.id}>
                  {c.setup.labOnly ? 'Laboratory only' : 'In-line possible'}
                  <span className="cmp-sub">{c.setup.nonContact ? 'non-contact' : 'in contact with the sample'}</span>
                </td>
              ))}
            </tr>
            <tr>
              <th>Pros</th>
              {list.map((c) => (
                <td key={c.setup.id}>{reasonCell(pros(c), 'pros')}</td>
              ))}
            </tr>
            <tr>
              <th>Cons and conditions</th>
              {list.map((c) => (
                <td key={c.setup.id}>{reasonCell(cons(c), 'cons')}</td>
              ))}
            </tr>
            {list.some((c) => notes(c).length) && (
              <tr>
                <th>Notes</th>
                {list.map((c) => (
                  <td key={c.setup.id}>{reasonCell(notes(c), 'notes')}</td>
                ))}
              </tr>
            )}
            {openCount > 0 && (
              <tr>
                <th>Can still change</th>
                {list.map((c) => {
                  const lines = riskLines(risks.get(c.setup.id) ?? [])
                  return (
                    <td key={c.setup.id} className={lines.length ? 'at-risk' : ''}>
                      {lines.length ? (
                        <ul className="cmp-risks">
                          {lines.map((l) => (
                            <li key={l}>{l}</li>
                          ))}
                        </ul>
                      ) : (
                        <span className="cmp-none">Stays on the list</span>
                      )}
                    </td>
                  )
                })}
              </tr>
            )}
            <tr>
              <th>Source</th>
              {list.map((c) => (
                <td key={c.setup.id}>
                  <CiteLink c={c.setup.citation} />
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <p className="td-small">Every setup here is a starting point for a feasibility test, not a final specification.</p>
    </div>
  )
}

// ---------------------------------------------------------------- adding the solved case to the knowledge base

function CaseSaveBar({ openSteps, expertSteps, noted, savedAt, onSave }: { openSteps: number; expertSteps: number; noted: number; savedAt?: string; onSave: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const save = async () => {
    setBusy(true)
    setError('')
    try {
      await onSave()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const done = openSteps === 0
  return (
    <div className={`case-save ${done ? 'ready' : ''} ${savedAt ? 'saved' : ''}`}>
      <div className="case-save-text">
        {done ? (
          savedAt ? (
            <>
              <strong>Added to the knowledge base</strong> as a solved case · {new Date(savedAt).toLocaleString()}. Changes since then can be saved again.
            </>
          ) : (
            <>
              <strong>Every step is decided.</strong> Add this case to the knowledge base as a worked example – with the enquiry, your {expertSteps} decision
              {expertSteps === 1 ? '' : 's'} and {noted} note{noted === 1 ? '' : 's'}.
            </>
          )
        ) : (
          <>
            <strong>Solved case:</strong> decide the {openSteps} open step{openSteps > 1 ? 's' : ''} to add this enquiry to the knowledge base. Add a note to each
            decision you make – it explains your reasoning to colleagues.
          </>
        )}
        {error && <span className="error"> {error}</span>}
      </div>
      <button className="btn primary" disabled={!done || busy} onClick={save}>
        {busy ? 'Saving…' : savedAt ? 'Save again' : 'Add to knowledge base'}
      </button>
    </div>
  )
}

