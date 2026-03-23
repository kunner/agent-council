import { useState, useCallback } from 'react'

interface MentionState {
  active: boolean
  query: string
  startIndex: number
}

export function useMention() {
  const [mention, setMention] = useState<MentionState>({
    active: false,
    query: '',
    startIndex: -1,
  })

  const handleInputChange = useCallback((value: string, cursorPos: number) => {
    // Find the last @ before cursor
    const textBeforeCursor = value.slice(0, cursorPos)
    const lastAtIndex = textBeforeCursor.lastIndexOf('@')

    if (lastAtIndex === -1) {
      setMention({ active: false, query: '', startIndex: -1 })
      return
    }

    const textAfterAt = textBeforeCursor.slice(lastAtIndex + 1)

    // If there's a space after @query, close the popover
    if (textAfterAt.includes(' ')) {
      setMention({ active: false, query: '', startIndex: -1 })
      return
    }

    setMention({
      active: true,
      query: textAfterAt,
      startIndex: lastAtIndex,
    })
  }, [])

  const completeMention = useCallback((
    currentValue: string,
    selectedMention: string,
  ): string => {
    if (mention.startIndex === -1) return currentValue

    const before = currentValue.slice(0, mention.startIndex)
    const after = currentValue.slice(mention.startIndex + mention.query.length + 1)

    return `${before}@${selectedMention} ${after}`
  }, [mention])

  const closeMention = useCallback(() => {
    setMention({ active: false, query: '', startIndex: -1 })
  }, [])

  return { mention, handleInputChange, completeMention, closeMention }
}
