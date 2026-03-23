export const SET_COLORS = [
  { name: '아키텍처', hex: '#8B5CF6', emoji: '🎯' },
  { name: '백엔드',   hex: '#22C55E', emoji: '🟢' },
  { name: '프론트',   hex: '#3B82F6', emoji: '🔵' },
  { name: 'QA',       hex: '#EAB308', emoji: '🟡' },
  { name: 'DevOps',   hex: '#F97316', emoji: '🟠' },
  { name: '보안',     hex: '#EF4444', emoji: '🔴' },
  { name: '디자인',   hex: '#EC4899', emoji: '🩷' },
  { name: '데이터',   hex: '#06B6D4', emoji: '🩵' },
] as const

export type SetColorName = (typeof SET_COLORS)[number]['name']
