package com.uavusv.platform.module.gateway.v1;

import java.util.List;

/** Realtime DTO kept separate from vehicle/runtime device models. */
public record TargetBatchRealtimePayload(
        String snapshotTime,
        String frameId,
        List<TargetStateRealtimePayload> targets
) {
}
