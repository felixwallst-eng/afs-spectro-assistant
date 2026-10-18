# Knowledge card review – proposals (draft, 2026-10-18)

Goal: fewer generic or misplaced references. Tick `[x]` to accept, or write a different decision.
Nothing here is applied yet – once you have decided, the accepted changes go into `knowledge/cards/S0x.json`.

**Proposed new card field `appliesTo`** – the context a card is about. Before Clef sees a card, cards whose
context contradicts a *stated* fact of the case are left out (e.g. no tissue cards for a powder blend).
Values: `sample` (sample state labels), `context` (`pharma`, `dairy`, `bioprocess`, `petro`, `polymer`, `tissue`, `clinical`).
A card without `appliesTo` stays general.

## 1. Remove or move (duplicates / wrong step)

| ok | Card | Step now | Claim | Proposal |
|---|---|---|---|---|
| [ ] | S02-2 | interface_mode | Silica fiber cables of 100–300 m allow a remote analyzer – for the Vis-NIR range. | Remove here – the same quote is S02-10 under *spectral range*, where it belongs. |
| [ ] | S02-3 | interface_mode | Mid-IR needs polycrystalline (PIR) fibers, which transmit 3–16 µm. | Remove here – duplicate of S02-11 (*spectral range*). |
| [ ] | S02-6 | target_property_type | AFS compares the spectral data of the customer's process across methods before choosing. | Remove from the steps – it describes AFS's way of working, not the target. Could become a general “approach” note. |
| [ ] | S01-40 | budget | NIR works with ordinary glass optics and standard lamps … | Keep only S01-42 (*spectral range*); budget is no longer a tree step. |
| [ ] | all 10 budget cards | budget | (S01-39, S01-41, S02-7, S02-8, S02-9, S03-9, S03-10, S04-10, S04-11) | Not used since budget left the tree. Either drop, or attach them to the cost pro/con of the method comparison. |

## 2. Downgrade to background (true, but decides nothing for a single customer)

| ok | Card | Step | Claim | Why |
|---|---|---|---|---|
| [ ] | S01-2 | sample_state | Mid-IR absorbs so strongly that only very thin layers (<50 µm) can be measured – via ATR. | Applies to every sample; it explains ATR, not the sample state. Better under *interface* as background. |
| [ ] | S01-14 | interface_mode | Penetration depth differs between NIR, mid-IR and Raman, so each needs its own interface. | General principle. |
| [ ] | S01-17 | interface_mode | NIR is the most common method for online analysis with fiber probes. | Popularity, not a reason for this customer; tends to appear everywhere. |
| [ ] | S01-31 | optical_variability | Sample inhomogeneity and process turbulence must be considered … | Very general; keep as background only. |
| [ ] | S04-4 | sample_state | ATR needs a tight contact with the probe head – true for liquids and soft solids. | Background for ATR, not for the sample state itself. |

## 3. Add `appliesTo` (context-specific cards)

| ok | Card(s) | Proposed `appliesTo` |
|---|---|---|
| [ ] | S01-5, S01-26 | `context: pharma`, `sample: powder_or_granular` |
| [ ] | S01-9, S01-10, S01-11, S01-12, S01-21, S01-30, S01-33 | `context: dairy` |
| [ ] | S01-27, S01-28, S01-29 | `context: bioprocess` |
| [ ] | S02-4 | `context: petro` |
| [ ] | S02-1, S02-5 | `context: polymer`, `sample: melt_or_paste` |
| [ ] | S01-3, S01-4, S03-1, S04-1, S04-3, S04-5, S01-24, S01-25, S03-4, S04-8, S04-9, S03-8 | `context: tissue` |
| [ ] | S01-16, S01-19, S03-2, S03-3, S03-5, S03-6, S03-7 | `context: tissue, clinical` |

The context of a case would be one more Clef question (pharma / dairy / bioprocess / petro / polymer / tissue / other),
asked together with the other facts – no extra call.

## 4. Sharpen the wording (claim only – the verified quote stays)

| ok | Card | Now | Proposed |
|---|---|---|---|
| [ ] | S01-13 | In-process measurement works directly in the flow or reactor without sampling – no delay and no contamination risk. | An in-process probe measures directly in the line or reactor: no sampling delay, no contamination risk. |
| [ ] | S01-20 | Fiber optics let the spectrometer stay away from vibration and dust while the probe sits in the process. | With fiber optics the probe sits in the process while the spectrometer stays in a protected place. |
| [ ] | S04-6 | Fiber probes enable sampling-free measurements in situ. | Fiber probes measure in situ without taking samples. |
| [ ] | S01-7 | Opaque, turbid or highly concentrated media saturate a transmission setup because light cannot pass through the sample. | In opaque or highly concentrated media, light does not pass through a transmission path – reflection or ATR is needed. |
| [ ] | S01-34 | When the physical state changes along the process, calibrations for several interfaces keep the measurement robust. | If the product changes its optical state during the process, plan for more than one interface or calibration. |
