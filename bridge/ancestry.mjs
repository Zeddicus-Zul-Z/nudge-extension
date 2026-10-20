// Orphan detection for Windows watchers.
//
// POSIX re-parents an orphan to pid 1, so the watcher's `ppid === 1` check is
// enough there. Windows never re-parents: a dead parent's pid simply stays in
// the child's record. Worse, the command reaches node through shims —
// agent → shell → cmd.exe (groundworks-nudge.cmd) → node — and every shim
// waits for its child, so the direct parent outlives the agent. Without this
// a watcher whose agent died kept heartbeating and the toolbar stayed green
// for a session that no longer existed (2026-10-19, first Windows port).
//
// So on Windows the watcher records its ancestor chain once at startup — the
// shims plus the first process that is not one (the agent) — and exits when
// any of them is gone.
import { execFile } from 'node:child_process'

// processes that only relay to a child and wait for it
const SHIMS = new Set(['cmd.exe', 'bash.exe', 'sh.exe', 'powershell.exe', 'pwsh.exe'])
// never worth tracking: their death is not the agent's
const ROOTS = new Set(['explorer.exe', 'services.exe', 'svchost.exe', 'wininit.exe', 'winlogon.exe', 'system'])
const MAX_DEPTH = 6

/**
 * Parse `pid|ppid|name|created` lines (self first, then each parent) into the
 * ancestors worth watching. A parent created AFTER its child is a recycled
 * pid of a long-dead parent, not the real one — the chain stops there.
 */
export function parseAncestry(text, depth = MAX_DEPTH) {
  const rows = String(text || '').split(/\r?\n/).map((line) => {
    const [pid, ppid, name, created] = line.trim().split('|')
    return { pid: Number(pid), ppid: Number(ppid), name: String(name || '').toLowerCase(), created: Number(created) }
  }).filter((r) => Number.isFinite(r.pid) && r.pid > 0)
  const out = []
  for (let i = 1; i < rows.length && out.length < depth; i++) {
    const child = rows[i - 1], parent = rows[i]
    if (parent.pid !== child.ppid) break
    if (Number.isFinite(parent.created) && Number.isFinite(child.created) && parent.created > child.created) break
    if (ROOTS.has(parent.name)) break
    out.push({ pid: parent.pid, name: parent.name })
    if (!SHIMS.has(parent.name)) break // the first real process is the agent; above it is not our business
  }
  return out
}

const SCRIPT = (pid) => [
  "$ErrorActionPreference='SilentlyContinue'",
  `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}'`,
  `for($i=0;$i -le ${MAX_DEPTH} -and $p;$i++){`,
  "  \"$($p.ProcessId)|$($p.ParentProcessId)|$($p.Name)|$($p.CreationDate.ToFileTimeUtc())\"",
  "  $p=Get-CimInstance Win32_Process -Filter \"ProcessId=$($p.ParentProcessId)\"",
  '}',
].join('\n')

/** Ancestors of `pid` worth watching; [] when the query fails (caller falls back to ppid). */
export function windowsAncestors(pid = process.pid) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT(pid)], {
      windowsHide: true, timeout: 15_000, encoding: 'utf8',
    }, (error, stdout) => resolve(error ? [] : parseAncestry(stdout)))
  })
}

/** Signal 0 probes existence; EPERM means it exists but is not ours to signal. */
export function isAlive(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}
