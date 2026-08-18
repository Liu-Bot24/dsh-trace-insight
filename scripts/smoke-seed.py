"""Seed the isolated smoke DSH home with a workspace + blank session."""
import json
import sys
from pathlib import Path

import zstandard

from smoke_paths import project_key

REPO_ROOT = Path(__file__).resolve().parents[1]
SMOKE_HOME = REPO_ROOT / ".smoke-home"
WORKSPACE_STORAGE_KEY = project_key(str(REPO_ROOT))

workspace = {
    "unit": {"name": "workspace", "version": 2},
    "global": {"initialized": True, "workspaceIds": ["ws-smoke-0001"], "archivedSessionIds": []},
    "tables": {
        "workspaces": {
            "ws-smoke-0001": {
                "path": str(REPO_ROOT),
                "title": "smoke",
                "sessionIds": ["session-smoke0001-0000-0000-0000-000000000001"],
                "createdAt": "2026-08-16T09:00:00.000Z",
                "updatedAt": "2026-08-16T09:00:00.000Z",
            }
        }
    },
}
(SMOKE_HOME / "storages").mkdir(parents=True, exist_ok=True)
(SMOKE_HOME / "storages" / "workspace.json").write_text(json.dumps(workspace, ensure_ascii=False), encoding="utf-8")

session_dir = SMOKE_HOME / "sessions" / WORKSPACE_STORAGE_KEY / "session-smoke0001-0000-0000-0000-000000000001"
session_dir.mkdir(parents=True, exist_ok=True)
session_line = {
    "type": "session",
    "version": 0,
    "id": "session-smoke0001-0000-0000-0000-000000000001",
    "createdAt": 1786900000000,
    "cwd": str(REPO_ROOT),
    "delegationDepth": 0,
    "agentPreset": "standard",
}
payload = (json.dumps(session_line, ensure_ascii=False) + "\n").encode("utf-8")
compressed = zstandard.ZstdCompressor(level=3).compress(payload)
(session_dir / "session.jsonl.zstd").write_bytes(compressed)

# Trace insight global settings: fixture route + fast provisional policy so the
# open-turn stage analysis fires during the smoke turn.
settings = {
    "schemaVersion": 1,
    "revision": 0,
    "updatedAt": None,
    "settings": {
        "defaultRoute": {"provider": "trace-insight-fixture", "model": "fixture-strong"},
        "auto": {
            "enabled": True,
            "everyTurns": 4,
            "maxPendingEvents": 160,
            "maxInputChars": 22000,
            "quietPeriodMs": 90000,
            "provisional": {
                "enabled": True,
                "failureThreshold": 2,
                "noProgressSteps": 3,
                "meaningfulEvents": 2,
                "compressedChars": 2000,
                "maxAgeMs": 300000,
                "quietMs": 15000,
                "cooldownMs": 30000,
                "maxCallsPerTurn": 8,
            },
        },
    },
}
settings_dir = SMOKE_HOME / "trace-insight"
settings_dir.mkdir(parents=True, exist_ok=True)
(settings_dir / "settings.json").write_text(json.dumps(settings, ensure_ascii=False), encoding="utf-8")
(settings_dir / "sessions").mkdir(parents=True, exist_ok=True)
print("seeded")
