import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import type { ReactNode } from 'react'
import { useParams } from 'react-router-dom'
import type { Sprint } from '@/services/sprints'
import type { Requirement } from '@/services/requirements'
import type { UserStory } from '@/services/userStories'
import type { Task } from '@/services/tasks'
import type { CodeFile } from '@/services/codeFiles'
import type { Question } from '@/services/questions'
import type { Review } from '@/services/reviews'
import type { GeneralInfo } from '@/services/generalInfo'
import type { TimelineEvent } from '@/services/timelineEvents'
import { sprintsService } from '@/services/sprints'
import { requirementsService } from '@/services/requirements'
import { userStoriesService } from '@/services/userStories'
import { tasksService } from '@/services/tasks'
import { codeFilesService } from '@/services/codeFiles'
import { questionsService } from '@/services/questions'
import { reviewsService } from '@/services/reviews'
import { generalInfoService } from '@/services/generalInfo'
import { timelineEventsService } from '@/services/timelineEvents'
import { useSprintGraph } from '@/hooks/useSprintGraph'
import type { ArtifactNeighbor } from '@/hooks/useSprintGraph'

interface SprintContextValue {
  // Core data
  sprint: Sprint | null
  requirements: Requirement[]
  userStories: UserStory[]
  tasks: Task[]
  codeFiles: CodeFile[]
  questions: Question[]
  review: Review | null
  generalInfo: GeneralInfo[]
  timelineEvents: TimelineEvent[]

  // Loading state
  loading: boolean
  error: string | null

  // Actions
  reload: () => Promise<void>
  reloadSprint: () => Promise<void>
  reloadRequirements: () => Promise<void>
  reloadUserStories: () => Promise<void>
  reloadTasks: () => Promise<void>
  reloadCodeFiles: () => Promise<void>
  reloadQuestions: () => Promise<void>
  reloadReview: () => Promise<void>
  reloadTimeline: () => Promise<void>

  // Graph
  getNeighbors: (artifactId: string) => ArtifactNeighbor[]
  reloadGraph: () => Promise<void>

  // IDs from route
  projectId: string
  sprintId: string
}

const SprintContext = createContext<SprintContextValue | undefined>(undefined)

export function SprintProvider({ children }: { children: ReactNode }) {
  const { projectId, sprintId } = useParams<{ projectId: string; sprintId: string }>()

  const [sprint, setSprint] = useState<Sprint | null>(null)
  const [requirements, setRequirements] = useState<Requirement[]>([])
  const [userStories, setUserStories] = useState<UserStory[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [codeFiles, setCodeFiles] = useState<CodeFile[]>([])
  const [questions, setQuestions] = useState<Question[]>([])
  const [review, setReview] = useState<Review | null>(null)
  const [generalInfo, setGeneralInfo] = useState<GeneralInfo[]>([])
  const [timelineEvents, setTimelineEvents] = useState<TimelineEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const safeProjectId = projectId || ''
  const safeSprintId = sprintId || ''

  // Graph data (fetched once, reloaded after artifacts change)
  const { getNeighbors, reload: reloadGraph } = useSprintGraph(safeSprintId)

  const reloadSprint = useCallback(async () => {
    if (!safeProjectId || !safeSprintId) return
    try {
      const data = await sprintsService.get(safeProjectId, safeSprintId)
      setSprint(data)
    } catch (err) {
      console.error('Failed to load sprint:', err)
    }
  }, [safeProjectId, safeSprintId])

  const reloadRequirements = useCallback(async () => {
    if (!safeSprintId) return
    try { setRequirements(await requirementsService.list(safeSprintId)) } catch { /* ignore */ }
  }, [safeSprintId])

  const reloadUserStories = useCallback(async () => {
    if (!safeSprintId) return
    try { setUserStories(await userStoriesService.list(safeSprintId)) } catch { /* ignore */ }
  }, [safeSprintId])

  const reloadTasks = useCallback(async () => {
    if (!safeSprintId) return
    try { setTasks(await tasksService.list(safeSprintId)) } catch { /* ignore */ }
  }, [safeSprintId])

  const reloadCodeFiles = useCallback(async () => {
    if (!safeSprintId) return
    try { setCodeFiles(await codeFilesService.list(safeSprintId)) } catch { /* ignore */ }
  }, [safeSprintId])

  const reloadQuestions = useCallback(async () => {
    if (!safeSprintId) return
    try { setQuestions(await questionsService.list(safeSprintId)) } catch { /* ignore */ }
  }, [safeSprintId])

  const reloadReview = useCallback(async () => {
    if (!safeSprintId) return
    try { setReview(await reviewsService.get(safeSprintId)) } catch { setReview(null) }
  }, [safeSprintId])

  const reloadTimeline = useCallback(async () => {
    if (!safeSprintId) return
    try { setTimelineEvents(await timelineEventsService.list(safeSprintId)) } catch { /* ignore */ }
  }, [safeSprintId])

  const reloadGeneralInfo = useCallback(async () => {
    if (!safeSprintId) return
    try { setGeneralInfo(await generalInfoService.list(safeSprintId)) } catch { /* ignore */ }
  }, [safeSprintId])

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      await Promise.all([
        reloadSprint(),
        reloadRequirements(),
        reloadUserStories(),
        reloadTasks(),
        reloadCodeFiles(),
        reloadQuestions(),
        reloadReview(),
        reloadTimeline(),
        reloadGeneralInfo(),
        reloadGraph(),
      ])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sprint data')
    } finally {
      setLoading(false)
    }
  }, [reloadSprint, reloadRequirements, reloadUserStories, reloadTasks, reloadCodeFiles, reloadQuestions, reloadReview, reloadTimeline, reloadGeneralInfo, reloadGraph])

  // Load on mount and when IDs change
  useEffect(() => {
    if (safeProjectId && safeSprintId) {
      reload()
    }
  }, [safeProjectId, safeSprintId, reload])

  // Always poll sprint status — fast when agent is active, slow as background refresh
  useEffect(() => {
    const isActive = sprint?.currentAgentStatus === 'running' || sprint?.currentAgentStatus === 'waiting'
    const intervalMs = isActive ? 10000 : 60000
    const interval = setInterval(reloadSprint, intervalMs)
    return () => clearInterval(interval)
  }, [sprint?.currentAgentStatus, reloadSprint])

  return (
    <SprintContext.Provider value={{
      sprint, requirements, userStories, tasks, codeFiles, questions,
      review, generalInfo, timelineEvents, loading, error,
      reload, reloadSprint, reloadRequirements, reloadUserStories,
      reloadTasks, reloadCodeFiles, reloadQuestions, reloadReview, reloadTimeline,
      getNeighbors, reloadGraph,
      projectId: safeProjectId, sprintId: safeSprintId,
    }}>
      {children}
    </SprintContext.Provider>
  )
}

export function useSprint() {
  const context = useContext(SprintContext)
  if (!context) {
    throw new Error('useSprint must be used within a SprintProvider')
  }
  return context
}
