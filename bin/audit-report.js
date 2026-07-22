#!/usr/bin/env node
'use strict';
// agent-flight-recorder: read the trails.
//
// Aggregates the per-session JSONL files that audit-log writes into a
// per-day / per-session activity report - the "what did the agents actually
// DO last night" view.
//
// Usage:
//   node bin/audit-report.js                 # all sessions, grouped by day
//   node bin/audit-report.js --today         # only today
//   node bin/audit-report.js --since 2026-07-01
//   node bin/audit-report.js --session a1b2c3d4   # substring match
//   node bin/audit-report.js --files         # list files written/edited per session
//   node bin/audit-report.js --commands      # list shell commands per session
//   node bin/audit-report.js --risky         # only sessions with risky commands
//   node bin/audit-report.js --json          # machine-readable
//
// The compact default answers "which repo, how many calls, what mix, anything
// dangerous" in one line per session; --files/--commands drill in before you
// trust an unattended run's commits.

const fs = require('fs');
const path = require('path');
const os = require('os');

const argv = process.argv.slice(2);
function flag(name) { return argv.includes('--' + name); }
function opt(name) {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : undefined;
}
function dateOpt(name) {
  if (!flag(name)) return undefined;
  const v = opt(name);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v || '')) {
    console.error('audit-report: --' + name + ' requires a YYYY-MM-DD value.');
    process.exit(1);
  }
  return v;
}

const dir = process.env.AFR_AUDIT_DIR
  || path.join(os.homedir(), '.agent-flight-recorder', 'audit');
const asJson = flag('json');
const showFiles = flag('files');
const showCommands = flag('commands');
const riskyOnly = flag('risky');
const sessionOpt = opt('session');
const today = new Date().toISOString().slice(0, 10);
const since = flag('today') ? today : dateOpt('since');

// Commands worth a second look before trusting an unattended run. Coarse on
// purpose: flag for human review, not to block anything.
const RISKY = /\brm\s+-rf?\b|\bgit\s+push\s+.*(-f\b|--force)|\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-[a-z]*f|Remove-Item\s+.*-Recurse|\bgit\s+checkout\s+--\s|--no-verify\b|\bdel\s+\/[sq]/i;
// Tools that modify files (for the "files touched" list).
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

if (!fs.existsSync(dir)) {
  console.log('No audit logs yet (' + dir + ' does not exist).');
  process.exit(0);
}

const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
const sessions = []; // one entry per file (= per session per day)
for (const f of files) {
  const date = f.slice(0, 10); // YYYY-MM-DD prefix
  if (since && date < since) continue;
  const sessionId = f.slice(11).replace(/\.jsonl$/, '');
  if (sessionOpt && !sessionId.includes(sessionOpt)) continue;

  let raw;
  try { raw = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }

  const s = {
    date, session: sessionId, calls: 0, tools: {}, cwds: {},
    filesTouched: new Set(), commands: [], risky: [], agents: new Set(),
    origins: new Set(), first: null, last: null,
  };
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    s.calls++;
    s.tools[e.tool || '?'] = (s.tools[e.tool || '?'] || 0) + 1;
    if (e.cwd) s.cwds[e.cwd] = (s.cwds[e.cwd] || 0) + 1;
    if (e.ts) { if (!s.first) s.first = e.ts; s.last = e.ts; }
    if (e.file && WRITE_TOOLS.has(e.tool)) s.filesTouched.add(e.file);
    if (e.agent_type) s.agents.add(e.agent_type);
    if (e.origin) s.origins.add(e.origin);
    if (e.command) {
      s.commands.push(e.command);
      if (RISKY.test(e.command)) s.risky.push(e.command);
    }
  }
  if (s.calls === 0) continue;
  if (riskyOnly && s.risky.length === 0) continue;
  sessions.push(s);
}

if (sessions.length === 0) {
  console.log('No audit sessions match the filter.');
  process.exit(0);
}

function repoOf(s) {
  // most-frequent cwd -> its basename is "the repo this session worked in"
  const top = Object.entries(s.cwds).sort((a, b) => b[1] - a[1])[0];
  return top ? path.basename(top[0]) : '?';
}
function span(s) {
  if (!s.first || !s.last) return '';
  const hhmm = (iso) => iso.slice(11, 16);
  return hhmm(s.first) + '-' + hhmm(s.last);
}
function toolMix(s, n) {
  return Object.entries(s.tools).sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([t, c]) => t + ':' + c).join(' ');
}

if (asJson) {
  console.log(JSON.stringify({
    dir,
    sessions: sessions.map((s) => ({
      date: s.date, session: s.session, repo: repoOf(s), first: s.first, last: s.last,
      calls: s.calls, tools: s.tools, files: [...s.filesTouched],
      commands: s.commands, risky: s.risky, agents: [...s.agents],
      origins: [...s.origins],
    })),
  }, null, 2));
  process.exit(0);
}

// group by date
const byDate = {};
for (const s of sessions) (byDate[s.date] = byDate[s.date] || []).push(s);

let totalCalls = 0, totalRisky = 0;
for (const date of Object.keys(byDate).sort()) {
  const rows = byDate[date].sort((a, b) => String(a.first).localeCompare(String(b.first)));
  console.log('\n' + date + '  (' + rows.length + (rows.length === 1 ? ' session)' : ' sessions)'));
  for (const s of rows) {
    totalCalls += s.calls; totalRisky += s.risky.length;
    const id = s.session.slice(0, 8);
    const origin = s.origins.size ? '[' + [...s.origins].join(',') + '] ' : '';
    let line = '  ' + id.padEnd(10) + span(s).padEnd(13) + (origin + repoOf(s)).padEnd(20)
      + String(s.calls).padStart(4) + ' calls   ' + toolMix(s, 4);
    if (s.filesTouched.size) line += '   ✎' + s.filesTouched.size;
    if (s.agents.size) line += '   agents:' + [...s.agents].join(',');
    if (s.risky.length) line += '   ⚠' + s.risky.length + ' risky';
    console.log(line);
    const oneLine = (c) => c.replace(/\s*\n\s*/g, ' ⏎ ').slice(0, 160);
    if (showFiles) for (const f of [...s.filesTouched].sort()) console.log('      ✎ ' + f);
    if (showCommands) for (const c of s.commands) console.log('      $ ' + oneLine(c));
    if (!showCommands && s.risky.length) {
      for (const c of s.risky) console.log('      ⚠ ' + oneLine(c));
    }
  }
}

console.log('\nΣ ' + sessions.length + (sessions.length === 1 ? ' session · ' : ' sessions · ')
  + totalCalls + ' tool calls'
  + (totalRisky
    ? ' · ⚠ ' + totalRisky + (totalRisky === 1 ? ' risky command' : ' risky commands')
    : ' · no risky commands'));
