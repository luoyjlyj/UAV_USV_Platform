from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


RUNNER = Path(__file__).with_name("fake-runner-p0.py")
RUNTIME = "11111111-1111-4111-8111-111111111111"
GENERATION = "22222222-2222-4222-8222-222222222222"


def command(command_id: str, sequence: int, action: str, **overrides):
    value = {
        "protocolVersion": "algorithm.command.v1",
        "commandId": command_id,
        "runtimeRef": RUNTIME,
        "runtimeGeneration": GENERATION,
        "sequence": sequence,
        "action": action,
        "parameters": {},
    }
    value.update(overrides)
    return value


def run(commands):
    payload = "".join(json.dumps(item) + "\n" for item in commands)
    completed = subprocess.run(
        [sys.executable, str(RUNNER)], input=payload, text=True, capture_output=True, check=True
    )
    return [json.loads(line) for line in completed.stdout.splitlines()]


def test_ready_and_four_actions_are_correlatable():
    events = run([
        command("c1", 1, "START"),
        command("c2", 2, "PAUSE"),
        command("c3", 3, "RESUME"),
        command("c4", 4, "STOP"),
    ])
    assert events[0]["event"] == "runtimeReady"
    results = [event for event in events if event["event"] == "commandResult"]
    assert [(item["commandId"], item["status"]) for item in results] == [
        ("c1", "SUCCEEDED"), ("c2", "SUCCEEDED"), ("c3", "SUCCEEDED"), ("c4", "SUCCEEDED")
    ]
    assert [item["runtimeGeneration"] for item in results] == [GENERATION] * 4


def test_duplicate_command_is_replayed_without_second_application():
    events = run([command("c1", 1, "START"), command("c1", 1, "START")])
    results = [event for event in events if event["event"] == "commandResult"]
    assert len(results) == 2
    assert results[0] == results[1]


def test_stale_runtime_and_unsupported_action_are_rejected():
    events = run([
        command("old", 1, "START", runtimeGeneration="33333333-3333-4333-8333-333333333333"),
        command("bad", 1, "RETREAT"),
    ])
    results = [event for event in events if event["event"] == "commandResult"]
    assert [item["errorCode"] for item in results] == ["STALE_RUNTIME", "UNSUPPORTED_CAPABILITY"]


def test_invalid_json_does_not_kill_protocol_process():
    completed = subprocess.run(
        [sys.executable, str(RUNNER)], input="{not-json}\n", text=True, capture_output=True, check=True
    )
    events = [json.loads(line) for line in completed.stdout.splitlines()]
    assert events[-1] == {"event": "protocolError", "errorCode": "INVALID_JSON"}
