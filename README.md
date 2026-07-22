# agent-flight-recorder

[![test](https://github.com/NiceLeader/agent-flight-recorder/actions/workflows/test.yml/badge.svg)](https://github.com/NiceLeader/agent-flight-recorder/actions/workflows/test.yml)

**A flight recorder for coding agents. One JSONL line per tool call, local-only, zero tokens - readable by you, never hidden from you.**

Coding agents get full filesystem and shell access. Most of us have no durable record of what they actually did - which files a subagent touched at 3am, what ran right before a bad commit, whether an unattended run quietly used `--force`. And as the ecosystem just learned, the telemetry that *does* exist isn't always telemetry you can read.

This project is the opposite idea: **the audit trail belongs on your disk, in plain text, in your favor.**

```
2026-07-21  (3 sessions)
  a1b2c3d4  09:12-11:48  my-api               214 calls   Bash:96 Edit:58 Read:41 Grep:12   ✎23
  9f8e7d6c  10:05-10:22  [codex] my-api        41 calls   Bash:30 Read:11                   ⚠1 risky
      ⚠ git push --force origin feature/retry
  5a4b3c2d  22:30-23:59  webapp               133 calls   Read:70 Edit:33 Bash:24 Write:6   ✎11  agents:code-reviewer

Σ 3 sessions · 388 tool calls · ⚠ 1 risky commands
```

## What it is

- **Recorder** (`hooks/audit-log.js`) - a PostToolUse hook that appends one JSON line per tool call to `~/.agent-flight-recorder/audit/YYYY-MM-DD-<session>.jsonl`.
- **Reader** (`bin/audit-report.js`) - turns the trails into a per-day / per-session report: which repo, how many calls, what tool mix, which files were written, and which commands deserve a second look before you trust an unattended run.

## What it records - and what it never records

| Logged (clipped to 500 chars) | Never logged |
|---|---|
| timestamp, session id, cwd | file **contents** |
| tool name (Bash, Edit, Read...) | `content` of writes |
| file **path** for file tools | `old_string` / `new_string` of edits |
| shell command text | model responses |
| search pattern, URL, subagent prompt/description | anything sent over the network - there is no network |
| subagent id/type, invoked skill name | |

The field list is a **whitelist**, not a blacklist: only named metadata fields are ever copied. The flight recorder must never become a second copy of your codebase or your secrets - and the test suite pins that promise (`npm test`, including a "content never appears in the log" test).

## Quickstart

### Claude Code

Install as a plugin, or wire the hook directly into `settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node \"/path/to/agent-flight-recorder/hooks/audit-log.js\"",
            "timeout": 10,
            "async": true
          }
        ]
      }
    ]
  }
}
```

`"async": true` matters: the recorder is a pure observer, so Claude Code fires it and moves on - **zero added latency on your tool calls** and zero tokens in your context window. (On older Claude Code versions that predate async hooks the flag is ignored and the hook runs sync - still fail-open, still just one short-lived `node` spawn.)

### Codex CLI (or any hooks-speaking runtime)

Codex hooks speak the same stdin-JSON contract (`tool_name`, `tool_input`, `cwd`, `session_id`). Point a PostToolUse hook at the same script and tag the runtime:

```
node /path/to/agent-flight-recorder/hooks/audit-log.js origin=codex
```

Both agents now write to **one trail**, and every entry carries its origin. The report shows it inline: `[codex] my-api`.

## Reading the trail

```bash
node bin/audit-report.js                  # all sessions, grouped by day
node bin/audit-report.js --today
node bin/audit-report.js --since 2026-07-01
node bin/audit-report.js --risky          # only sessions that ran something spicy
node bin/audit-report.js --files          # every file written, per session
node bin/audit-report.js --commands       # every shell command, per session
node bin/audit-report.js --json           # machine-readable, pipe it anywhere
```

"Risky" is a deliberately coarse regex (`rm -rf`, force-push, `reset --hard`, `checkout --`, `--no-verify`, recursive deletes) meant to flag lines for **human review** - the recorder never blocks anything.

## Design principles

1. **Zero tokens.** The hook returns nothing to the model. Your context window never pays for observability.
2. **Zero blocking.** Async observer + fail-open: a full disk or malformed payload exits 0 and the tool call proceeds. An audit tool that can break your agent is worse than no audit tool.
3. **Local-only, forever.** No endpoints, no collector, no SDK. `grep` is the query language.
4. **Cross-agent by design.** One trail for every runtime that can pipe JSON to a script - because "which agent did this" is the first question you ask when something looks wrong.
5. **Metadata, not content.** Paths tell the story; contents are the risk. Whitelisted fields only, clipped at 500 chars.

## FAQ

**Doesn't Claude Code already have OpenTelemetry?** Yes - for aggregate *metrics*. This is the complementary forensic layer: a per-tool-call, per-session, greppable record on your own disk, with no collector to run, that also covers your other agents.

**Doesn't Claude Code already save full session transcripts?** It does (`~/.claude/projects/*.jsonl`) - and that's exactly why this exists. Transcripts are per-agent, huge, and contain the *full content* of everything: file contents, model output, your prompts. That makes them the wrong artifact to grep casually, retain long-term, or hand to a review process - the transcript itself is a privacy liability. The flight recorder is the deliberately lossy view: metadata-only, content-free, one line per action, one trail across every agent you run. Transcripts answer "replay this session"; the trail answers "what did my agents do this month, and was any of it dangerous" - without keeping a second copy of your codebase around.

**Performance cost?** One `node` spawn per tool call, off the critical path (`async: true`). The write itself is an append of a single line.

**Can I log to a different location?** `AFR_AUDIT_DIR=/path/to/trails`.

**Why JSONL and not a database?** Trails are append-only, tiny, and self-partitioned by day+session. `jq`, `grep`, and `audit-report` cover the query patterns; your text editor covers the rest.

## License

MIT © Maciej Lewandowski
