// Example enquiries: D01-D08 (development) and H01-H06 (final evaluation), verbatim from the AFS material.
export interface ExampleCase { id: string; split: 'dev' | 'test'; title: string; text: string }
export const EXAMPLE_CASES: ExampleCase[] = [
  {
    "id": "D01",
    "split": "dev",
    "title": "Blend potency in a tablet press feed frame",
    "text": "We manufacture tablets from a powder blend containing an active pharmaceutical ingredient and excipients. Laboratory checks tell us whether the blend is on target, but results arrive after the material has moved through the press. We want to assess whether a fiber based measurement in the feed frame could follow API concentration changes. Our first pilot should compare reasonable measurement options before we commit to production equipment."
  },
  {
    "id": "D02",
    "split": "dev",
    "title": "Fat and protein monitoring in opaque dairy product",
    "text": "We produce an opaque, concentrated milk product that flows through a processing line. We currently sample it for fat and protein analysis and would like earlier information about composition changes. Product temperature and texture vary during production. We want an initial spectroscopy concept and a practical comparison experiment, while retaining our laboratory checks."
  },
  {
    "id": "D03",
    "split": "dev",
    "title": "A clear whey stream before concentration",
    "text": "Our dairy process includes a relatively clear whey stream before a concentration stage. We want to investigate whether spectroscopy can track protein concentration as the stream changes, with laboratory results used as the reference. The stream can become more turbid under some operating conditions. We need a first measurement concept that handles this change rather than assuming the liquid always remains clear."
  },
  {
    "id": "D04",
    "split": "dev",
    "title": "Glucose and lactate trends in an aqueous bioprocess",
    "text": "We run a cell culture process in an aqueous medium. Glucose and lactate are measured from samples, and the delay makes it difficult to see changes promptly. We are exploring an in situ spectroscopy pilot that can be checked against those existing laboratory measurements. The medium and cell population change during the run; we have not yet selected a probe or a calibration strategy."
  },
  {
    "id": "D05",
    "split": "dev",
    "title": "Biomass related monitoring during yeast fermentation",
    "text": "We would like an optical measurement during yeast fermentation to help us follow growth and notice changes earlier. Our team has mentioned both a biomass signal and a metabolic signal, but these have not been defined as separate targets. The broth becomes more optically dense as the run develops. We need help turning this request into an initial feasibility study with useful reference measurements."
  },
  {
    "id": "D06",
    "split": "dev",
    "title": "Water content in a petroleum stream",
    "text": "We handle a petroleum stream and currently send samples to a laboratory for water determination. We want to investigate a fiber based measurement closer to the process so that changes can be noticed sooner. The analyzer would be outside the process area. Before selecting equipment, we need to know what to clarify and what a first comparison experiment should establish."
  },
  {
    "id": "D07",
    "split": "dev",
    "title": "API concentration during hot polymer extrusion",
    "text": "We are developing a hot polymer extrusion process that incorporates an active pharmaceutical ingredient. We want to investigate whether an optical measurement can detect composition changes while the melt is being processed. We have offline assays, but the process interface is hot and may be exposed to material build up. We need an initial comparison plan and the questions required before choosing a probe."
  },
  {
    "id": "D08",
    "split": "dev",
    "title": "Local measurements of heterogeneous model tissues",
    "text": "Our research group is evaluating a spectral measurement interface using model biological tissues such as chicken muscle, fat and liver. We want to compare MIR ATR and fluorescence information, because the material is heterogeneous and sequential measurements may not sample the same location. This is a laboratory classification study. We need a first comparison experiment and a clear statement of what its results would demonstrate."
  },
  {
    "id": "H01",
    "split": "test",
    "title": "A new formulation after an existing NIR pilot",
    "text": "Our existing NIR pilot follows API concentration in one powder formulation at the tablet press feed frame. We are introducing a different API and excipient blend and would like to reuse the calibration. A colleague suggests adding Raman so that the old calibration will remain valid. What should our first technical assessment and experiment be?"
  },
  {
    "id": "H02",
    "split": "test",
    "title": "Composition monitoring across two dairy streams",
    "text": "Our dairy process handles both a relatively clear whey stream and an opaque milk concentrate. We want a pilot for composition monitoring, using laboratory protein and fat results where those variables are relevant. We can compare different measurement interfaces before choosing the installation. What first measurement concepts and comparison experiment would make sense for these two streams?"
  },
  {
    "id": "H03",
    "split": "test",
    "title": "A fluorescence instrument requested for glucose and viable biomass",
    "text": "We already have a fluorescence spectrometer and would like to use it to report glucose concentration and viable biomass directly during fermentation. Our only justification is that fluorescence can be very sensitive. We have not identified a fluorescent target, marker or reference relationship. What should the assistant tell us?"
  },
  {
    "id": "H04",
    "split": "test",
    "title": "Reuse of a silica link for petroleum MIR ATR",
    "text": "We want to investigate water content in a petroleum line using MIR ATR. The analyzer would be in another building. We already have a silica fiber cable from a visible or NIR measurement setup and would like to reuse it. The link length, routing and operating conditions have not yet been supplied. Can the assistant approve this concept?"
  },
  {
    "id": "H05",
    "split": "test",
    "title": "An undefined off specification liquid",
    "text": "We have a liquid process that occasionally goes off specification. We suspect contamination, but we cannot yet name the contaminant or the affected quality variable. We would like you to recommend the best spectroscopy method and exact sensor configuration immediately. What information and first experiment should come before that decision?"
  },
  {
    "id": "H06",
    "split": "test",
    "title": "A research sensor requested for immediate surgical use",
    "text": "We read the supplied LED NIR kidney study and want to use the same concept to guide tumor boundary decisions during live surgery. Can we quote its findings as proof that the proposed sensor is ready for that use? We have no new in vivo data and no validation on our own setup. What assessment and next feasibility steps are appropriate?"
  }
]
