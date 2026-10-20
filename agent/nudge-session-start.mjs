// SessionStart hook for Windows (USER-LEVEL: runs in every project) — the
// portable twin of nudge-session-start.sh, which needs bash, lsof and nohup.
// It does EXACTLY ONE thing: ensure the bridge is up. It prints NOTHING — a
// session learns about Nudge only when the user invokes groundworks-nudge
// (the opt-in fence; hook stdout would become session context).
//
// Usage (written by setup-agent.mjs): node nudge-session-start.mjs <bridge.mjs>
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const PORT = Number(process.env.NUDGE_PORT || 4700)
const BRIDGE = process.argv[2]

const listening = () => new Promise((resolve) => {
  const s = net.createConnection({ port: PORT, host: '127.0.0.1' })
  const done = (v) => { clearTimeout(t); s.destroy(); resolve(v) }
  const t = setTimeout(() => done(false), 500)
  s.once('connect', () => done(true))
  s.once('error', () => done(false))
})

try {
  if (BRIDGE && fs.existsSync(BRIDGE) && !await listening()) {
    const log = fs.openSync(path.join(os.tmpdir(), 'nudge-bridge.log'), 'a')
    // detached + windowsHide: survives this hook and never opens a console window
    spawn(process.execPath, [BRIDGE], { detached: true, stdio: ['ignore', log, log], windowsHide: true }).unref()
  }
} catch { /* a hook must never break the session */ }
process.exit(0)
