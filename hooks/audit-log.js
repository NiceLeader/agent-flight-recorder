#!/usr/bin/env node
'use strict';
// agent-flight-recorder: zero-token audit log for coding agents.
//
// PostToolUse observer. Appends one JSONL line per tool call to a per-session
// file under ~/.agent-flight-recorder/audit/ (override with AFR_AUDIT_DIR).
// Logs METADATA ONLY - tool name, file path, command, agent id - never file
// contents. Pure observer: returns nothing to the model (zero context cost)
// and a failure never blocks the tool (fail-open, always exit 0).
//
// Cross-agent: any runtime that speaks the hooks stdin-JSON contract
// (tool_name / tool_input / cwd / session_id) can write to the same trail.
// Tag the runtime via argv: `node audit-log.js origin=codex`.

const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_FIELD = 500;   // clip long values - the log must stay skimmable
const MAX_STDIN = 1024 * 1024;

function clip(v) {
  const s = String(v);
  return s.length > MAX_FIELD ? s.slice(0, MAX_FIELD) + '...[clipped]' : s;
}

// Whitelist, not blacklist: only these tool_input fields are ever logged.
// `content` / `new_string` / `old_string` are deliberately absent - the
// flight recorder must never become a copy of your files.
function summarize(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return {};
  const s = {};
  if (toolInput.file_path) s.file = clip(toolInput.file_path);
  if (toolInput.command) s.command = clip(toolInput.command);
  if (toolInput.pattern) s.pattern = clip(toolInput.pattern);
  if (toolInput.url) s.url = clip(toolInput.url);
  if (toolInput.prompt) s.prompt = clip(toolInput.prompt);
  if (toolInput.description) s.description = clip(toolInput.description);
  if (toolInput.skill) s.skill = clip(toolInput.skill);
  return s;
}

function record(input, origin) {
  const dir = process.env.AFR_AUDIT_DIR
    || path.join(os.homedir(), '.agent-flight-recorder', 'audit');
  fs.mkdirSync(dir, { recursive: true });

  const session = String(input.session_id || 'unknown')
    .replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'unknown';
  const now = new Date();
  const file = path.join(dir, now.toISOString().slice(0, 10) + '-' + session + '.jsonl');

  const entry = {
    ts: now.toISOString(),
    session: session,
    cwd: input.cwd || process.cwd(),
    tool: input.tool_name || 'unknown',
  };
  if (input.agent_id) entry.agent = clip(input.agent_id);
  if (input.agent_type) entry.agent_type = clip(input.agent_type);
  if (origin) entry.origin = clip(origin);
  Object.assign(entry, summarize(input.tool_input));

  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
}

function main() {
  const originArg = (process.argv[2] || '').match(/^origin=([A-Za-z0-9_-]{1,32})$/);
  const origin = originArg ? originArg[1] : (process.env.AFR_ORIGIN || '');

  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    if (raw.length < MAX_STDIN) raw += c;
  });
  process.stdin.on('end', () => {
    try {
      record(JSON.parse(raw), origin);
    } catch {
      // fail-open: a broken payload or unwritable disk must never block a tool
    }
    process.exit(0);
  });
  // If the runtime never closes stdin, don't hang the hook slot forever.
  setTimeout(() => process.exit(0), 5000).unref();
}

if (require.main === module) main();
module.exports = { summarize, record, clip };
