"""Seed a second smoke session with a long-open turn + enrolled live state, so
a restart recovery must rebuild the live card and let the provisional quiet
policy fire a real (fixture) stage analysis.
"""
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

import zstandard

from smoke_paths import project_key

REPO_ROOT = Path(__file__).resolve().parents[1]
SMOKE_HOME = REPO_ROOT / ".smoke-home"
WORKSPACE_STORAGE_KEY = project_key(str(REPO_ROOT))
SESSION_ID = "session-smoke0002-0000-0000-0000-000000000002"
CREATED_AT = 1786900000000
NOW_ISO = datetime.now(timezone.utc).isoformat()

# --- session event log (open turn, last meaningful event minutes ago) ---
session_line = {
    "type": "session", "version": 0, "id": SESSION_ID, "createdAt": CREATED_AT,
    "cwd": str(REPO_ROOT), "delegationDepth": 0, "agentPreset": "standard",
}
events = [
    {"type": "turn/start", "seq": 0, "time": CREATED_AT, "data": {"turn": 1}},
    {"type": "step/start", "seq": 1, "time": CREATED_AT + 1, "data": {"turn": 1, "step": 1}},
    {"type": "user/message", "seq": 2, "time": CREATED_AT + 2, "surfaceOp": "append", "data": {"content": [{"type": "text", "text": "smoke 开放 Turn：请持续检查。"}], "source": {"kind": "user"}, "role": "user", "id": "smoke-user-1"}},
    {"type": "tool/call", "seq": 3, "time": CREATED_AT + 3, "data": {"turn": 1, "step": 1, "callId": "smoke-call-1", "name": "smoke_tool", "arguments": "{}"}},
    {"type": "tool/result", "seq": 4, "time": CREATED_AT + 4, "surfaceOp": "append", "data": {"turn": 1, "step": 1, "message": {"source": {"kind": "tool", "callId": "smoke-call-1"}, "content": [{"type": "tool-result", "toolCallId": "smoke-call-1", "content": [{"type": "text", "text": "ok"}]}], "role": "user", "id": "smoke-result-1"}}},
    {"type": "assistant/message", "seq": 5, "time": CREATED_AT + 5, "surfaceOp": "append", "data": {"turn": 1, "step": 1, "message": {"role": "assistant", "content": [{"type": "text", "text": "开放 Turn 中的中间结论：继续推进。"}], "source": {"kind": "model", "provider": "trace-insight-fixture", "model": "fixture-small"}, "id": "smoke-assistant-1"}}},
    {"type": "step/end", "seq": 6, "time": CREATED_AT + 6, "data": {"turn": 1, "step": 1}},
]
session_dir = SMOKE_HOME / "sessions" / WORKSPACE_STORAGE_KEY / SESSION_ID
session_dir.mkdir(parents=True, exist_ok=True)
compressor = zstandard.ZstdCompressor(level=3)
frames = [compressor.compress((json.dumps(line, ensure_ascii=False) + "\n").encode("utf-8")) for line in [session_line, *events]]
(session_dir / "session.jsonl.zstd").write_bytes(b"".join(frames))

# --- workspace registry ---
workspace_path = SMOKE_HOME / "storages" / "workspace.json"
workspace = json.loads(workspace_path.read_text(encoding="utf-8"))
session_ids = workspace["tables"]["workspaces"]["ws-smoke-0001"]["sessionIds"]
workspace["tables"]["workspaces"]["ws-smoke-0001"]["sessionIds"] = list(dict.fromkeys([*session_ids, SESSION_ID]))
workspace_path.write_text(json.dumps(workspace, ensure_ascii=False), encoding="utf-8")

# --- trace-insight history: enrolled + live card for the open turn ---
history = {
    "schemaVersion": 1,
    "revision": 2,
    "timelineRevision": 2,
    "programmaticRevision": 0,
    "sessionId": SESSION_ID,
    "createdAt": NOW_ISO,
    "updatedAt": NOW_ISO,
    "lastObservedSeq": 6,
    "lastClosedSeq": -1,
    "settingsOverride": None,
    "settingsRevision": 0,
    "diagnostics": [],
    "jobs": [],
    "changes": [],
    "changesFloorRevision": 0,
    "annotations": {"revision": 0, "items": []},
    "automatic": {"enrolled": True, "enrolledAt": NOW_ISO, "lastLiveTurnSeq": None},
    "live": {
        "revision": 1,
        "items": [{
            "id": "live-1", "turn": 1, "fromSeq": 0, "observedThroughSeq": 6, "stableThroughSeq": 6,
            "lastMeaningfulAt": datetime.fromtimestamp((CREATED_AT + 6) / 1000, tz=timezone.utc).isoformat(),
            "createdAt": NOW_ISO, "updatedAt": NOW_ISO,
            "state": "open", "analyzerVersion": "0.3.3", "revision": 1, "report": None,
        }],
        "provisional": {"turn": None, "throughSeq": -1, "callsInTurn": 0, "lastDispatchedAt": None, "lastSucceededAt": None},
    },
    "programmatic": {"coveredThroughSeq": -1, "checkpoints": []},
    "semantic": {"coveredThroughSeq": -1, "continuitySummary": "", "primaryRunId": None, "retry": None, "runs": []},
}
history_dir = SMOKE_HOME / "trace-insight" / "sessions"
history_dir.mkdir(parents=True, exist_ok=True)
file_name = hashlib.sha256(SESSION_ID.encode("utf-8")).hexdigest() + ".json"
(history_dir / file_name).write_text(json.dumps(history, ensure_ascii=False, indent=2), encoding="utf-8")
print("seeded open-turn session", file_name)
