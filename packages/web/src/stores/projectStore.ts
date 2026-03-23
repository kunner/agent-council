import { create } from 'zustand'
import type { Project, AgentSet } from '@agent-council/shared'

interface ProjectState {
  currentProject: Project | null
  sets: AgentSet[]
  setCurrentProject: (project: Project | null) => void
  setSets: (sets: AgentSet[]) => void
}

export const useProjectStore = create<ProjectState>((set) => ({
  currentProject: null,
  sets: [],
  setCurrentProject: (project) => set({ currentProject: project }),
  setSets: (sets) => set({ sets }),
}))
