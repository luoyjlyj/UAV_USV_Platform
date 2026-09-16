package com.uavusv.platform.module.gateway.v1;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;

class RealtimeHubTargetBatchTests {

    @Test
    void storesAndBroadcastsLatestTargetBatchIndependently() {
        RealtimeWebSocketHandler handler = mock(RealtimeWebSocketHandler.class);
        RealtimeHub hub = new RealtimeHub(handler);
        GatewayEnvelope target = new GatewayEnvelope(
                "1.0", GatewayMessageType.TELEMETRY_TARGET_BATCH, "ros", Instant.now(),
                "run-1", "fleet.targets.epoch-a", 1,
                new ObjectMapper().createObjectNode().putArray("targets").addObject().put("id", "enemy_ship"));

        hub.publish(target);

        assertThat(hub.latestTargetBatch()).contains(target);
        assertThat(hub.latestPoseBatch()).isEmpty();
        assertThat(hub.snapshot().latestTargetBatch()).isEqualTo(target);
        verify(handler).broadcast(target);
    }
}
