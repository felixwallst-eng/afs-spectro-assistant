import { useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { DIM_BY_ID } from '../../shared/dimensions.ts'
import { METHOD_INFO } from '../../shared/knowledge.ts'
import { TREE_NODES } from '../../shared/tree.ts'
import type { Decision, SourcePassage, TreeResponse } from '../../shared/tree.ts'
import type { Assessment, Candidate, MethodSetup } from '../../shared/types.ts'
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
const LANE_Y = HEAD + 32 // bypass lane used after an unresolved step
const OPT_TOP = LANE_Y + 58

const STATUS_TEXT: Record<NodeStatus, string> = {
  decided: 'Stated by the customer',
  suggested: 'Suggestion – please confirm',
  conflict: 'Conflict – customer text and AFS sources disagree',
  expert: 'Decided by the expert',
  action: 'Information missing – blocks the decision',
  minor: 'Information missing – does not block the decision',
}
const STATUS_CHIP: Record<NodeStatus, string> = { decided: 'confident', suggested: 'uncertain', conflict: 'unknown', expert: 'expert', action: 'unknown', minor: 'clef' }

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

type Selection = { kind: 'root' } | { kind: 'node'; id: string } | { kind: 'leaf'; setupId: string } | { kind: 'premises' }

export default function DecisionTree({ tree, text, assessment, methods, overrides, onOverride }: Props) {
  const [sel, setSel] = useState<Selection | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
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
  const leaves = assessment.candidates.filter((c) => c.status === 'recommended').slice(0, 6)
  const condCount = assessment.candidates.filter((c) => c.status === 'conditional').length
  const leafX = COL_X(TREE_NODES.length) + 4
  const leafY = (i: number) => midY + (i - (leaves.length - 1) / 2) * ROW_H
  const W = leafX + 225
  const H = OPT_TOP + maxOpts * ROW_H

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
  let px = X0
  let py = midY
  let unsure = false
  const fans: ReactElement[] = []
  const lit: ReactElement[] = []
  const amber: ReactElement[] = [] // provisional light, kept out of the blue glow
  const nodes: ReactElement[] = []
  const core = (key: string, d: string) => fans.push(<path key={key} d={d} className={`fiber fiber-core ${unsure ? 'unsure' : ''}`} />)
  const light = (key: string, d: string) => (unsure ? amber : lit).push(<path key={key} d={d} className={unsure ? 'fiber-sugg' : 'fiber-light'} />)
  levels.forEach((lv, k) => {
    const isSel = sel?.kind === 'node' && sel.id === lv.node.id
    const open = !lv.decided
    // branch origin: the previous node, or the junction in front of an open step
    const bx = open ? lv.x - GATE_DX : px
    const by = py
    if (open) {
      core(`t${k}`, line(px, py, bx, by))
      light(`lt${k}`, line(px, py, bx, by))
    }
    lv.options.forEach((opt, i) => {
      const y = optY(lv.options.length, i)
      const isChosen = lv.decided && i === lv.chosen
      const isSugg = i === lv.suggested
      const isConflict = lv.conflicting.includes(i)
      const d = curve(bx, by, lv.x, y)
      if (isChosen) {
        core(`f${k}-${i}`, d)
        light(`l${k}`, d)
      } else fans.push(<path key={`f${k}-${i}`} d={d} className={`fiber ${open ? 'fiber-open' : 'fiber-dim'}`} />)
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
            {lv.status === 'suggested' ? 'Confirm' : lv.status === 'conflict' ? 'Conflict' : lv.status === 'action' ? 'Missing' : 'Not stated'}
          </text>
        </g>,
      )
    }
    const labelOut = (i: number) => Math.min(labelEnd(lv.x, lv.def.labels[lv.options[i]].name), lv.x + COL_W - GATE_DX - 14)
    if (lv.decided) {
      // a confirmed step ends the uncertain stretch: from here the light is blue again
      unsure = false
      px = labelOut(lv.chosen)
      py = optY(lv.options.length, lv.chosen)
    } else if (lv.suggested >= 0) {
      // provisional path through the suggestion – everything after it stays uncertain
      unsure = true
      px = labelOut(lv.suggested)
      py = optY(lv.options.length, lv.suggested)
    } else {
      // unresolved: the fiber bypasses this column along the top lane
      if (lv.status === 'action' || lv.status === 'conflict') unsure = true
      fans.push(<path key={`b${k}`} d={curve(bx, by, lv.x, LANE_Y)} className="fiber fiber-bypass" />)
      if (unsure) amber.push(<path key={`bl${k}`} d={curve(bx, by, lv.x, LANE_Y)} className="fiber-sugg" />)
      nodes.push(<circle key={`bp${k}`} cx={lv.x} cy={LANE_Y} r={2.5} className="bypass-dot" />)
      px = lv.x
      py = LANE_Y
    }
  })
  // premise check: customer assumptions the AFS rules contradict (block) or qualify (caution)
  const premises = assessment.warnings
  const blocks = premises.filter((w) => w.severity === 'block').length
  if (premises.length) {
    const gx = leafX - 46
    const isSel = sel?.kind === 'premises'
    core('pt', line(px, py, gx, py))
    light('plt', line(px, py, gx, py))
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
        <circle cx={gx} cy={py} r={14} />
        <text x={gx} y={py + 5} textAnchor="middle" className="gate-q">
          !
        </text>
        <text x={gx} y={py - 22} textAnchor="middle" className="gate-label">
          {blocks ? `${blocks} premise${blocks > 1 ? 's' : ''} to check` : 'Check premises'}
        </text>
      </g>,
    )
    if (blocks) unsure = true
    px = gx
  }
  leaves.forEach((c, i) => {
    const y = leafY(i)
    const isSel = sel?.kind === 'leaf' && sel.setupId === c.setup.id
    core(`lf${i}`, curve(px, py, leafX, y))
    light(`ll${i}`, curve(px, py, leafX, y))
    nodes.push(
      <g
        key={`leaf${i}`}
        className={`leaf ${isSel ? 'sel' : ''}`}
        role="button"
        tabIndex={0}
        aria-label={`${METHOD_INFO[c.setup.method].name} – ${c.setup.technique}: why it is worth testing`}
        onClick={() => setSel({ kind: 'leaf', setupId: c.setup.id })}
        onKeyDown={keyAct(() => setSel({ kind: 'leaf', setupId: c.setup.id }))}
      >
        <rect x={leafX - 4} y={y - 19} width={222} height={38} rx={6} className="leaf-hit" />
        <rect x={leafX} y={y - 12} width={8} height={24} rx={2} className="leaf-bar" />
        <text x={leafX + 18} y={y - 2}>
          <tspan className="leaf-m">{METHOD_INFO[c.setup.method].name}</tspan>
          <tspan x={leafX + 18} dy={15} className="leaf-t">
            {c.setup.technique.length > 26 ? c.setup.technique.slice(0, 25).trimEnd() + '…' : c.setup.technique}
          </tspan>
          <title>{`${METHOD_INFO[c.setup.method].name} – ${c.setup.technique}`}</title>
        </text>
      </g>,
    )
  })

  const needs = levels.filter((l) => l.status === 'suggested' || l.status === 'action' || l.status === 'conflict')
  const level = sel?.kind === 'node' ? levels.find((l) => l.node.id === sel.id) : undefined
  const leaf = sel?.kind === 'leaf' ? assessment.candidates.find((c) => c.setup.id === sel.setupId) : undefined

  return (
    <section className="panel tree-panel">
      <div className="panel-head">
        <h2>Decision path</h2>
        <span className="hint">Each step is a column of the AFS method table. Click the enquiry, any step or a method for its reasoning.</span>
      </div>
      <div className="panel-body">
        {needs.length > 0 ? (
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

        <div className="tree-scroll">
          <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ minWidth: W * 0.78 }} className="tree-svg" role="group" aria-label="Decision path from the enquiry to the method setups">
            {levels.map((lv, k) => (
              <g
                key={`h${k}`}
                className={`thead ${sel?.kind === 'node' && sel.id === lv.node.id ? 'sel' : ''}`}
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
            <text x={leafX} y={18} className="thead-title">
              Worth testing
            </text>
            <text x={leafX} y={52} className="thead-sub">
              {leaves.length} setups{condCount ? ` · ${condCount} conditional` : ''}
            </text>
            <g>{fans}</g>
            <g className="light">{lit}</g>
            <g>{amber}</g>
            <g
              className={`root ${sel?.kind === 'root' ? 'sel' : ''}`}
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
          </svg>
        </div>

        {sel?.kind === 'root' && <EnquiryDetail text={text} tree={tree} onClose={() => setSel(null)} onPick={(id) => pickNode(id)} />}
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
            onClose={() => setSel(null)}
          />
        )}
        {leaf && <LeafDetail c={leaf} onClose={() => setSel(null)} />}
        {sel?.kind === 'premises' && <PremiseDetail warnings={premises} onClose={() => setSel(null)} />}

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
      </div>
    </section>
  )
}

// ---------------------------------------------------------------- detail panels

function DetailHead({ title, sub, chip, onClose }: { title: string; sub?: string; chip?: ReactNode; onClose: () => void }) {
  return (
    <div className="td-head">
      <div>
        <strong>{title}</strong>
        {sub && <span className="td-col">{sub}</span>}
      </div>
      {chip}
      <button className="linkbtn" onClick={onClose}>
        Close
      </button>
    </div>
  )
}

/** The customer's text with every verified quote marked; a mark opens its step. */
function EnquiryDetail({ text, tree, onClose, onPick }: { text: string; tree: TreeResponse; onClose: () => void; onPick: (id: string) => void }) {
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
      <DetailHead title="Customer enquiry" sub="Marked passages are the verified evidence the model used. Click a blue one to open its step." onClose={onClose} />
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
  onClose: () => void
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
  else headline = <>Information missing{d?.missing ? <>: <span className="td-missing">{d.missing}</span></> : null}</>

  return (
    <div className={`tree-detail ${lv.status}`}>
      <div className="td-head">
        <div>
          <strong>{lv.def.title}</strong>
          <span className="td-col">Method table column: {lv.node.column}</span>
        </div>
        <span className={`chip ${STATUS_CHIP[lv.status]}`}>{STATUS_TEXT[lv.status]}</span>
        <button className="linkbtn" onClick={p.onClose}>
          Close
        </button>
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
    </div>
  )
}

const certainty = (c: number) => (c >= 0.65 ? 'clear' : c >= 0.3 ? 'tentative' : 'unclear')

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

function PremiseDetail({ warnings, onClose }: { warnings: Assessment['warnings']; onClose: () => void }) {
  return (
    <div className="tree-detail premise-detail">
      <div className="td-head">
        <div>
          <strong>Premise check</strong>
          <span className="td-col">Assumptions in the request, checked against the AFS rules and sources</span>
        </div>
        <button className="linkbtn" onClick={onClose}>
          Close
        </button>
      </div>
      <ul className="premise-list">
        {warnings.map((w) => (
          <li key={w.id} className={w.severity}>
            <span className={`chip ${w.severity === 'block' ? 'unknown' : 'uncertain'}`}>{w.severity === 'block' ? 'Contradicts AFS knowledge' : 'Needs checking'}</span>
            <span>{w.text}</span>
            <CiteLink c={w.citation} />
          </li>
        ))}
      </ul>
    </div>
  )
}

const EFFECT_MARK: Record<string, string> = { plus: '+', minus: '–', condition: '!', exclude: '×', info: 'i' }

function LeafDetail({ c, onClose }: { c: Candidate; onClose: () => void }) {
  const m = METHOD_INFO[c.setup.method]
  const pros = c.reasons.filter((r) => r.effect === 'plus')
  const rest = c.reasons.filter((r) => r.effect !== 'plus')
  const depth = c.setup.depthUm ? `${c.setup.depthUm[0]}–${c.setup.depthUm[1]} µm` : 'n/a'
  return (
    <div className="tree-detail leaf-detail">
      <DetailHead title={`${m.name} · ${c.setup.technique}`} sub={`${c.setup.phenomenon} · ${m.rangeText}`} chip={<span className="chip recommended">Worth testing</span>} onClose={onClose} />
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
