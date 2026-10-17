import { useState } from "react";
import type { ReactNode } from "react";
import { DIMENSIONS, GROUP_TITLES } from "../../shared/dimensions.ts";
import { RELEVANCE_NOTE, isRelevant } from "../../shared/engine.ts";
import CiteLink from "./CiteLink.tsx";
import type { AgentState } from "../lib.ts";
import type {
  Assessment,
  DimensionDef,
  DimensionResult,
  Settings,
} from "../../shared/types.ts";

interface Props {
  assessment: Assessment;
  settings: Settings;
  onOverride: (id: string, value: string | undefined) => void;
  onAddNote: (note: string) => void;
  busy: boolean;
  agent: AgentState;
  onAskAgent: () => void;
}

const PRIORITY_TEXT = {
  1: "Can change the method",
  2: "Can change the setup",
  3: "Refines the plan",
};

type Bucket = "missing" | "check" | "expert" | "confident" | "irrelevant";

function Meter({
  value,
  settings,
}: {
  value: number | null;
  settings: Settings;
}) {
  if (value === null)
    return (
      <span className="meter">
        <span>–</span>
      </span>
    );
  return (
    <span className="meter" title={`Confidence ${Math.round(value * 100)} %`}>
      <span className="track">
        <span className="fill" style={{ width: `${value * 100}%` }} />
        <span
          className="tick"
          style={{ left: `${settings.confidentAt * 100}%` }}
        />
      </span>
      <span>{Math.round(value * 100)}%</span>
    </span>
  );
}

function Section(props: {
  title: string;
  hint?: string;
  count: number;
  open: boolean;
  tone: Bucket;
  preview?: ReactNode;
  children: ReactNode;
}) {
  if (props.count === 0) return null;
  return (
    <details className={`rv-section ${props.tone}`} open={props.open}>
      <summary>
        <span className="rv-title">{props.title}</span>
        <span className="rv-count">{props.count}</span>
        {props.hint && <span className="rv-hint">{props.hint}</span>}
        {props.preview && <span className="rv-preview">{props.preview}</span>}
      </summary>
      <div className="rv-body">{props.children}</div>
    </details>
  );
}

export default function ReviewTable({
  assessment,
  settings,
  onOverride,
  onAddNote,
  busy,
  agent,
  onAskAgent,
}: Props) {
  const [note, setNote] = useState("");
  // Pending answers: shown in the control, applied only on "Save changes".
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draftCount = Object.keys(drafts).length;
  const setDraft = (id: string, value: string, current: string) =>
    setDrafts((prev) => {
      const next = { ...prev };
      if (value === current) delete next[id];
      else next[id] = value;
      return next;
    });
  const dropDraft = (id: string) =>
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  const saveDraft = (id: string) => {
    if (drafts[id] !== undefined) onOverride(id, drafts[id]);
    dropDraft(id);
  };
  const saveAll = () => {
    Object.entries(drafts).forEach(([id, v]) => onOverride(id, v));
    setDrafts({});
  };
  const saveControls = (id: string) =>
    drafts[id] === undefined ? null : (
      <span className="rv-save">
        <button className="btn small primary" onClick={() => saveDraft(id)}>
          Save changes
        </button>
        <button className="linkbtn" onClick={() => dropDraft(id)}>
          Cancel
        </button>
      </span>
    );
  const dims = assessment.dimensions;
  const values = Object.fromEntries(
    Object.values(dims).map((d) => [d.id, d.value]),
  );
  const questionOrder = new Map(
    assessment.questions.map((q, i) => [q.dimensionId, i]),
  );
  const questionOf = new Map(
    assessment.questions.map((q) => [q.dimensionId, q]),
  );

  const bucketOf = (def: DimensionDef, d: DimensionResult): Bucket => {
    if (!isRelevant(def.id, values)) return "irrelevant";
    if (d.source === "expert") return "expert";
    if (def.kind === "flag")
      return d.status === "uncertain" ? "check" : "confident";
    if (questionOrder.has(def.id))
      return d.status === "uncertain" ? "check" : "missing";
    return "confident";
  };

  const valueDims = DIMENSIONS.filter((d) => d.kind !== "flag");
  const flagDims = DIMENSIONS.filter((d) => d.kind === "flag");
  const bucket = (b: Bucket, defs: DimensionDef[]) =>
    defs.filter((def) => bucketOf(def, dims[def.id]) === b);
  const byQuestion = (a: DimensionDef, b: DimensionDef) =>
    (questionOrder.get(a.id) ?? 99) - (questionOrder.get(b.id) ?? 99);

  const missing = bucket("missing", valueDims).sort(byQuestion);
  const missingCount =
    missing.length + (questionOf.has("process_conditions") ? 1 : 0);
  const check = [
    ...bucket("check", valueDims).sort(byQuestion),
    ...bucket("check", flagDims),
  ];
  const expert = [
    ...bucket("expert", valueDims),
    ...bucket("expert", flagDims),
  ];
  const confident = bucket("confident", valueDims);
  const irrelevant = bucket("irrelevant", valueDims);

  const valueName = (def: DimensionDef, v: string) => def.labels[v]?.name ?? v;

  const row = (def: DimensionDef, b: Bucket) => {
    const d = dims[def.id];
    const isFlag = def.kind === "flag";
    return (
      <tr key={def.id}>
        <td className="dim-title">
          {def.title}
          {isFlag && (
            <small className="rv-sub">{GROUP_TITLES[def.group]}</small>
          )}
          {b === "irrelevant" && (
            <small className="rv-sub">{RELEVANCE_NOTE[def.id]}</small>
          )}
        </td>
        <td>{select(def, d)}</td>
        <td>
          <Meter
            value={d.source === "expert" ? null : d.confidence}
            settings={settings}
          />
        </td>
        <td className="rv-action">
          {saveControls(def.id) ??
            (b === "expert" && (
              <button
                className="linkbtn"
                onClick={() => onOverride(def.id, undefined)}
                title={
                  d.rawValue
                    ? `Clef said: ${valueName(def, d.rawValue)}`
                    : undefined
                }
              >
                Reset to Clef
              </button>
            ))}
        </td>
      </tr>
    );
  };

  /** Probability that the client mentions the item (Clef's P(yes)). */
  const pYes = (d: DimensionResult): number | null => {
    if (d.probabilities && typeof d.probabilities.yes === "number")
      return d.probabilities.yes;
    if (d.confidence === null) return null;
    return d.rawValue === "yes" ? d.confidence : 1 - d.confidence;
  };

  const flagControl = (def: DimensionDef, d: DimensionResult) => (
    <span className="seg" role="group" aria-label={def.title}>
      {(["yes", "no"] as const).map((v) => (
        <button
          key={v}
          type="button"
          aria-pressed={(drafts[def.id] ?? d.value) === v}
          className={
            (drafts[def.id] ?? d.value) === v
              ? `on ${v}${drafts[def.id] !== undefined ? " draft" : ""}`
              : ""
          }
          onClick={() => setDraft(def.id, v, d.value)}
        >
          {v === "yes" ? "Yes" : "No"}
        </button>
      ))}
    </span>
  );

  const select = (def: DimensionDef, d: DimensionResult) =>
    def.kind === "flag" ? (
      flagControl(def, d)
    ) : (
      <select
        value={drafts[def.id] ?? d.value}
        aria-label={def.title}
        className={drafts[def.id] !== undefined ? "draft" : undefined}
        onChange={(e) => setDraft(def.id, e.target.value, d.value)}
        title={def.labels[drafts[def.id] ?? d.value]?.description}
      >
        {Object.entries(def.labels).map(([k, l]) => (
          <option key={k} value={k}>
            {l.name}
          </option>
        ))}
      </select>
    );

  /** Knowledge-base agent: suggestion with a verified quote, or why there is none. */
  const agentRow = (def: DimensionDef) => {
    if (agent.status === "idle") return null;
    const d = dims[def.id];
    let body: ReactNode;
    if (agent.status === "loading")
      body = (
        <span className="agent-main agent-wait">
          Reading the knowledge base…
        </span>
      );
    else if (agent.status === "error") return null;
    else {
      const sug = agent.data.suggestions.find((x) => x.dimensionId === def.id);
      if (!sug) return null;
      body =
        sug.status === "verified" && sug.value ? (
          <>
            <span className="agent-main">
              <span>
                Suggests <strong>{valueName(def, sug.value)}</strong>
              </span>
              {sug.rationale && (
                <span className="agent-reason">{sug.rationale}</span>
              )}
              <span className="agent-quote">
                “{sug.quote}”
                <CiteLink
                  c={{ source: sug.docId!, page: `p.${sug.page}` }}
                  quote={sug.quote}
                />
              </span>
            </span>
            <button
              className="btn small"
              onClick={() => setDraft(def.id, sug.value!, d.value)}
            >
              Use suggestion
            </button>
          </>
        ) : (
          <span
            className={`agent-main ${sug.status === "withheld" ? "agent-withheld" : ""}`}
          >
            {sug.rationale}
          </span>
        );
    }
    return (
      <tr key={`${def.id}-agent`} className="rv-agent">
        <td />
        <td colSpan={3}>
          <div
            className={`agent ${
              agent.status === "done"
                ? (agent.data.suggestions.find((x) => x.dimensionId === def.id)
                    ?.status ?? "")
                : ""
            }`}
          >
            <span className="agent-tag">Knowledge agent</span>
            {body}
          </div>
        </td>
      </tr>
    );
  };

  const questionRow = (def: DimensionDef, b: "missing" | "check") => {
    const d = dims[def.id];
    const q = questionOf.get(def.id);
    const text =
      q?.text ??
      `Please confirm: ${def.title.toLowerCase()} = "${valueName(def, d.value)}"?`;
    return (
      <tr key={def.id}>
        <td className="dim-title">
          {def.title}
          {def.kind === "flag" && (
            <small className="rv-sub">{GROUP_TITLES[def.group]}</small>
          )}
        </td>
        <td className="rv-question">
          {text}
          {q && (
            <small className="rv-sub">
              {PRIORITY_TEXT[q.priority]}
              {q.impact > 0
                ? ` · affects ${Math.round(q.impact * 100)} % of setups`
                : ""}
            </small>
          )}
        </td>
        <td>{select(def, d)}</td>
        <td className="rv-action">
          {saveControls(def.id) ??
            (b === "missing" ? (
              <span className="rv-sub">
                {d.rawValue === def.unknownLabel
                  ? "Not stated in the enquiry"
                  : "Too uncertain to use"}
              </span>
            ) : (
              <span className="rv-check">
                <Meter
                  value={def.kind === "flag" ? pYes(d) : d.confidence}
                  settings={settings}
                />
                <button
                  className="btn small"
                  onClick={() => onOverride(def.id, d.value)}
                >
                  Accept
                </button>
              </span>
            ))}
        </td>
      </tr>
    );
  };

  const processQuestion = questionOf.get("process_conditions");
  const questionTable = (defs: DimensionDef[], b: "missing" | "check") => (
    <table className="rv-qtable">
      <thead>
        <tr>
          <th>Dimension</th>
          <th>Question for the client</th>
          <th>Answer</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {defs.flatMap((def) =>
          b === "missing"
            ? [questionRow(def, b), agentRow(def)]
            : [questionRow(def, b)],
        )}
        {b === "missing" && processQuestion && (
          <tr>
            <td className="dim-title">Process conditions</td>
            <td className="rv-question">
              {processQuestion.text}
              <small className="rv-sub">
                {PRIORITY_TEXT[processQuestion.priority]}
              </small>
            </td>
            <td>
              <span className="rv-sub">
                Use the switches under “Classified with confidence” or add the
                answer as text
              </span>
            </td>
            <td className="rv-action">
              <span className="rv-sub">Not stated in the enquiry</span>
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );

  const table = (defs: DimensionDef[], b: Bucket) => (
    <table>
      <tbody>{defs.map((def) => row(def, b))}</tbody>
    </table>
  );

  const confidentPreview = confident
    .filter((def) => dims[def.id].value !== def.unknownLabel)
    .slice(0, 6)
    .map((def) => (
      <span key={def.id} className="chip clef">
        {valueName(def, dims[def.id].value)}
      </span>
    ));
  const flagsOn = bucket("confident", flagDims).filter(
    (def) => dims[def.id].value === "yes",
  );

  return (
    <section className="panel review" id="review">
      <div className="panel-head">
        <h2>Open questions and review</h2>
        <span className="hint">
          Choose an answer, then save it – the recommendation updates on save.
        </span>
        {draftCount > 0 && (
          <span className="right rv-pending">
            {draftCount} unsaved change{draftCount > 1 ? "s" : ""}
            <button className="btn small primary" onClick={saveAll}>
              Save all
            </button>
            <button className="linkbtn" onClick={() => setDrafts({})}>
              Discard
            </button>
          </span>
        )}
      </div>
      <div className="panel-body">
        {missingCount + check.length === 0 && (
          <p className="rv-done">
            Nothing left to review – all relevant facts are classified with
            confidence or set by you.
          </p>
        )}

        <Section
          title="Open questions – needed for the decision"
          hint="Ask the client, then set the answer"
          count={missingCount}
          open
          tone="missing"
        >
          <div className="agent-bar">
            {agent.status === "loading" && (
              <span>Knowledge agent is reading the documents…</span>
            )}
            {agent.status === "error" && (
              <span className="error">{agent.error}</span>
            )}
            {agent.status === "done" && (
              <span>
                Knowledge agent · {agent.data.model} · read{" "}
                {agent.data.selectedDocs.map((d) => d.id).join(", ")} ·{" "}
                {agent.data.pagesRead.length} pages ·{" "}
                {(agent.data.latencyMs / 1000).toFixed(1)} s ·{" "}
                {Math.round(
                  (agent.data.usage.inputTokens +
                    agent.data.usage.outputTokens) /
                    100,
                ) / 10}
                k tokens
              </span>
            )}
            {agent.status !== "loading" && (
              <button className="linkbtn" onClick={onAskAgent}>
                {agent.status === "idle" ? "Ask knowledge agent" : "Ask again"}
              </button>
            )}
          </div>
          {questionTable(missing, "missing")}
          <form
            className="note-row"
            onSubmit={(e) => {
              e.preventDefault();
              if (note.trim()) {
                onAddNote(note);
                setNote("");
              }
            }}
          >
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Or paste the client's reply as text – it is added to the enquiry and re-analysed"
              aria-label="Client reply as text"
            />
            <button className="btn" disabled={busy || !note.trim()}>
              {busy ? "Analysing…" : "Add & re-analyse"}
            </button>
          </form>
        </Section>

        <Section
          title="Please check"
          hint="Clef is not sure – accept or correct"
          count={check.length}
          open
          tone="check"
        >
          {questionTable(check, "check")}
        </Section>

        <Section title="Set by you" count={expert.length} open tone="expert">
          {table(expert, "expert")}
        </Section>

        <Section
          title="Classified with confidence"
          count={confident.length + flagsOn.length}
          open={false}
          tone="confident"
          preview={
            <>
              {confidentPreview}
              {flagsOn.map((def) => (
                <span key={def.id} className="chip clef">
                  {def.title}
                </span>
              ))}
            </>
          }
        >
          {table(confident, "confident")}
          <table className="rv-flagtable">
            <thead>
              <tr>
                <th>Yes / no indicators</th>
                <th>Answer</th>
                <th>Likelihood mentioned</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(["conditions", "proposed", "reuse"] as const).map((g) => [
                <tr key={g} className="group-row">
                  <td colSpan={4}>{GROUP_TITLES[g]}</td>
                </tr>,
                ...flagDims
                  .filter((def) => def.group === g)
                  .map((def) => {
                    const d = dims[def.id];
                    return (
                      <tr key={def.id}>
                        <td
                          className="dim-title"
                          title={def.labels.yes.description}
                        >
                          {def.title}
                        </td>
                        <td>{flagControl(def, d)}</td>
                        <td>
                          {d.source === "expert" ? (
                            <span className="rv-sub">Set by you</span>
                          ) : (
                            <Meter value={pYes(d)} settings={settings} />
                          )}
                        </td>
                        <td className="rv-action">
                          {saveControls(def.id) ??
                            (d.source === "expert" && (
                              <button
                                className="linkbtn"
                                onClick={() => onOverride(def.id, undefined)}
                              >
                                Reset to Clef
                              </button>
                            ))}
                        </td>
                      </tr>
                    );
                  }),
              ])}
            </tbody>
          </table>
        </Section>

        <Section
          title="Not relevant for this enquiry"
          count={irrelevant.length}
          open={false}
          tone="irrelevant"
        >
          {table(irrelevant, "irrelevant")}
        </Section>
      </div>
    </section>
  );
}
