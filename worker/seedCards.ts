import type { CardSet } from '../shared/cards.ts'
import S01 from '../knowledge/cards/S01.json' with { type: 'json' }
import S02 from '../knowledge/cards/S02.json' with { type: 'json' }
import S03 from '../knowledge/cards/S03.json' with { type: 'json' }
import S04 from '../knowledge/cards/S04.json' with { type: 'json' }
import A01 from '../knowledge/cards/A01.json' with { type: 'json' }

// Curated knowledge cards for the four AFS originals and the bundled added sources (A01), versioned in the repository (knowledge/cards/*.json).
// They are used without any model call. An expert's edits or a re-read are stored in KV and take
// precedence; "Reset" removes the KV copy and returns to these files.
export const SEED_CARDS: Record<string, CardSet> = { S01, S02, S03, S04, A01 } as Record<string, CardSet>
