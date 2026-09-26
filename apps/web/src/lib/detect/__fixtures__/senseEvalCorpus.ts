// Sense-picker plan, Lane 0 — the sense-picking evaluation corpus.
//
// SYNTHETIC scripts only. The 2026-07-29 field-test transcripts name
// real people and carry company-internal detail; they must never be
// staged here. Every script below is written from scratch
// to exercise one documented behaviour of the local (dictionary-mode)
// sense picker: dictionary.ts's selectSense fed by domainSignal.ts's
// DomainTracker and apps/web's deriveSenseContext + keyword fallback.
//
// Shape: one script = one short meeting, replayed segment by segment
// through the same pipeline scheduler.ts + useMeeting.ts run live
// (see __tests__/senseEval.test.ts). `expect` on a segment names the
// sense each listed headword's CARD must show right after that segment
// has been merged — not the raw scan result, the card the user sees.
//
// Tags (free-form, used for the report's per-tag breakdown):
//   cold-start   the headword appears in segment 0, before any evidence
//   warm         unambiguous pack headwords in EARLIER segments
//   keyword      the keyless keyword table is the only domain signal
//   same-sentence evidence and the ambiguous headword share a segment
//   topic-shift  the meeting changes domain mid-way
//   prior        no context at all; the authored prior decides
//
// The nine multi-sense headwords in the built-in tables as of v0.7.8:
// CAC, NDA, alignment (core) · SAM (business-terms) · oral (academic)
// · PR, regression (tech-terms) · PD (pharma-biotech) · ISO
// (finance-consumer). Evidence headwords used below are non-commonWord
// entries of the packs PACK_DOMAINS maps: pharma-biotech→pharma (IND,
// BLA, GMP, CRO, PK), business-terms→sales (TAM, EBITDA, COGS, ARPU,
// churn), academic→edu (PI, postdoc, preprint, IRB), tech-terms→software
// (RFC, SLA, LGTM, CI/CD, hotfix), stats→stats (ANOVA, t-test, p-value),
// ml-stats→ml (overfitting, fine-tuning, cross-validation),
// bioinformatics-edam→genomics (FASTQ, BAM, VCF).

export interface SenseEvalSegment {
  text: string;
  /** headword (as spoken / as the entry's `term`) -> expected senseId */
  expect?: Record<string, string>;
}

export interface SenseEvalScript {
  id: string;
  tags: string[];
  /** null = every pack on (the app's default state). */
  enabledPacks?: string[] | null;
  segments: SenseEvalSegment[];
}

export const SENSE_EVAL_CORPUS: SenseEvalScript[] = [
  // ---------------------------------------------------------------- CAC
  {
    id: "cac-cachexia-warm",
    tags: ["warm"],
    segments: [
      { text: "Today we walk through the IND package and the BLA timeline for our orphan drug." },
      {
        text: "Patients with CAC lose muscle mass very quickly.",
        expect: { CAC: "cancer-associated-cachexia" },
      },
      {
        text: "The primary endpoint for the CAC trial is weight stabilization.",
        expect: { CAC: "cancer-associated-cachexia" },
      },
    ],
  },
  {
    id: "cac-cachexia-cold",
    tags: ["cold-start"],
    segments: [
      {
        text: "CAC is the most feared complication in late-stage cancer patients.",
        expect: { CAC: "cancer-associated-cachexia" },
      },
      {
        text: "Our IND submission and the BLA both discuss the CAC endpoint.",
        expect: { CAC: "cancer-associated-cachexia" },
      },
      {
        text: "GMP manufacturing for the CAC candidate starts next quarter.",
        expect: { CAC: "cancer-associated-cachexia" },
      },
    ],
  },
  {
    id: "cac-cachexia-keyword",
    tags: ["keyword"],
    segments: [
      { text: "The drug development team reviewed the pharmacokinetics data this morning." },
      { text: "CAC remains an unmet need in this population.", expect: { CAC: "cancer-associated-cachexia" } },
    ],
  },
  {
    id: "cac-sales-warm",
    tags: ["warm", "keyword"],
    segments: [
      { text: "Let's review the sales pipeline and the quarterly revenue numbers." },
      { text: "Our CAC went up while LTV stayed flat.", expect: { CAC: "customer-acquisition-cost" } },
      {
        text: "TAM and ARPU are on the next slide; CAC payback is fourteen months.",
        expect: { CAC: "customer-acquisition-cost" },
      },
    ],
  },
  {
    id: "cac-sales-cold",
    tags: ["cold-start", "prior"],
    segments: [
      { text: "CAC payback is now fourteen months.", expect: { CAC: "customer-acquisition-cost" } },
      { text: "Churn and ARPU are next.", expect: { CAC: "customer-acquisition-cost" } },
    ],
  },
  {
    id: "cac-topic-shift-sales-to-pharma",
    tags: ["topic-shift"],
    segments: [
      { text: "Quick look at the sales pipeline: TAM, ARPU and churn all moved." },
      { text: "CAC payback is fourteen months.", expect: { CAC: "customer-acquisition-cost" } },
      { text: "Switching to the oncology program: the IND is filed and the BLA is planned." },
      { text: "GMP batches and the CRO contract are ready for the cachexia indication." },
      {
        text: "CAC patients on the trial are showing weight gain.",
        expect: { CAC: "cancer-associated-cachexia" },
      },
    ],
  },
  // ---------------------------------------------------------------- NDA
  {
    id: "nda-pharma-warm",
    tags: ["warm"],
    segments: [
      { text: "IND clearance came in March and the GMP audits are done." },
      {
        text: "Then we submit the NDA in Q3, and the BLA for the biologic after that.",
        expect: { NDA: "new-drug-application" },
      },
    ],
  },
  {
    id: "nda-same-sentence-ind-bla",
    tags: ["cold-start", "same-sentence"],
    segments: [
      {
        text: "We need an IND, or an NDA, or a BLA depending on the modality.",
        expect: { NDA: "new-drug-application" },
      },
      { text: "The CRO will handle the GMP paperwork.", expect: { NDA: "new-drug-application" } },
    ],
  },
  {
    id: "nda-pharma-keyword",
    tags: ["keyword"],
    segments: [
      { text: "FDA approval hinges on the drug development timeline." },
      { text: "The NDA goes in next month.", expect: { NDA: "new-drug-application" } },
    ],
  },
  {
    id: "nda-legal-keyword",
    tags: ["keyword"],
    segments: [
      { text: "Before we share the contract, legal wants a compliance sign-off." },
      { text: "Please sign the NDA before the demo.", expect: { NDA: "non-disclosure-agreement" } },
    ],
  },
  {
    id: "nda-sales-cold",
    tags: ["cold-start", "prior"],
    segments: [
      { text: "Sign the NDA before we show you the term sheet.", expect: { NDA: "non-disclosure-agreement" } },
    ],
  },
  // ---------------------------------------------------------- alignment
  {
    id: "alignment-ml-warm",
    tags: ["warm"],
    segments: [
      { text: "We fine-tune the model and watch for overfitting during cross-validation." },
      { text: "Alignment is the hard part for the assistant.", expect: { alignment: "ai-alignment" } },
    ],
  },
  {
    id: "alignment-ml-keyword-cold",
    tags: ["cold-start", "keyword", "same-sentence"],
    segments: [
      {
        text: "Deep learning and neural network alignment research is our focus.",
        expect: { alignment: "ai-alignment" },
      },
    ],
  },
  {
    id: "alignment-team-keyword",
    tags: ["keyword"],
    segments: [
      { text: "Quick sync on the sales pipeline and the sales quota." },
      { text: "We need alignment on the pricing decision.", expect: { alignment: "team-alignment" } },
    ],
  },
  {
    id: "alignment-team-cold",
    tags: ["cold-start", "prior"],
    segments: [{ text: "Let's get alignment before Friday.", expect: { alignment: "team-alignment" } }],
  },
  // ---------------------------------------------------------------- SAM
  {
    id: "sam-genomics-warm",
    tags: ["warm"],
    segments: [
      { text: "The pipeline reads FASTQ and writes a VCF at the end." },
      { text: "The intermediate SAM files are huge.", expect: { SAM: "sequence-alignment-map" } },
    ],
  },
  {
    id: "sam-genomics-keyword-cold",
    tags: ["cold-start", "keyword", "same-sentence"],
    segments: [
      {
        text: "Whole genome sequencing output is stored as SAM before compression.",
        expect: { SAM: "sequence-alignment-map" },
      },
    ],
  },
  {
    id: "sam-market-cold",
    tags: ["cold-start", "prior"],
    segments: [
      { text: "TAM, SAM and SOM are on slide three.", expect: { SAM: "serviceable-addressable-market" } },
    ],
  },
  // --------------------------------------------------------------- oral
  {
    id: "oral-conference-warm",
    tags: ["warm"],
    segments: [
      { text: "The postdoc and the PI submitted the preprint last week." },
      { text: "It was accepted as an oral, not a poster.", expect: { oral: "conference-oral" } },
    ],
  },
  {
    id: "oral-conference-keyword-cold",
    tags: ["cold-start", "keyword", "same-sentence"],
    segments: [
      {
        text: "In the lecture on thesis defenses, an oral is twelve minutes.",
        expect: { oral: "conference-oral" },
      },
    ],
  },
  {
    id: "oral-drug-cold",
    tags: ["cold-start", "prior"],
    segments: [
      { text: "The IND covers an oral formulation only.", expect: { oral: "oral-administration" } },
    ],
  },
  // ----------------------------------------------------------------- PR
  {
    id: "pr-software-warm",
    tags: ["warm"],
    segments: [
      { text: "LGTM, the RFC is approved and CI/CD is green." },
      { text: "Open a PR against staging.", expect: { PR: "pull-request" } },
    ],
  },
  {
    id: "pr-ml-warm",
    tags: ["warm"],
    segments: [
      { text: "We compared the overfitting and cross-validation curves." },
      {
        text: "The PR curve beats ROC on the imbalanced dataset.",
        expect: { PR: "precision-recall" },
      },
    ],
  },
  {
    id: "pr-ml-keyword-cold",
    tags: ["cold-start", "keyword", "same-sentence"],
    segments: [
      { text: "The PR curve for the neural network looks good.", expect: { PR: "precision-recall" } },
    ],
  },
  {
    id: "pr-software-cold",
    tags: ["cold-start", "prior"],
    segments: [{ text: "Please review my PR today.", expect: { PR: "pull-request" } }],
  },
  // --------------------------------------------------------- regression
  {
    id: "regression-stats-warm",
    tags: ["warm"],
    segments: [
      { text: "We ran an ANOVA and a t-test first." },
      { text: "Then a regression on the covariates.", expect: { regression: "statistical-regression" } },
    ],
  },
  {
    id: "regression-software-warm",
    tags: ["warm"],
    segments: [
      { text: "The hotfix shipped after the RFC and the SLA review." },
      {
        text: "Yesterday's deploy caused a regression in checkout.",
        expect: { regression: "software-regression" },
      },
    ],
  },
  {
    id: "regression-ml-keyword-cold",
    tags: ["cold-start", "keyword", "same-sentence"],
    segments: [
      {
        text: "The machine learning team fit a regression model to the churn data.",
        expect: { regression: "statistical-regression" },
      },
    ],
  },
  // ----------------------------------------------------------------- PD
  {
    id: "pd-pharma-warm",
    tags: ["cold-start", "warm"],
    segments: [
      { text: "PK and PD data from the IND-enabling studies are in.", expect: { PD: "pharmacodynamics" } },
      { text: "The CRO delivered the GMP batch." },
      { text: "PD markers responded at the low dose.", expect: { PD: "pharmacodynamics" } },
    ],
  },
  {
    id: "pd-product-keyword",
    tags: ["cold-start", "keyword", "same-sentence"],
    segments: [
      {
        text: "PD and marketing meet weekly about the sales pipeline.",
        expect: { PD: "product-development" },
      },
    ],
  },
  // ---------------------------------------------------------------- ISO
  {
    id: "iso-stock-option-keyword",
    tags: ["keyword"],
    segments: [
      { text: "Quarterly earnings and revenue first." },
      { text: "Then equity: your grant is an ISO.", expect: { ISO: "incentive-stock-option" } },
    ],
  },
  {
    id: "iso-standards-keyword",
    tags: ["keyword", "same-sentence"],
    segments: [
      { text: "Our supply chain audit covers ISO 9001 this year.", expect: { ISO: "iso-standards" } },
    ],
  },
  {
    id: "iso-stock-option-cold",
    tags: ["cold-start"],
    segments: [{ text: "Is your grant an ISO?", expect: { ISO: "incentive-stock-option" } }],
  },
];
