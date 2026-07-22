'use strict';
// agent-flight-recorder test suite. Run: node test/test.js
// Every test spawns the real hook binary with a real stdin payload - the same
// contract Claude Code / Codex use - and asserts on the JSONL it writes.

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK = path.join(__dirname, '..', 'hooks', 'audit-log.js');
const REPORT = path.join(__dirname, '..', 'bin', 'audit-report.js');

let pass = 0, fail = 0;
const failures = [];
const tmpDirs = [];

function ok(name, cond, msg) {
  if (cond) { pass++; }
  else { fail++; failures.push(name + (msg ? ' - ' + msg : '')); }
}

function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'afr-test-'));
  tmpDirs.push(d);
  return d;
}

function runHook(payload, { args = [], env = {} } = {}) {
  return execFileSync(process.execPath, [HOOK, ...args], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8', timeout: 15000,
    env: { ...process.env, ...env },
  });
}

function readEntries(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  const entries = [];
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (line.trim()) entries.push(JSON.parse(line));
    }
  }
  return entries;
}

// --- basic entry ------------------------------------------------------------
{
  const dir = tmp();
  runHook({
    session_id: 'sess-basic', cwd: '/repo/example', tool_name: 'Bash',
    tool_input: { command: 'ls -la', description: 'List files' },
  }, { env: { AFR_AUDIT_DIR: dir } });
  const e = readEntries(dir);
  ok('writes one JSONL entry', e.length === 1);
  ok('entry has tool + command + description',
    e[0] && e[0].tool === 'Bash' && e[0].command === 'ls -la' && e[0].description === 'List files');
  ok('entry has ts + session + cwd',
    e[0] && !!e[0].ts && e[0].session === 'sess-basic' && e[0].cwd === '/repo/example');
}

// --- the core promise: file contents are NEVER logged ----------------------
{
  const dir = tmp();
  runHook({
    session_id: 'sess-content', cwd: '/repo', tool_name: 'Write',
    tool_input: {
      file_path: '/repo/secrets.env',
      content: 'API_KEY=super-secret-value-should-never-appear',
    },
  }, { env: { AFR_AUDIT_DIR: dir } });
  const raw = fs.readFileSync(
    path.join(dir, fs.readdirSync(dir)[0]), 'utf8');
  ok('file path is logged', raw.includes('secrets.env'));
  ok('file CONTENT is never logged', !raw.includes('super-secret-value'));
}
{
  const dir = tmp();
  runHook({
    session_id: 'sess-edit', cwd: '/repo', tool_name: 'Edit',
    tool_input: {
      file_path: '/repo/a.js',
      old_string: 'OLD_SENTINEL_NEVER_LOGGED', new_string: 'NEW_SENTINEL_NEVER_LOGGED',
    },
  }, { env: { AFR_AUDIT_DIR: dir } });
  const raw = fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8');
  ok('old_string/new_string are never logged',
    !raw.includes('OLD_SENTINEL_NEVER_LOGGED') && !raw.includes('NEW_SENTINEL_NEVER_LOGGED'));
}

// --- clipping ---------------------------------------------------------------
{
  const dir = tmp();
  runHook({
    session_id: 'sess-clip', tool_name: 'Bash',
    tool_input: { command: 'x'.repeat(2000) },
  }, { env: { AFR_AUDIT_DIR: dir } });
  const e = readEntries(dir)[0];
  ok('long fields are clipped to 500 + marker',
    e && e.command.length < 600 && e.command.endsWith('...[clipped]'));
}

// --- cross-agent origin tag -------------------------------------------------
{
  const dir = tmp();
  runHook({
    session_id: 'sess-codex', cwd: '/repo', tool_name: 'Bash',
    tool_input: { command: 'git status' },
  }, { args: ['origin=codex'], env: { AFR_AUDIT_DIR: dir } });
  const e = readEntries(dir)[0];
  ok('origin=codex argv tags the entry', e && e.origin === 'codex');
}
{
  const dir = tmp();
  runHook({ session_id: 'sess-injection', tool_name: 'Bash', tool_input: {} },
    { args: ['origin=evil;rm -rf /'], env: { AFR_AUDIT_DIR: dir } });
  const e = readEntries(dir)[0];
  ok('malformed origin argv is rejected (no origin field)', e && !('origin' in e));
}

// --- fail-open --------------------------------------------------------------
{
  const dir = tmp();
  let code = 0;
  try {
    runHook('this is not json{{{', { env: { AFR_AUDIT_DIR: dir } });
  } catch (err) { code = err.status; }
  ok('malformed stdin exits 0 (never blocks the tool)', code === 0);
  ok('malformed stdin writes nothing', readEntries(dir).length === 0);
}
{
  const dir = tmp();
  const weird = { session_id: '../../etc/passwd', tool_name: 'Read', tool_input: { file_path: 'x' } };
  runHook(weird, { env: { AFR_AUDIT_DIR: dir } });
  const files = fs.readdirSync(dir);
  ok('session id is sanitized in the filename',
    files.length === 1 && !files[0].includes('..') && !files[0].includes('/'));
}

// --- report -----------------------------------------------------------------
{
  const dir = tmp();
  for (const [tool, ti] of [
    ['Bash', { command: 'npm test' }],
    ['Bash', { command: 'git push --force origin main' }],
    ['Edit', { file_path: '/repo/src/index.js' }],
    ['Read', { file_path: '/repo/README.md' }],
  ]) {
    runHook({ session_id: 'sess-report', cwd: '/repo/myproject', tool_name: tool, tool_input: ti },
      { env: { AFR_AUDIT_DIR: dir } });
  }
  const out = execFileSync(process.execPath, [REPORT, '--json'], {
    encoding: 'utf8', env: { ...process.env, AFR_AUDIT_DIR: dir },
  });
  const rep = JSON.parse(out);
  const s = rep.sessions[0];
  ok('report aggregates calls', s && s.calls === 4);
  ok('report resolves the repo from cwd', s && s.repo === 'myproject');
  ok('report lists files touched by write tools only',
    s && s.files.length === 1 && s.files[0] === '/repo/src/index.js');
  ok('report flags risky commands', s && s.risky.length === 1 && /--force/.test(s.risky[0]));
}

// --- cleanup + verdict ------------------------------------------------------
for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
console.log(pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('\nFAILURES:'); for (const f of failures) console.log('  ✗ ' + f); }
process.exit(fail ? 1 : 0);
