// Similar solved cases – shown next to a step, never used for the decision.
//
// Self-contained on purpose: to remove the feature, delete this file and the two lines marked
// "similar solved cases" in DecisionTree.tsx. Nothing else depends on it.

import { useEffect, useState } from 'react'
import type { SolvedCase } from '../../shared/solvedCases.ts'
import { TREE_NODES } from '../../shared/tree.ts'
import { casesApi } from '../lib.ts'

const MIN_MATCHES = 2 // steps that must agree before a case counts as similar
const MAX_SHOWN = 2
const CACHE_MS = 30_000

let cache: { at: number; cases: Promise<SolvedCase[]> } | null = null
function loadCases(): Promise<SolvedCase[]> {
  if (!cache || Date.now() - cache.at > CACHE_MS) cache = { at: Date.now(), cases: casesApi.list().catch(() => []) }
  return cache.cases
}

const TREE_IDS = TREE_NODES.map((n) => n.id)

interface Match {
  c: SolvedCase
  matches: number
  compared: number
  step: SolvedCase['steps'][number]
}

/** Solved cases whose decided steps agree with this case, and where the expert decided or commented this step. */
function findSimilar(cases: SolvedCase[], stepId: string, values: Record<string, string>, text: string): Match[] {
  const known = TREE_IDS.filter((id) => id !== stepId && values[id] && values[id] !== 'not_stated')
  return cases
    .filter((c) => c.enquiry.trim() !== text.trim()) // never the case itself
    .map((c) => {
      const byId = new Map(c.steps.map((s) => [s.id, s]))
      const step = byId.get(stepId)
      const compared = known.filter((id) => byId.get(id)?.value && byId.get(id)?.value !== 'not_stated')
      const matches = compared.filter((id) => byId.get(id)?.value === values[id]).length
      return step ? { c, matches, compared: compared.length, step } : null
    })
    .filter((m): m is Match => !!m && m.matches >= MIN_MATCHES && (m.step.byExpert || !!m.step.note))
    .sort((a, b) => b.matches - a.matches || (b.c.updatedAt ?? b.c.createdAt).localeCompare(a.c.updatedAt ?? a.c.createdAt))
    .slice(0, MAX_SHOWN)
}

export default function SimilarCaseHint({ stepId, values, text }: { stepId: string; values: Record<string, string>; text: string }) {
  const [cases, setCases] = useState<SolvedCase[]>([])
  const [open, setOpen] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void loadCases().then((c) => alive && setCases(c))
    return () => {
      alive = false
    }
  }, [])
  const similar = findSimilar(cases, stepId, values, text)
  if (!similar.length) return null
  return (
    <div className="similar-cases">
      <h4>From similar solved cases</h4>
      <ul>
        {similar.map(({ c, matches, compared, step }) => (
          <li key={c.id}>
            <span className="sc-match">
              {matches} of {compared} steps match
            </span>{' '}
            The expert {step.model.value === step.value ? 'confirmed' : step.model.value ? 'changed this to' : 'decided'} <strong>{step.valueName}</strong>
            {step.note ? <> – “{step.note}”</> : '.'}{' '}
            <button className="linkbtn" onClick={() => setOpen(open === c.id ? null : c.id)}>
              {open === c.id ? 'Hide enquiry' : 'Show enquiry'}
            </button>
            {' · '}
            <button className="linkbtn" onClick={() => window.dispatchEvent(new CustomEvent('afs:open-case', { detail: c.id }))} title="Open the full solved case in the knowledge base">
              Open in knowledge base ›
            </button>
            {open === c.id && <blockquote className="sc-enquiry">{c.enquiry}</blockquote>}
          </li>
        ))}
      </ul>
      <p className="sc-note">Shown for reference only – it does not change the decision.</p>
    </div>
  )
}
