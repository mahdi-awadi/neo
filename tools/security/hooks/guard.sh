#!/usr/bin/env bash
# Claude Code PreToolUse hook: keep agents away from secret files. The decision lives in guard.ts
# (tested): a Neo worker is blocked (exit 2), the operator's own session is warned.
exec bun "$(cd "$(dirname "$0")/.." && pwd)/guard.ts"
