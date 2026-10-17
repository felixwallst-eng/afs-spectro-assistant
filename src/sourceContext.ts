import { createContext, useContext } from 'react'
import type { SourceRef } from './sources.ts'

export const SourceContext = createContext<(ref: SourceRef) => void>(() => {})
/** Open a source document at a page, optionally highlighting a quoted passage. */
export const useOpenSource = () => useContext(SourceContext)
