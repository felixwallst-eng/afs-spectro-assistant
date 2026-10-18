// Knowledge cards: every document is read once, completely, when it enters the knowledge base.
// The model extracts the statements that matter for the decision steps; each statement keeps a
// verbatim quote that code has verified against the page text. Analyses then use all cards of a
// step instead of searching the documents again – same input every time, and every page was read.

export interface KnowledgeCard {
  id: string // `${docId}-${n}`
  docId: string
  page: number
  /** Decision step (tree node id) the statement is about. */
  step: string
  /** Label of the step the statement points to, if it points to one. */
  value: string | null
  /** One sentence: under which condition what follows for the method choice. */
  claim: string
  /** Verbatim sentence from the page (verified). */
  quote: string
}

export interface CardSet {
  docId: string
  createdAt: string
  model: string
  pagesRead: number
  cards: KnowledgeCard[]
  /** Statements the model proposed whose quote was not found on any page. */
  rejected: number
  /** Set by the API: true when these are the curated cards from the repository. */
  curated?: boolean
}
