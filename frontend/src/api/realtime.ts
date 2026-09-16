import { http } from '@/api/http'
import type { ApiResponse } from '@/types/api'
import type { GatewayEnvelope } from '@/types/realtime'

export interface RealtimeSnapshot {
  latestPoseBatch: GatewayEnvelope | null
  latestTargetBatch: GatewayEnvelope | null
  latestMissionStatus: GatewayEnvelope | null
}

export async function fetchRealtimeSnapshot() {
  const response = await http.get<ApiResponse<RealtimeSnapshot>>('/gateway/v1/debug/snapshot')
  return response.data.data
}
