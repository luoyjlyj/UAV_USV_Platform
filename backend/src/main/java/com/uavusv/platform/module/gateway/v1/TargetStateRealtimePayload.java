package com.uavusv.platform.module.gateway.v1;

/** World-model target DTO; coordinates are passed through in their source frame. */
public record TargetStateRealtimePayload(
        String id,
        String frameId,
        boolean coordinateValid,
        Vector3 position,
        Pose pose,
        Velocity velocity,
        String sourceStream,
        String timestamp,
        String classification,
        String affiliation,
        double confidence
) {
    public record Vector3(double x, double y, double z) {
    }

    public record Quaternion(double x, double y, double z, double w) {
    }

    public record Pose(Vector3 position, Quaternion orientation) {
    }

    public record Velocity(Vector3 linear, Vector3 angular) {
    }
}
