import type {
  AlgorithmAgentFrame,
  AlgorithmRuntimeFrame,
  AlgorithmTargetFrame,
} from './mission'

export type AgentPositionAuthority = 'ALGORITHM' | 'ROS_POSE_BATCH'

export type AuthoritativeAgentFrame = AlgorithmAgentFrame & {
  positionAuthority: AgentPositionAuthority
}

export interface ObservedTargetFrame extends Omit<AlgorithmTargetFrame, 'type'> {
  id: string
  type: 'OBSERVED_TARGET'
}

export type AlgorithmMergedAuthoritativeFrame = AlgorithmRuntimeFrame & {
  mode: 'ALGORITHM_MERGED'
  missionId: number | string | null
  agents: AuthoritativeAgentFrame[]
}

export interface ObservationAuthoritativeFrame {
  mode: 'OBSERVATION_ONLY'
  runId: number | string | null
  missionId: number | string | null
  algorithmCode: null
  coordinateFrame: 'FLEET_LOCAL_ENU'
  sequence: number
  timestamp: number
  phase: null
  agents: AuthoritativeAgentFrame[]
  targets: ObservedTargetFrame[]
  metrics: Record<string, never>
  route: []
  obstacles: []
  terminalStatus: null
}

export type AuthoritativeFrame =
  | AlgorithmMergedAuthoritativeFrame
  | ObservationAuthoritativeFrame
