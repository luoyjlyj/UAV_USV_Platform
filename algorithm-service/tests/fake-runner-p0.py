"""Deterministic NDJSON substitute for the P0 Java-Python protocol.

This is a test double, not a second implementation of the production runner.
It deliberately models protocol identity, deduplication and terminal states.
"""
from __future__ import annotations

import json
import sys
from dataclasses import dataclass, field


CAPABILITIES = ("START", "PAUSE", "RESUME", "STOP", "CANCEL")
TERMINAL = {"STOPPED", "CANCELLED", "FAILED"}


@dataclass
class FakeRuntime:
    runtime_ref: str
    generation: str
    state: str = "PREPARED"
    applied: int = 0
    results: dict[str, dict] = field(default_factory=dict)

    def event(self, payload: dict) -> None:
        print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), flush=True)

    def reject(self, command: dict, code: str, message: str) -> None:
        self.event({
            "event": "commandResult",
            "protocolVersion": "algorithm.command.v1",
            "commandId": command.get("commandId"),
            "runtimeRef": command.get("runtimeRef"),
            "runtimeGeneration": command.get("runtimeGeneration"),
            "sequence": command.get("sequence"),
            "action": command.get("action"),
            "status": "REJECTED",
            "errorCode": code,
            "message": message,
            "affectedObjects": [],
        })

    def handle(self, command: dict) -> None:
        cid = command.get("commandId")
        if cid in self.results:
            self.event(self.results[cid])
            return
        if command.get("protocolVersion") != "algorithm.command.v1":
            self.reject(command, "UNSUPPORTED_PROTOCOL", "unsupported protocol")
            return
        if command.get("runtimeRef") != self.runtime_ref or command.get("runtimeGeneration") != self.generation:
            self.reject(command, "STALE_RUNTIME", "runtime identity does not match")
            return
        action = str(command.get("action", "")).upper()
        if action not in CAPABILITIES:
            self.reject(command, "UNSUPPORTED_CAPABILITY", "action is not supported")
            return
        if action == "START" and self.state != "PREPARED":
            self.reject(command, "INVALID_STATE", "START requires PREPARED")
            return
        if action == "PAUSE" and self.state != "RUNNING":
            self.reject(command, "INVALID_STATE", "PAUSE requires RUNNING")
            return
        if action == "RESUME" and self.state != "PAUSED":
            self.reject(command, "INVALID_STATE", "RESUME requires PAUSED")
            return
        if action in {"STOP", "CANCEL"} and self.state in TERMINAL:
            self.reject(command, "INVALID_STATE", "runtime is terminal")
            return
        self.state = {"START": "RUNNING", "PAUSE": "PAUSED", "RESUME": "RUNNING", "STOP": "STOPPED", "CANCEL": "CANCELLED"}[action]
        self.applied += 1
        result = {
            "event": "commandResult",
            "protocolVersion": "algorithm.command.v1",
            "commandId": cid,
            "runtimeRef": self.runtime_ref,
            "runtimeGeneration": self.generation,
            "sequence": command.get("sequence"),
            "action": action,
            "status": "SUCCEEDED",
            "errorCode": None,
            "message": "fake runtime applied action",
            "affectedObjects": [],
            "state": self.state,
        }
        self.results[cid] = result
        self.event(result)


def main() -> int:
    runtime = FakeRuntime(
        runtime_ref="11111111-1111-4111-8111-111111111111",
        generation="22222222-2222-4222-8222-222222222222",
    )
    runtime.event({
        "event": "runtimeReady",
        "protocolVersion": "algorithm.command.v1",
        "runtimeRef": runtime.runtime_ref,
        "runtimeGeneration": runtime.generation,
        "state": runtime.state,
        "capabilities": list(CAPABILITIES),
    })
    for line in sys.stdin:
        try:
            command = json.loads(line)
        except json.JSONDecodeError:
            runtime.event({"event": "protocolError", "errorCode": "INVALID_JSON"})
            continue
        runtime.handle(command)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
