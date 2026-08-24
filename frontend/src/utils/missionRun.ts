import type { MissionDetail, MissionRun } from '@/types/mission'

type MissionRunDetail = Pick<MissionDetail, 'currentRun' | 'runs'>

const activeRunStatuses = new Set<MissionRun['status']>(['PENDING', 'RUNNING', 'PAUSED'])

function runCandidates(detail: MissionRunDetail | null | undefined): MissionRun[] {
  if (!detail) return []
  return [
    detail.currentRun,
    ...(detail.runs ?? []),
  ].filter((run): run is MissionRun => Boolean(run))
}

export function resolveActiveRun(detail: MissionRunDetail | null | undefined): MissionRun | null {
  return runCandidates(detail).find((run) => activeRunStatuses.has(run.status)) ?? null
}

export function resolveLatestRun(detail: MissionRunDetail | null | undefined): MissionRun | null {
  return runCandidates(detail)[0] ?? null
}
