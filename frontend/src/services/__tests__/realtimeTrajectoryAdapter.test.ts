import assert from 'node:assert/strict'
import test from 'node:test'

import {
  appendVehicleHistoryPoint,
  buildSystemOverviewUnityPoses,
  comparableDeviceCode,
  mergeAuthoritativeFrame,
  resetVehicleHistoriesForScope,
  systemOverviewPoseFrameKey,
} from '../realtimeTrajectoryAdapter.js'
import type { VehicleHistory, VehicleHistoryPoint } from '../realtimeTrajectoryAdapter.js'
import type { AlgorithmRuntimeFrame } from '../../types/mission.js'
import type {
  GatewayEnvelope,
  PoseBatchPayload,
  TargetBatchPayload,
} from '../../types/realtime.js'

const now = Date.parse('2026-09-09T04:00:00.000Z')

function algorithmFrame(algorithmCode: string, codes: string[]): AlgorithmRuntimeFrame {
  return {
    runId: 1,
    algorithmCode,
    sequence: 1,
    timestamp: now,
    phase: 'RUNNING',
    agents: [],
    targets: codes.map((code, index) => ({
      code,
      type: 'CAPTURE_TARGET',
      x: 10 + index,
      y: 20 + index,
      z: 30 + index,
      heading: 40,
      visible: true,
      groupId: 'algorithm-group',
      state: 'TRACKED',
      threatLevel: 3,
    })),
    metrics: {},
    route: [],
    obstacles: [],
    terminalStatus: null,
  }
}

function targetBatch(timestamp = '2026-09-09T03:59:59.000Z'): GatewayEnvelope<TargetBatchPayload> {
  return {
    version: '1',
    type: 'telemetry.target_batch',
    source: 'ros-gateway-v1',
    timestamp,
    sequence: 8,
    streamId: 'targets',
    payload: {
      frameId: 'map',
      targets: [{
        id: ' Enemy_Ship ',
        coordinateValid: true,
        position: { x: 101, y: 202, z: 3 },
        pose: { orientation: { x: 0, y: 0, z: 0, w: 1 } },
        velocity: { linear: { x: 1, y: 2, z: 0 } },
        timestamp,
        sourceStream: '/enemy_ship/pose',
        classification: 'VESSEL',
        affiliation: 'HOSTILE',
        confidence: 0.98,
      }],
    },
  }
}

function poseBatch(): GatewayEnvelope<PoseBatchPayload> {
  return {
    version: '1',
    type: 'telemetry.pose_batch',
    source: 'ros-gateway-v1',
    timestamp: '2026-09-09T03:59:59.000Z',
    runId: 'run-1',
    sequence: 7,
    streamId: 'poses',
    payload: {
      vehicles: Array.from({ length: 6 }, (_, index) => ({
        deviceCode: `${index < 3 ? 'UAV' : 'USV'}_0${index % 3 + 1}`,
        fresh: true,
        positionValid: true,
        localPositionEnuM: { x: index + 1, y: index + 2, z: index + 3 },
      })),
    },
  }
}

test('canonicalizes supported UAV and USV numeric device codes', () => {
  for (const [input, expected] of [
    ['uav_01', 'uav-001'],
    ['UAV-01', 'uav-001'],
    ['UAV-001', 'uav-001'],
    ['uav001', 'uav-001'],
    ['usv_03', 'usv-003'],
    ['USV-3', 'usv-003'],
    ['USV-003', 'usv-003'],
  ] as const) {
    assert.equal(comparableDeviceCode(input), expected)
  }
})

test('keeps generic device-code normalization for non-UAV/USV codes', () => {
  assert.equal(comparableDeviceCode(' Enemy_Ship '), 'enemy-ship')
  assert.equal(comparableDeviceCode('TARGET'), 'target')
  assert.equal(comparableDeviceCode('sensor_01'), 'sensor-01')
})

for (const [algorithmCode, rosCode] of [
  ['UAV-001', 'uav_01'],
  ['USV-001', 'usv_01'],
] as const) {
  test(`${algorithmCode} uses fresh valid ROS position from ${rosCode}`, () => {
    const frame = algorithmFrame('GB_SFLA_CS', [])
    frame.agents = [{
      code: algorithmCode,
      type: algorithmCode.startsWith('UAV') ? 'UAV' : 'USV',
      x: 100,
      y: 200,
      z: 300,
      heading: 40,
      role: 'TEST',
    }]
    const batch = poseBatch()
    batch.payload.vehicles = [{
      deviceCode: rosCode,
      fresh: true,
      positionValid: true,
      localPositionEnuM: { x: 1, y: 2, z: 3 },
    }]

    const agent = mergeAuthoritativeFrame(frame, batch, null, now)?.agents[0]
    assert.equal(agent?.positionAuthority, 'ROS_POSE_BATCH')
    assert.deepEqual(
      { x: agent?.x, y: agent?.y, z: agent?.z },
      { x: 1, y: 2, z: 3 },
    )
  })
}

test('stale ROS vehicle position falls back to algorithm position', () => {
  const frame = algorithmFrame('GB_SFLA_CS', [])
  frame.agents = [{
    code: 'UAV-001', type: 'UAV', x: 100, y: 200, z: 300, heading: 40, role: 'TEST',
  }]
  const batch = poseBatch()
  batch.payload.vehicles = [{
    deviceCode: 'uav_01',
    fresh: false,
    positionValid: true,
    localPositionEnuM: { x: 1, y: 2, z: 3 },
  }]

  const agent = mergeAuthoritativeFrame(frame, batch, null, now)?.agents[0]
  assert.equal(agent?.positionAuthority, 'ALGORITHM')
  assert.deepEqual(
    { x: agent?.x, y: agent?.y, z: agent?.z },
    { x: 100, y: 200, z: 300 },
  )
})

test('missing ROS vehicle position keeps algorithm authority', () => {
  const frame = algorithmFrame('GB_SFLA_CS', [])
  frame.agents = [{
    code: 'UAV-001', type: 'UAV', x: 100, y: 200, z: 300, heading: 40, role: 'TEST',
  }]
  assert.equal(
    mergeAuthoritativeFrame(frame, null, null, now)?.agents[0]?.positionAuthority,
    'ALGORITHM',
  )
})

function historyPoint(
  x: number,
  positionAuthority: VehicleHistoryPoint['positionAuthority'],
  coordinateFrame = 'FLEET_LOCAL_ENU',
): VehicleHistoryPoint {
  return { x, y: 0, positionAuthority, coordinateFrame, runId: 1 }
}

test('ROS to ROS remains in one vehicle history segment', () => {
  const history: VehicleHistory = []
  appendVehicleHistoryPoint(history, historyPoint(0, 'ROS_POSE_BATCH'))
  appendVehicleHistoryPoint(history, historyPoint(1, 'ROS_POSE_BATCH'))
  assert.deepEqual(history.map(segment => segment.length), [2])
})

test('ROS to algorithm starts a new vehicle history segment', () => {
  const history: VehicleHistory = []
  appendVehicleHistoryPoint(history, historyPoint(0, 'ROS_POSE_BATCH'))
  appendVehicleHistoryPoint(history, historyPoint(100, 'ALGORITHM'))
  assert.deepEqual(history.map(segment => segment.map(point => point.x)), [[0], [100]])
})

test('algorithm to ROS starts a new vehicle history segment', () => {
  const history: VehicleHistory = []
  appendVehicleHistoryPoint(history, historyPoint(100, 'ALGORITHM'))
  appendVehicleHistoryPoint(history, historyPoint(0, 'ROS_POSE_BATCH'))
  assert.deepEqual(history.map(segment => segment.map(point => point.x)), [[100], [0]])
})

test('coordinate-frame change starts a new vehicle history segment', () => {
  const history: VehicleHistory = []
  appendVehicleHistoryPoint(history, historyPoint(0, 'ROS_POSE_BATCH', 'FLEET_LOCAL_ENU'))
  appendVehicleHistoryPoint(history, historyPoint(1, 'ROS_POSE_BATCH', 'GLOBAL_ENU'))
  assert.deepEqual(history.map(segment => segment.length), [1, 1])
})

test('runId scope change clears old vehicle history', () => {
  const histories: Record<string, VehicleHistory> = {
    'UAV-001': [[historyPoint(0, 'ROS_POSE_BATCH')]],
  }
  const scope = resetVehicleHistoriesForScope('mission-1:run-1', 'mission-1:run-2', histories)
  assert.equal(scope, 'mission-1:run-2')
  assert.deepEqual(histories, {})
})

function overviewPoses(batch: GatewayEnvelope<TargetBatchPayload> | null) {
  return buildSystemOverviewUnityPoses(poseBatch(), batch, now)
}

test('system overview appends one valid enemy_ship after six vehicle poses', () => {
  const poses = overviewPoses(targetBatch())
  assert.equal(poses.length, 7)
  assert.deepEqual(poses.at(-1), { deviceCode: 'enemy_ship', position: [101, 202, 3] })
})

test('system overview keeps six poses without a target batch', () => {
  assert.equal(overviewPoses(null).length, 6)
})

test('system overview excludes stale enemy_ship', () => {
  assert.equal(overviewPoses(targetBatch('2026-09-09T03:59:56.999Z')).length, 6)
})

test('system overview excludes coordinate-invalid enemy_ship', () => {
  const batch = targetBatch()
  batch.payload.targets[0].coordinateValid = false
  assert.equal(overviewPoses(batch).length, 6)
})

test('system overview excludes enemy_ship outside the map frame', () => {
  const batch = targetBatch()
  batch.payload.frameId = 'odom'
  assert.equal(overviewPoses(batch).length, 6)
})

for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
  test(`system overview excludes enemy_ship with non-finite coordinate ${invalid}`, () => {
    const batch = targetBatch()
    batch.payload.targets[0].position!.x = invalid
    assert.equal(overviewPoses(batch).length, 6)
  })
}

test('target-only update changes the system overview frame key', () => {
  const first = targetBatch()
  const second = targetBatch('2026-09-09T03:59:59.500Z')
  second.sequence = first.sequence + 1
  assert.notEqual(
    systemOverviewPoseFrameKey('run-1', poseBatch(), first),
    systemOverviewPoseFrameKey('run-1', poseBatch(), second),
  )
})

test('system overview emits at most one enemy_ship when the target batch contains duplicates', () => {
  const batch = targetBatch()
  batch.payload.targets.push({ ...batch.payload.targets[0] })
  const poses = overviewPoses(batch)
  assert.equal(poses.filter(pose => pose.deviceCode === 'enemy_ship').length, 1)
})

test('creates a complete observation-only enemy_ship target without an algorithm frame', () => {
  const merged = mergeAuthoritativeFrame(null, null, targetBatch(), now)
  assert.equal(merged?.mode, 'OBSERVATION_ONLY')
  const target = merged?.targets[0]
  assert.equal(target?.canonicalTargetId, 'enemy_ship')
  assert.equal(target?.externalTargetId, 'enemy_ship')
  assert.deepEqual(target?.orientation, { x: 0, y: 0, z: 0, w: 1 })
  assert.equal(target?.positionAuthority, 'ROS_TARGET_BATCH')
})

for (const [algorithmCode, targetCode] of [
  ['GB_SFLA_CS', 'TARGET-001'],
  ['ESCORT_GUARD', 'TARGET'],
] as const) {
  test(`${algorithmCode} ${targetCode} aliases to enemy_ship while preserving algorithm metadata`, () => {
    const merged = mergeAuthoritativeFrame(algorithmFrame(algorithmCode, [targetCode]), null, targetBatch(), now)
    const target = merged?.targets[0]
    assert.equal(target?.code, targetCode)
    assert.equal(target?.groupId, 'algorithm-group')
    assert.equal(target?.x, 101)
    assert.equal(target?.canonicalTargetId, 'enemy_ship')
    assert.equal(target?.externalTargetId, 'enemy_ship')
    assert.equal(target?.positionAuthority, 'ROS_TARGET_BATCH')
  })
}

test('TARGET-002 does not bind to enemy_ship', () => {
  const target = mergeAuthoritativeFrame(
    algorithmFrame('GB_SFLA_CS', ['TARGET-002']), null, targetBatch(), now,
  )?.targets[0]
  assert.equal(target?.x, 10)
  assert.equal(target?.positionAuthority, 'ALGORITHM')
})

test('only one algorithm target may claim a canonical ROS target in one frame', () => {
  const frame = algorithmFrame('GB_SFLA_CS', ['TARGET-001', 'other'])
  frame.targets[1].externalTargetId = 'enemy_ship'
  const targets = mergeAuthoritativeFrame(frame, null, targetBatch(), now)?.targets ?? []
  assert.equal(targets[0].positionAuthority, 'ROS_TARGET_BATCH')
  assert.equal(targets[0].x, 101)
  assert.equal(targets[1].positionAuthority, 'ALGORITHM')
  assert.equal(targets[1].x, 11)
})

test('stale ROS target does not override algorithm position', () => {
  const stale = targetBatch('2026-09-09T03:59:56.999Z')
  const target = mergeAuthoritativeFrame(
    algorithmFrame('GB_SFLA_CS', ['TARGET-001']), null, stale, now,
  )?.targets[0]
  assert.equal(target?.x, 10)
  assert.equal(target?.positionAuthority, 'ALGORITHM')
})
