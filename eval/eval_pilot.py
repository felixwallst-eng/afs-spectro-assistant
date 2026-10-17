#!/usr/bin/env python3
"""
Pilot evaluation for the case-dimension classifier.

Usage
-----
  # classifier vs gold (one or more repeated runs)
  python eval_pilot.py --gold gold_labels_dev.json --runs runs/jev_run*.json

  # inter-annotator agreement (two independent gold files)
  python eval_pilot.py --gold gold_labels_dev.json --gold2 gold_labels_dev_B.json

Prediction file format (one file per run, same case IDs as gold):
  {
    "model": "jev-...",            # optional metadata
    "cases": {
      "D01": {
        "sample_state":   {"label": "powder_or_granular", "confidence": 0.93},
        "process_conditions": {"flags": {"high_temperature": 0.04, "fouling_or_buildup": 0.71}},
        ...
      }
    }
  }
  - choice dimensions: {"label": str, "confidence": float}
  - multi_flag dimensions: {"flags": {flag_name: probability_of_yes}}

Metrics
-------
  accuracy            exact match per dimension (after confidence threshold)
  false_certainty     gold = unknown, prediction = concrete label   <- the dangerous error
  over_caution        gold = concrete, prediction = unknown         <- the safe error
  repeatability       share of (case, dimension) with identical label in all runs
  ECE                 expected calibration error of the confidences
  threshold sweep     how the error trade-off moves with the confidence threshold
"""
import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path

import yaml  # pip install pyyaml

HERE = Path(__file__).parent


def load_schema(path):
    dims = yaml.safe_load(Path(path).read_text())["dimensions"]
    return {d["id"]: d for d in dims}


def load_json(path):
    return json.loads(Path(path).read_text())


def unknown_of(dim):
    return dim.get("unknown_label")


def resolve_choice(pred, dim, threshold):
    """Apply the confidence threshold: low confidence -> unknown label."""
    label, conf = pred["label"], pred.get("confidence", 1.0)
    unk = unknown_of(dim)
    if unk is not None and conf < threshold:
        return unk, conf
    return label, conf


def resolve_flags(pred, threshold):
    return sorted(f for f, p in pred["flags"].items() if p >= threshold)


def evaluate_run(gold, run, schema, threshold):
    """Return per-dimension records for one run."""
    recs = []
    for case_id, g in gold["cases"].items():
        p_case = run["cases"].get(case_id, {})
        for dim_id, dim in schema.items():
            g_val = g["labels"].get(dim_id)
            p_raw = p_case.get(dim_id)
            if g_val is None or p_raw is None:
                continue
            if dim["call"] == "choice":
                p_val, conf = resolve_choice(p_raw, dim, threshold)
                unk = unknown_of(dim)
                recs.append(dict(
                    case=case_id, dim=dim_id, kind="choice", gold=g_val, pred=p_val, conf=conf,
                    correct=(g_val == p_val),
                    false_certainty=(unk is not None and g_val == unk and p_val != unk),
                    over_caution=(unk is not None and g_val != unk and p_val == unk),
                ))
            else:  # multi_flag: score each flag as a binary decision
                p_set = set(resolve_flags(p_raw, threshold))
                g_set = set(g_val)
                for flag in dim["flags"]:
                    prob = p_raw["flags"].get(flag, 0.0)
                    g_b, p_b = flag in g_set, flag in p_set
                    recs.append(dict(
                        case=case_id, dim=f"{dim_id}.{flag}", kind="flag", gold=g_b, pred=p_b,
                        conf=prob if p_b else 1 - prob, correct=(g_b == p_b),
                        false_certainty=(not g_b and p_b),   # flag invented
                        over_caution=(g_b and not p_b),      # flag missed
                    ))
    return recs


def ece(recs, bins=10):
    buckets = defaultdict(list)
    for r in recs:
        b = min(int(r["conf"] * bins), bins - 1)
        buckets[b].append(r)
    n = len(recs)
    return sum(len(v) / n * abs(sum(x["correct"] for x in v) / len(v) - sum(x["conf"] for x in v) / len(v))
               for v in buckets.values()) if n else float("nan")


def summarize(all_recs):
    by_dim = defaultdict(list)
    for r in all_recs:
        by_dim[r["dim"]].append(r)
    print(f"\n{'dimension':45s} {'acc':>6s} {'false_cert':>11s} {'over_caut':>10s} {'n':>4s}")
    print("-" * 80)
    for d in sorted(by_dim):
        v = by_dim[d]
        n = len(v)
        print(f"{d:45s} {sum(x['correct'] for x in v)/n:6.2f} "
              f"{sum(x['false_certainty'] for x in v)/n:11.2f} {sum(x['over_caution'] for x in v)/n:10.2f} {n:4d}")
    n = len(all_recs)
    print("-" * 80)
    print(f"{'OVERALL':45s} {sum(x['correct'] for x in all_recs)/n:6.2f} "
          f"{sum(x['false_certainty'] for x in all_recs)/n:11.2f} {sum(x['over_caution'] for x in all_recs)/n:10.2f} {n:4d}")
    print(f"ECE (calibration error): {ece(all_recs):.3f}")


def repeatability(runs_recs):
    if len(runs_recs) < 2:
        return None
    labels = defaultdict(list)
    for recs in runs_recs:
        for r in recs:
            labels[(r["case"], r["dim"])].append(json.dumps(r["pred"]))
    same = sum(len(set(v)) == 1 for v in labels.values())
    unstable = [k for k, v in labels.items() if len(set(v)) > 1]
    return same / len(labels), unstable


def cohen_kappa(a, b):
    n = len(a)
    po = sum(x == y for x, y in zip(a, b)) / n
    ca, cb = Counter(a), Counter(b)
    pe = sum(ca[k] * cb[k] for k in set(ca) | set(cb)) / n ** 2
    return (po - pe) / (1 - pe) if pe < 1 else 1.0


def inter_annotator(gold, gold2, schema):
    a, b, disagree = [], [], []
    for case_id, g in gold["cases"].items():
        g2 = gold2["cases"][case_id]["labels"]
        for dim_id, dim in schema.items():
            if dim_id not in g["labels"] or dim_id not in g2:
                continue
            if dim["call"] == "choice":
                x, y = g["labels"][dim_id], g2[dim_id]
                a.append(f"{dim_id}={x}"); b.append(f"{dim_id}={y}")
                if x != y:
                    disagree.append((case_id, dim_id, x, y))
            else:
                for flag in dim["flags"]:
                    x, y = flag in g["labels"][dim_id], flag in g2[dim_id]
                    a.append(f"{dim_id}.{flag}={x}"); b.append(f"{dim_id}.{flag}={y}")
                    if x != y:
                        disagree.append((case_id, f"{dim_id}.{flag}", x, y))
    choice_idx = [i for i, x in enumerate(a) if "." not in x.split("=")[0]]
    ac, bc = [a[i] for i in choice_idx], [b[i] for i in choice_idx]
    print(f"Choice dimensions only (report this one; flags are mostly 'no' and inflate kappa): "
          f"agreement {sum(x == y for x, y in zip(ac, bc))/len(ac):.3f}   kappa {cohen_kappa(ac, bc):.3f}")
    print("All decisions incl. flags:")
    print(f"Raw agreement: {sum(x == y for x, y in zip(a, b))/len(a):.3f}   Cohen's kappa: {cohen_kappa(a, b):.3f}")
    for d in disagree:
        print("  disagree:", *d)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--schema", default=HERE / "dimensions.yaml")
    ap.add_argument("--gold", default=HERE / "gold_labels_dev.json")
    ap.add_argument("--gold2", help="second annotator file -> inter-annotator agreement")
    ap.add_argument("--runs", nargs="*", default=[])
    ap.add_argument("--threshold", type=float, default=None)
    args = ap.parse_args()

    schema = load_schema(args.schema)
    gold = load_json(args.gold)
    thr = args.threshold if args.threshold is not None else \
        yaml.safe_load(Path(args.schema).read_text()).get("confidence_threshold_default", 0.7)

    if args.gold2:
        inter_annotator(gold, load_json(args.gold2), schema)
    if not args.runs:
        return

    runs = [load_json(p) for p in args.runs]
    runs_recs = [evaluate_run(gold, r, schema, thr) for r in runs]
    print(f"Runs: {len(runs)}   threshold: {thr}")
    summarize([r for recs in runs_recs for r in recs])

    rep = repeatability(runs_recs)
    if rep:
        share, unstable = rep
        print(f"\nRepeatability: {share:.3f} of (case, dimension) identical across all runs")
        for k in unstable[:20]:
            print("  unstable:", *k)

    print("\nThreshold sweep (all runs pooled):")
    print(f"{'thr':>5s} {'acc':>6s} {'false_cert':>11s} {'over_caut':>10s}")
    for t in [0.5, 0.6, 0.7, 0.8, 0.9]:
        recs = [r for run in runs for r in evaluate_run(gold, run, schema, t)]
        n = len(recs)
        print(f"{t:5.2f} {sum(x['correct'] for x in recs)/n:6.2f} "
              f"{sum(x['false_certainty'] for x in recs)/n:11.2f} {sum(x['over_caution'] for x in recs)/n:10.2f}")


if __name__ == "__main__":
    main()
