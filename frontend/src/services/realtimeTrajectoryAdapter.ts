import type { UnityTrajectoryAgent, UnityTrajectoryFrame } from '@/stores/trajectory'
import type {
  GatewayEnvelope,
  PoseBatchPayload,
  TargetBatchPayload,
  TargetState,
  VehiclePoseSample,
} from '@/types/realtime'
import type { AlgorithmRuntimeFrame, AlgorithmTargetFrame } from '@/types/mission'
import type {
  AgentPositionAuthority,
  AuthoritativeFrame,
  ObservedTargetFrame,
} from '@/types/authoritativeFrame'

export type RealtimeRunScopePolicy = 'STRICT' | 'ALLOW_MISSING' | 'OBSERVATION'

export type RealtimeTrajectoryContext = {
  missionId?: number | string | null
  runId?: number | string | null
  phase?: string | null
}

export type MissionCenterPoseFrameContext = RealtimeTrajectoryContext & {
  algorithmCode?: string | null
  route?: Array<{ x: number; y: number }>
  obstacles?: unknown[]
}

export type SystemOverviewPose = {
  deviceCode: string
  deviceType: string
  type: string
  state: string
  valid: boolean
  position: [number, number, number]
  eastM: number
  northM: number
  upM: number
  headingDeg: number
  x: number
  y: number
  z: number
  yaw: number
}

function finite(value: unknown, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function normalizedScopeId(value: unknown) {
  const text = String(value ?? '').trim()
  return text || null
}

export function normalizeRealtimeDeviceCode(value: unknown) {
  return String(value ?? '').trim().toLowerCase()
}

export type VehicleHistoryPoint = {
  x: number
  y: number
  positionAuthority: AgentPositionAuthority
  coordinateFrame: string | null
  runId: number | string | null
}

export type VehicleHistory = VehicleHistoryPoint[][]

export function resetVehicleHistoriesForScope(
  currentScope: string,
  nextScope: string,
  histories: Record<string, VehicleHistory>,
) {
  if (currentScope === nextScope) return currentScope
  Object.keys(histories).forEach(key => delete histories[key])
  return nextScope
}

export function appendVehicleHistoryPoint(
  history: VehicleHistory,
  point: VehicleHistoryPoint,
  maxPoints = 520,
) {
  const segment = history[history.length - 1]
  const previous = segment?.[segment.length - 1]
  const sameSource = previous?.positionAuthority === point.positionAuthority
    && previous.coordinateFrame === point.coordinateFrame
  if (!segment || !sameSource) {
    history.push([point])
  } else if (!previous || Math.hypot(previous.x - point.x, previous.y - point.y) > 0.06) {
    segment.push(point)
  }
  let overflow = history.reduce((sum, item) => sum + item.length, 0) - maxPoints
  while (overflow > 0 && history.length) {
    const first = history[0]!
    const removeCount = Math.min(overflow, first.length)
    first.splice(0, removeCount)
    overflow -= removeCount
    if (!first.length) history.shift()
  }
}

export function comparableDeviceCode(value: unknown) {
  const normalized = normalizeRealtimeDeviceCode(value).replace(/_/g, '-')
  const vehicleCode = /^(uav|usv)-?(\d+)$/.exec(normalized)
  if (!vehicleCode) return normalized
  const number = vehicleCode[2]!.replace(/^0+(?=\d)/, '').padStart(3, '0')
  return `${vehicleCode[1]!}-${number}`
}

export function isRealtimeEnvelopeApplicable(
  envelope: Pick<GatewayEnvelope, 'runId' | 'missionId'> | null | undefined,
  context: RealtimeTrajectoryContext = {},
  policy: RealtimeRunScopePolicy = 'ALLOW_MISSING',
) {
  if (!envelope) return false
  const envelopeRunId = normalizedScopeId(envelope.runId)
  const contextRunId = normalizedScopeId(context.runId)
  const envelopeMissionId = normalizedScopeId(envelope.missionId)
  const contextMissionId = normalizedScopeId(context.missionId)
  const missionMatches = !envelopeMissionId || !contextMissionId || envelopeMissionId === contextMissionId
  if (policy === 'STRICT') {
    return !!envelopeRunId && !!contextRunId && envelopeRunId === contextRunId && missionMatches
  }
  if (policy === 'OBSERVATION') {
    if (envelopeRunId) {
      return !!contextRunId && envelopeRunId === contextRunId && missionMatches
    }
    return missionMatches
  }
  if (!envelopeRunId) return !!contextRunId && missionMatches
  return !!contextRunId && envelopeRunId === contextRunId && missionMatches
}

function poseDeviceType(deviceCode: string): UnityTrajectoryAgent['type'] {
  const code = normalizeRealtimeDeviceCode(deviceCode)
  if (code.startsWith('usv')) return 'USV'
  if (code.startsWith('target') || code.startsWith('tgt')) return 'TARGET'
  return 'UAV'
}

function validPoseSample(sample: VehiclePoseSample) {
  const position = sample.localPositionEnuM
  return !!position
    && sample.fresh !== false
    && sample.positionValid !== false
    && Number.isFinite(position.x)
    && Number.isFinite(position.y)
    && Number.isFinite(position.z)
    && !!normalizeRealtimeDeviceCode(sample.deviceCode)
}

function poseState(sample: VehiclePoseSample) {
  if (sample.fresh === false || sample.positionValid === false) return 'STALE'
  return 'ACTIVE'
}

export function poseBatchTimestampMs(envelope: GatewayEnvelope<PoseBatchPayload> | null | undefined) {
  if (!envelope) return 0
  return Date.parse(envelope.timestamp)
    || Date.parse(envelope.payload.snapshotTime ?? '')
    || 0
}

export function poseBatchValidVehicleCount(envelope: GatewayEnvelope<PoseBatchPayload> | null | undefined) {
  return envelope?.payload.vehicles?.filter(validPoseSample).length ?? 0
}

export function isPoseBatchLive(
  envelope: GatewayEnvelope<PoseBatchPayload> | null | undefined,
  now = Date.now(),
  maxAgeMs = 3000,
) {
  if (!envelope || poseBatchValidVehicleCount(envelope) === 0) return false
  const timestampMs = poseBatchTimestampMs(envelope)
  if (timestampMs <= 0) return true
  return now - timestampMs <= maxAgeMs
}

const SUPPORTED_TARGET_FRAMES = new Set(['map'])

const TARGET_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  GB_SFLA_CS: {
    'TARGET-001': 'enemy_ship',
  },
  ESCORT_GUARD: {
    TARGET: 'enemy_ship',
  },
}

let lastTargetMergeDebugAt = 0

function normalizeTargetId(value: unknown) {
  return String(value ?? '').trim().toLowerCase()
}

function resolveCanonicalTargetId(
  algorithmCode: string,
  target: AlgorithmRuntimeFrame['targets'][number],
  authoritativeTargets: ReadonlyMap<string, TargetState>,
) {
  const explicitId = normalizeTargetId(target.externalTargetId)
    || normalizeTargetId(target.canonicalTargetId)
  if (explicitId) return explicitId

  const directId = normalizeTargetId(target.code)
  if (authoritativeTargets.has(directId)) return directId

  return normalizeTargetId(
    TARGET_ALIASES[String(algorithmCode ?? '').trim().toUpperCase()]?.[
      String(target.code ?? '').trim().toUpperCase()
    ],
  ) || null
}

function finiteVector(value: { x: number; y: number; z: number } | null | undefined) {
  return !!value
    && Number.isFinite(value.x)
    && Number.isFinite(value.y)
    && Number.isFinite(value.z)
}

function finiteQuaternion(value: { x: number; y: number; z: number; w: number } | null | undefined) {
  return !!value
    && Number.isFinite(value.x)
    && Number.isFinite(value.y)
    && Number.isFinite(value.z)
    && Number.isFinite(value.w)
    && (value.x !== 0 || value.y !== 0 || value.z !== 0 || value.w !== 0)
}

function targetFrameId(target: TargetState, batch: TargetBatchPayload) {
  return String(target.frameId ?? '').trim() || String(batch.frameId ?? '').trim()
}

function targetTimestampMs(target: TargetState) {
  return Date.parse(target.timestamp ?? '') || 0
}

function targetIsFresh(target: TargetState, now: number, maxAgeMs: number) {
  const timestamp = targetTimestampMs(target)
  return timestamp > 0 && now - timestamp <= maxAgeMs
}

function validTargetState(
  target: TargetState,
  batch: TargetBatchPayload,
  now: number,
  maxAgeMs: number,
) {
  const id = String(target.id ?? '').trim()
  const frameId = targetFrameId(target, batch)
  const posePositionValid = !target.pose?.position || finiteVector(target.pose.position)
  const orientationValid = !target.pose?.orientation || finiteQuaternion(target.pose.orientation)
  return !!id
    && target.coordinateValid === true
    && SUPPORTED_TARGET_FRAMES.has(frameId)
    && finiteVector(target.position)
    && posePositionValid
    && orientationValid
    && targetIsFresh(target, now, maxAgeMs)
}

export function selectValidEnemyShipTarget(
  envelope: GatewayEnvelope<TargetBatchPayload> | null | undefined,
  now = Date.now(),
  maxAgeMs = 3000,
) {
  if (!envelope) return null
  return envelope.payload.targets.find(target => (
    normalizeTargetId(target.id) === 'enemy_ship'
    && validTargetState(target, envelope.payload, now, maxAgeMs)
  )) ?? null
}

export type SystemOverviewUnityPose = {
  deviceCode: string
  position: [number, number, number]
}

export function buildSystemOverviewUnityPoses(
  poseBatch: GatewayEnvelope<PoseBatchPayload>,
  targetBatch: GatewayEnvelope<TargetBatchPayload> | null | undefined,
  now = Date.now(),
): SystemOverviewUnityPose[] {
  const vehiclePoses = poseBatch.payload.vehicles
    .filter(validPoseSample)
    .map(vehicle => {
      const position = vehicle.localPositionEnuM!
      return {
        deviceCode: normalizeRealtimeDeviceCode(vehicle.deviceCode),
        position: [position.x, position.y, position.z] as [number, number, number],
      }
    })
  const enemyShip = selectValidEnemyShipTarget(targetBatch, now)
  if (!enemyShip?.position) return vehiclePoses
  return [
    ...vehiclePoses,
    {
      deviceCode: 'enemy_ship',
      position: [enemyShip.position.x, enemyShip.position.y, enemyShip.position.z],
    },
  ]
}

export function systemOverviewPoseFrameKey(
  runtimeId: number | string,
  poseBatch: GatewayEnvelope<PoseBatchPayload>,
  targetBatch: GatewayEnvelope<TargetBatchPayload> | null | undefined,
) {
  return [
    runtimeId,
    poseBatch.source,
    poseBatch.sequence,
    targetBatch?.runId ?? '',
    targetBatch?.sequence ?? 0,
    targetBatch?.timestamp ?? '',
  ].join(':')
}

function quaternionHeadingDeg(target: TargetState, fallback: number) {
  const q = target.pose?.orientation
  if (!q || !finiteQuaternion(q)) return fallback
  const yaw = Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y ** 2 + q.z ** 2))
  return yaw * 180 / Math.PI
}

export function mergeAuthoritativeFrame(
  algorithmFrame: AlgorithmRuntimeFrame | null | undefined,
  poseBatch: GatewayEnvelope<PoseBatchPayload> | null | undefined,
  targetBatch: GatewayEnvelope<TargetBatchPayload> | null | undefined,
  now = Date.now(),
  maxTargetAgeMs = 3000,
  context: RealtimeTrajectoryContext = {},
): AuthoritativeFrame | null {
  const authoritativePoses = new Map(
    isPoseBatchLive(poseBatch, now)
      ? (poseBatch?.payload.vehicles ?? [])
        .filter(validPoseSample)
        .map(sample => [comparableDeviceCode(sample.deviceCode), sample] as const)
      : [],
  )
  const authoritativeTargets = new Map(
    (targetBatch?.payload.targets ?? [])
      .filter(target => validTargetState(target, targetBatch!.payload, now, maxTargetAgeMs))
      .map(target => [normalizeTargetId(target.id), target] as const),
  )

  if (!algorithmFrame) {
    const agents = [...authoritativePoses.values()]
      .map((sample) => {
        const position = sample.localPositionEnuM!
        const type = poseDeviceType(sample.deviceCode)
        if (type === 'TARGET') return null
        return {
          code: normalizeRealtimeDeviceCode(sample.deviceCode),
          type,
          x: position.x,
          y: position.y,
          z: position.z,
          heading: finite(sample.headingDeg),
          role: 'OBSERVATION',
          status: poseState(sample),
          positionAuthority: 'ROS_POSE_BATCH' as const,
        }
      })
      .filter((agent): agent is NonNullable<typeof agent> => agent !== null)
    const observedTargets: ObservedTargetFrame[] = [...authoritativeTargets.values()]
      .filter(state => normalizeTargetId(state.id) === 'enemy_ship')
      .map(state => ({
      id: String(state.id).trim(),
      code: String(state.id).trim(),
      canonicalTargetId: normalizeTargetId(state.id),
      externalTargetId: normalizeTargetId(state.id),
      type: 'OBSERVED_TARGET',
      x: state.position!.x,
      y: state.position!.y,
      z: state.position!.z,
      heading: quaternionHeadingDeg(state, 0),
      orientation: state.pose?.orientation,
      positionAuthority: 'ROS_TARGET_BATCH',
      visible: true,
      frameId: targetFrameId(state, targetBatch!.payload),
      sourceStream: state.sourceStream,
      sourceTimestamp: state.timestamp,
      classification: state.classification,
      affiliation: state.affiliation,
      confidence: state.confidence,
      velocity: state.velocity,
      }))
    const targets = observedTargets
    const poseTimestamp = agents.length ? poseBatchTimestampMs(poseBatch) : 0
    const targetTimestamp = targets.reduce((latest, target) => (
      Math.max(latest, Date.parse(target.sourceTimestamp ?? '') || 0)
    ), 0)
    return {
      mode: 'OBSERVATION_ONLY',
      runId: context.runId ?? null,
      missionId: context.missionId ?? null,
      algorithmCode: null,
      coordinateFrame: 'FLEET_LOCAL_ENU',
      sequence: Math.max(agents.length ? poseBatch?.sequence ?? 0 : 0, targets.length ? targetBatch?.sequence ?? 0 : 0),
      timestamp: Math.max(poseTimestamp, targetTimestamp) || now,
      phase: null,
      agents,
      targets,
      metrics: {},
      route: [],
      obstacles: [],
      terminalStatus: null,
    }
  }

  const claimedCanonicalIds = new Set<string>()

  return {
    ...algorithmFrame,
    mode: 'ALGORITHM_MERGED',
    missionId: context.missionId ?? null,
    agents: algorithmFrame.agents.map((agent) => {
      const sample = authoritativePoses.get(comparableDeviceCode(agent.code))
      if (!sample?.localPositionEnuM) {
        return { ...agent, positionAuthority: 'ALGORITHM' as const }
      }
      return {
        ...agent,
        x: finite(sample.localPositionEnuM.x, agent.x),
        y: finite(sample.localPositionEnuM.y, agent.y),
        z: finite(sample.localPositionEnuM.z, agent.z),
        heading: finite(sample.headingDeg, agent.heading),
        positionAuthority: 'ROS_POSE_BATCH' as const,
      }
    }),
    targets: algorithmFrame.targets.map((target) => {
      const canonicalTargetId = resolveCanonicalTargetId(
        algorithmFrame.algorithmCode,
        target,
        authoritativeTargets,
      )
      if (!canonicalTargetId) {
        return { ...target, positionAuthority: 'ALGORITHM' as const }
      }
      const state = authoritativeTargets.get(canonicalTargetId)
      if (!state?.position || !targetBatch) {
        return { ...target, positionAuthority: 'ALGORITHM' as const }
      }
      if (claimedCanonicalIds.has(canonicalTargetId)) {
        if (import.meta.env?.DEV) {
          console.warn(
            `[realtimeTrajectoryAdapter] canonical target "${canonicalTargetId}" is already claimed; preserving algorithm position for "${target.code}".`,
          )
        }
        return { ...target, positionAuthority: 'ALGORITHM' as const }
      }
      claimedCanonicalIds.add(canonicalTargetId)
      const mergedTarget = {
        ...target,
        canonicalTargetId,
        externalTargetId: canonicalTargetId,
        x: state.position.x,
        y: state.position.y,
        z: state.position.z,
        heading: quaternionHeadingDeg(state, target.heading),
        orientation: state.pose?.orientation,
        positionAuthority: 'ROS_TARGET_BATCH' as const,
        frameId: targetFrameId(state, targetBatch.payload),
        sourceStream: state.sourceStream,
        sourceTimestamp: state.timestamp,
        classification: state.classification,
        affiliation: state.affiliation,
        confidence: state.confidence,
        velocity: state.velocity,
      }
      if (import.meta.env?.DEV && Date.now() - lastTargetMergeDebugAt >= 1000) {
        lastTargetMergeDebugAt = Date.now()
        console.debug('[TARGET-MERGE-DEBUG]', {
          algorithmCode: algorithmFrame.algorithmCode,
          algorithmTargetCode: target.code,
          canonicalTargetId: mergedTarget.canonicalTargetId,
          externalTargetId: mergedTarget.externalTargetId,
          positionAuthority: mergedTarget.positionAuthority,
          algorithmPosition: { x: target.x, y: target.y, z: target.z },
          rosPosition: { x: state.position.x, y: state.position.y, z: state.position.z },
          mergedPosition: { x: mergedTarget.x, y: mergedTarget.y, z: mergedTarget.z },
          sourceTimestamp: mergedTarget.sourceTimestamp,
        })
      }
        return mergedTarget
      }),
  }
}

export function algorithmFrameToTrajectoryFrame(
  frame: AuthoritativeFrame | null | undefined,
): UnityTrajectoryFrame | null {
  if (!frame) return null
  return {
    sequence: frame.sequence,
    source: frame.mode === 'OBSERVATION_ONLY' ? 'observation:realtime' : `merged:${frame.algorithmCode}`,
    coordinateSystem: 'MISSION_SCENE_XZ',
    mission: {
      phase: frame.phase ?? 'WAITING_FOR_ALGORITHM',
      elapsed: Math.round(frame.sequence / 10),
      captureRadius: Number(frame.metrics.usvFormationRadius ?? frame.metrics.captureRadius ?? 16),
      defenseRadius: Number(
        frame.metrics.escortFormationRadius ?? frame.metrics.uavFormationRadius ?? 18,
      ),
      captureReady: frame.metrics.captured === true,
      formationHolding: frame.mode === 'ALGORITHM_MERGED'
        && (frame.phase === 'CAPTURED' || frame.phase === 'THREAT_RESPONSE'),
    },
    agents: [
      ...frame.agents.map(agent => ({
        code: agent.code,
        type: agent.type,
        x: agent.x,
        y: agent.z,
        z: agent.y,
        yaw: agent.heading,
        state: agent.role,
      })),
      ...frame.targets
        .filter(target => target.visible !== false)
        .map(target => ({
          code: target.code,
          type: 'TARGET' as const,
          x: target.x,
          y: target.z,
          z: target.y,
          yaw: target.heading,
          state: target.type,
        })),
    ],
    receivedAt: frame.timestamp,
  }
}

export function poseBatchToTrajectoryPayload(
  envelope: GatewayEnvelope<PoseBatchPayload> | null | undefined,
  context: RealtimeTrajectoryContext = {},
) {
  const vehicles = envelope?.payload.vehicles?.filter(validPoseSample) ?? []
  if (!envelope || vehicles.length === 0) return null
  const receivedAt = poseBatchTimestampMs(envelope) || Date.now()
  const runId = envelope.runId ?? context.runId ?? null
  return {
    missionId: context.missionId ?? null,
    runId,
    sequence: envelope.sequence,
    timestamp: receivedAt,
    source: envelope.source || 'ros-gateway-v1',
    coordinateSystem: 'ROS_ENU',
    mission: {
      phase: context.phase || 'ROS_GATEWAY_V1',
      elapsed: 0,
      captureRadius: 16,
      defenseRadius: 18,
      captureReady: false,
      formationHolding: false,
    },
    agents: vehicles.map((vehicle) => {
      const position = vehicle.localPositionEnuM!
      return {
        code: normalizeRealtimeDeviceCode(vehicle.deviceCode),
        type: poseDeviceType(vehicle.deviceCode),
        x: finite(position.x),
        y: finite(position.z),
        z: finite(position.y),
        yaw: finite(vehicle.headingDeg),
        state: poseState(vehicle),
      }
    }),
  }
}

export function poseBatchToTrajectoryFrame(
  envelope: GatewayEnvelope<PoseBatchPayload> | null | undefined,
  context: RealtimeTrajectoryContext = {},
): UnityTrajectoryFrame | null {
  const payload = poseBatchToTrajectoryPayload(envelope, context)
  if (!payload) return null
  return {
    sequence: payload.sequence,
    source: payload.source,
    coordinateSystem: payload.coordinateSystem,
    mission: payload.mission,
    agents: payload.agents,
    receivedAt: Number(payload.timestamp) || Date.now(),
  }
}

export function trajectoryFrameToSystemOverviewPoseFrame(
  frame: UnityTrajectoryFrame | null | undefined,
  context: RealtimeTrajectoryContext = {},
) {
  if (!frame?.agents.length) return null
  const runId = context.runId ?? null
  const poses: SystemOverviewPose[] = frame.agents.map((agent) => {
    const eastM = finite(agent.x)
    const northM = finite(agent.z)
    const upM = finite(agent.y)
    return {
      deviceCode: agent.code,
      deviceType: agent.type,
      type: agent.type,
      state: agent.state,
      valid: true,
      position: [eastM, northM, upM],
      eastM,
      northM,
      upM,
      headingDeg: finite(agent.yaw),
      x: eastM,
      y: northM,
      z: upM,
      yaw: finite(agent.yaw),
    }
  })
  return {
    runtimeMode: 'REAL',
    missionId: context.missionId ?? null,
    runId,
    sequence: frame.sequence,
    source: frame.source,
    coordinateFrame: 'GLOBAL_ENU',
    coordinateSystem: frame.coordinateSystem,
    timestamp: frame.receivedAt,
    timestampMs: frame.receivedAt,
    poses,
  }
}

export function trajectoryFrameToMissionCenterPoseFrame(
  frame: UnityTrajectoryFrame | null | undefined,
  context: MissionCenterPoseFrameContext = {},
) {
  if (!frame?.agents.length) return null
  const runId = Number(context.runId)
  return {
    algorithmCode: String(context.algorithmCode || 'GB_SFLA_CS'),
    runId: Number.isFinite(runId) ? runId : 0,
    sequence: frame.sequence,
    timestamp: frame.receivedAt,
    phase: frame.mission.phase,
    agents: frame.agents
      .filter(agent => agent.type === 'UAV' || agent.type === 'USV')
      .map(agent => ({
        code: agent.code,
        type: agent.type,
        x: finite(agent.x),
        y: finite(agent.z),
        z: finite(agent.y),
        heading: finite(agent.yaw),
      })),
    targets: frame.agents
      .filter(agent => agent.type === 'TARGET')
      .map(agent => ({
        code: agent.code,
        type: 'TARGET',
        x: finite(agent.x),
        y: finite(agent.z),
        z: finite(agent.y),
        heading: finite(agent.yaw),
        visible: true,
      })),
    route: context.route ?? [],
    obstacles: context.obstacles ?? [],
  }
}
