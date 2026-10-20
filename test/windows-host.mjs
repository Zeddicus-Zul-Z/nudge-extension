// Suite R — Windows install and lifecycle, no browser. Everything runs from a
// throwaway copy of the checkout under a path WITH SPACES, a throwaway home and
// store, and side ports 4861-4863. The registry is never written (--dry-run);
// Chrome's launch of the host is emulated exactly: `cmd.exe /d /s /c` on the
// generated wrapper, hidden, stdio as the native messaging pipe.
//
// R1 install writes wrapper + manifest; reinstall is byte-identical; id checks
// R2 Chrome-style launch: framed reply, bridge started detached on the side port
// R3 a ping is answered on the same pipe, nothing else is on stdout
// R4 the host exits when Chrome closes the pipe; the bridge lives on
// R5 the detached bridge has no console (no conhost child = no window)
// R6 bridge killed -> the next launch revives it
// R7 Git Bash (Claude Code's shell) and PowerShell (Codex) arm a watcher through
//    the installed launcher; a real nudge reaches it, context + resolve work
// R8 the watcher exits when its agent's shell dies (Windows has no re-parenting)
// R9 the SessionStart hook starts one hidden bridge, silently, and only once
// R10 uninstall removes wrapper, manifest and both registry keys (planned)
// R11 install.cmd runs all three steps from anywhere; --uninstall reverses them
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deriveExtensionId } from '../bridge/extension-id.mjs'

if (process.platform !== 'win32') { console.log('SKIP Suite R: Windows only'); process.exit(0) }

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..')
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'nudge win '))
const ROOT = path.join(SCRATCH, 'Nudge Checkout')
const HOME_DIR = path.join(SCRATCH, 'Test User')
const PROJECT = path.join(SCRATCH, 'target app') // the project an agent would change
const STORE = path.join(SCRATCH, 'store')
const [HOST_PORT, HOOK_PORT] = [4861, 4862]
const BIN = path.join(HOME_DIR, '.local', 'bin')
const ENV = { ...process.env, HOME: HOME_DIR, USERPROFILE: HOME_DIR, NUDGE_STORE: STORE, NUDGE_NO_RELOAD: '1', PATH: `${BIN}${path.delimiter}${process.env.PATH}` }
delete ENV.CLAUDE_CODE_SESSION_ID; delete ENV.CODEX_THREAD_ID; delete ENV.CODEX_SESSION_ID; delete ENV.NUDGE_AGENT_ID
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pass = (m) => console.log(`PASS ${m}`)
const owned = { pids: new Set(), children: [] } // only what this suite started
class Fail extends Error {}
const fail = (m) => { throw new Fail(m) }
const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
async function until(test, ms, what) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { try { const v = await test(); if (v) return v } catch { /* retry */ } await sleep(150) }
  fail(`timeout: ${what}`)
}
const identity = async (port) => (await fetch(`http://127.0.0.1:${port}/.identity`, { signal: AbortSignal.timeout(1000) })).json()
const up = async (port) => { try { return await identity(port) } catch { return null } }
const consoleChildren = (pid) => Number(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  `@(Get-CimInstance Win32_Process -Filter "ParentProcessId=${Number(pid)} AND Name='conhost.exe'").Count`],
{ encoding: 'utf8', windowsHide: true }).trim())

// ---------- a copy of the checkout under a path with spaces ----------
for (const dir of ['agent', 'bridge', 'extension']) {
  fs.cpSync(path.join(REPO, dir), path.join(ROOT, dir), {
    recursive: true,
    filter: (src) => !/native-host-wrapper\.|dev\.groundworks\.nudge\.json$/.test(path.basename(src)),
  })
}
fs.copyFileSync(path.join(REPO, 'install.cmd'), path.join(ROOT, 'install.cmd'))
fs.mkdirSync(PROJECT, { recursive: true })
const INSTALL = path.join(ROOT, 'bridge', 'install-native-host.mjs')
const WRAPPER = path.join(ROOT, 'bridge', 'native-host-wrapper.cmd')
const MANIFEST = path.join(ROOT, 'bridge', 'dev.groundworks.nudge.json')
const install = (...args) => execFileSync(process.execPath, [INSTALL, '--dry-run', ...args], { env: ENV, encoding: 'utf8', windowsHide: true })
const setupUninstall = () => execFileSync(process.execPath, [path.join(ROOT, 'agent', 'setup-agent.mjs'), '--uninstall'], { env: ENV, encoding: 'utf8', windowsHide: true })

// Chrome's own launch: cmd.exe /d /s /c ""<host path>" <origin> --parent-window=0", hidden
function launchHost(port) {
  const id = deriveExtensionId(fs.realpathSync.native(path.join(ROOT, 'extension')))
  const child = spawn('cmd.exe', ['/d', '/s', '/c', `""${WRAPPER}" chrome-extension://${id}/ --parent-window=0"`], {
    env: { ...ENV, NUDGE_PORT: String(port) }, windowsVerbatimArguments: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  })
  owned.children.push(child)
  let buf = Buffer.alloc(0)
  const messages = []
  child.stdout.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk])
    while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
      const len = buf.readUInt32LE(0)
      messages.push(JSON.parse(buf.subarray(4, 4 + len).toString('utf8'))) // throws on a corrupted frame
      buf = buf.subarray(4 + len)
    }
  })
  const send = (obj) => { const body = Buffer.from(JSON.stringify(obj)); const head = Buffer.alloc(4); head.writeUInt32LE(body.length); child.stdin.write(Buffer.concat([head, body])) }
  return { child, messages, send, leftover: () => buf.length }
}

// a watcher armed the way an agent does it: a shell runs the installed command
function armIn(shell, label, wake, idEnv) {
  const command = `groundworks-nudge watch --label "${label}" --wake ${wake}`
  const argv = shell === 'bash' ? ['bash', ['-c', command]] : ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]]
  const child = spawn(argv[0], argv[1], { cwd: PROJECT, env: { ...ENV, NUDGE_PORT: String(HOST_PORT), ...idEnv }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  owned.children.push(child)
  let out = ''
  child.stdout.on('data', (c) => { out += c })
  child.stderr.on('data', (c) => { out += c })
  return { child, output: () => out }
}
const cli = (shell, args, idEnv = {}) => {
  const env = { ...ENV, NUDGE_PORT: String(HOST_PORT), ...idEnv }
  const command = `groundworks-nudge ${args}`
  return shell === 'bash'
    ? execFileSync('bash', ['-c', command], { cwd: PROJECT, env, encoding: 'utf8', windowsHide: true })
    : execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { cwd: PROJECT, env, encoding: 'utf8', windowsHide: true })
}

try {
  // ---------- R1 install ----------
  const first = install()
  const wrapperText = fs.readFileSync(WRAPPER, 'utf8')
  if (!wrapperText.startsWith('@echo off\r\n')) fail('R1: wrapper must start with @echo off (CRLF) — an echo would corrupt the native messaging stream')
  if (!wrapperText.includes(`"${process.execPath}"`) || !wrapperText.includes(`"${path.join(ROOT, 'bridge', 'native-host.mjs')}"`)) fail('R1: wrapper does not pin node and the quoted launcher path')
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
  const id = deriveExtensionId(fs.realpathSync.native(path.join(ROOT, 'extension')))
  if (manifest.path !== WRAPPER || manifest.name !== 'dev.groundworks.nudge' || manifest.type !== 'stdio') fail(`R1: manifest wrong: ${JSON.stringify(manifest)}`)
  if (JSON.stringify(manifest.allowed_origins) !== JSON.stringify([`chrome-extension://${id}/`])) fail('R1: manifest origin is not the derived extension id')
  for (const browser of ['Google\\Chrome', 'Chromium']) {
    const planned = `reg add HKCU\\Software\\${browser}\\NativeMessagingHosts\\dev.groundworks.nudge /ve /t REG_SZ /d ${MANIFEST} /f`
    if (!first.includes(planned)) fail(`R1: registry plan for ${browser} missing:\n${first}`)
  }
  const second = install()
  if (fs.readFileSync(WRAPPER, 'utf8') !== wrapperText || second !== first) fail('R1: reinstall is not identical')
  install('abcdefghijklmnopabcdefghijklmnop')
  if (!fs.readFileSync(MANIFEST, 'utf8').includes('chrome-extension://abcdefghijklmnopabcdefghijklmnop/')) fail('R1: an explicit extension id was ignored')
  let refused = false
  try { install('not-an-id') } catch (e) { refused = e.status === 2 }
  if (!refused) fail('R1: an invalid extension id was accepted')
  install()
  pass('R1 install writes the wrapper and manifest (path with spaces), plans both registry keys, reinstall is identical, ids are checked')

  // ---------- R2 Chrome-style launch ----------
  if (await up(HOST_PORT)) fail(`side port ${HOST_PORT} is busy — stop whatever runs there first`)
  const host = launchHost(HOST_PORT)
  await until(() => host.messages.length >= 1, 8000, 'first native messaging reply')
  if (JSON.stringify(host.messages[0]) !== JSON.stringify({ ok: true, bridge: 'started', port: HOST_PORT })) fail(`R2: reply ${JSON.stringify(host.messages[0])}`)
  const bridge1 = await until(async () => { const i = await up(HOST_PORT); return i?.store === STORE && i }, 8000, 'bridge on the side port')
  owned.pids.add(bridge1.pid)
  pass(`R2 Chrome-style launch through cmd.exe: framed reply, bridge started detached (pid ${bridge1.pid})`)

  // ---------- R3 ping ----------
  host.send({ type: 'ping' })
  await until(() => host.messages.length >= 2, 4000, 'reply to a ping')
  if (host.messages[1].bridge !== 'running' || host.leftover()) fail(`R3: ${JSON.stringify(host.messages)} leftover=${host.leftover()}`)
  pass('R3 a ping is answered with "running"; stdout carries only framed messages')

  // ---------- R4 host exit ----------
  host.child.stdin.end() // what Chrome does when the service worker lets go
  await until(() => host.child.exitCode !== null, 5000, 'host exit after the pipe closed')
  await sleep(500)
  if ((await up(HOST_PORT))?.pid !== bridge1.pid) fail('R4: the bridge died with the host')
  pass('R4 host exits when the pipe closes; the detached bridge keeps serving')

  // ---------- R5 no console ----------
  const consoles = consoleChildren(bridge1.pid)
  if (consoles !== 0) fail(`R5: the bridge owns ${consoles} console(s) — a window could show`)
  pass('R5 the detached bridge has no console attached (no window can appear)')

  // ---------- R6 recovery ----------
  process.kill(bridge1.pid)
  await until(async () => !(await up(HOST_PORT)), 5000, 'bridge gone after kill')
  const again = launchHost(HOST_PORT)
  await until(() => again.messages.length >= 1, 8000, 'reply after the bridge died')
  if (again.messages[0].bridge !== 'started') fail(`R6: ${JSON.stringify(again.messages[0])}`)
  const bridge2 = await until(async () => { const i = await up(HOST_PORT); return i?.store === STORE && i.pid !== bridge1.pid && i }, 8000, 'revived bridge')
  owned.pids.add(bridge2.pid)
  again.child.stdin.end()
  pass(`R6 a killed bridge is revived by the next launch (pid ${bridge1.pid} -> ${bridge2.pid})`)

  // ---------- R7 + R8 watchers through the installed launcher ----------
  execFileSync(process.execPath, [path.join(ROOT, 'agent', 'setup-agent.mjs'), 'all'], { env: ENV, encoding: 'utf8', windowsHide: true })
  let n = 0
  let gitBash = false // Git for Windows' bash; a WSL bash.exe without a distro fails this
  try { execFileSync('bash', ['-c', 'true'], { stdio: 'ignore', windowsHide: true }); gitBash = true } catch { console.log('NOTE bash not found: the Git Bash legs are skipped') }
  for (const [shell, label, wake, idEnv] of [
    ...(gitBash ? [['bash', 'Win Bash', 'push', { CLAUDE_CODE_SESSION_ID: 'suite-win-claude' }]] : []),
    ['powershell', 'Win PowerShell', 'pull', { CODEX_THREAD_ID: 'suite-win-codex' }],
  ]) {
    const session = Object.values(idEnv)[0]
    const w = armIn(shell, label, wake, idEnv)
    const agent = await until(async () => (await identity(HOST_PORT)).agents?.find((a) => a.session === session), 12000, `${shell} watcher in the roster\n${w.output()}`)
    if (agent.wake !== wake || agent.label !== label || agent.project !== 'target app') fail(`R7 ${shell}: roster entry ${JSON.stringify(agent)}`)
    await until(async () => (await identity(HOST_PORT)).agentLabel === label, 6000, `${label} owns the channel`)
    const created = await (await fetch(`http://127.0.0.1:${HOST_PORT}/comments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `Tighten the ${shell} card`, url: 'http://localhost:5175/cards', target: { selector: '.card', innerText: 'Card' } }),
    })).json()
    n++
    if (created.id !== `nudge_${n}`) fail(`R7 ${shell}: created ${created.id}`)
    await until(() => w.output().includes(`New nudge ${created.id}: Tighten the ${shell} card`), 6000, `${shell} watcher wake line\n${w.output()}`)
    const context = JSON.parse(cli(shell, `context --agent-id ${session} --port 5175`, idEnv))
    if (context.open.length !== 1 || context.open[0].id !== created.id || context.store !== STORE) fail(`R7 ${shell}: context ${JSON.stringify(context)}`)
    const resolved = JSON.parse(cli(shell, `resolve ${created.id} --wait-evidence 0`, idEnv))
    if (!resolved.resolved) fail(`R7 ${shell}: resolve ${JSON.stringify(resolved)}`)
    pass(`R7 ${shell} arms "${label}" (${wake}) via the installed command; nudge -> wake line -> context -> resolve`)

    // R8: the agent's shell dies; Windows does not re-parent, the watcher must notice by itself
    await sleep(4000) // let the watcher finish recording its ancestry
    owned.pids.add(agent.pid)
    w.child.kill()
    await until(() => !alive(agent.pid), 15000, `${shell} watcher exit after its shell died`)
    pass(`R8 ${shell}: the watcher exits on its own once its agent's shell is gone`)
  }

  // ---------- R9 SessionStart hook ----------
  const settings = JSON.parse(fs.readFileSync(path.join(HOME_DIR, '.claude', 'settings.json'), 'utf8'))
  const hook = settings.hooks.SessionStart.flatMap((g) => g.hooks).find((h) => h.command.includes('nudge-session-start.mjs')).command
  const runHook = () => execFileSync('cmd.exe', ['/d', '/s', '/c', `"${hook}"`], { env: { ...ENV, NUDGE_PORT: String(HOOK_PORT) }, windowsVerbatimArguments: true, windowsHide: true, encoding: 'utf8' })
  if (await up(HOOK_PORT)) fail(`side port ${HOOK_PORT} is busy`)
  if (runHook().trim()) fail('R9: the SessionStart hook printed something (it would become session context)')
  const hooked = await until(async () => { const i = await up(HOOK_PORT); return i?.store === STORE && i }, 8000, 'bridge from the SessionStart hook')
  owned.pids.add(hooked.pid)
  if (consoleChildren(hooked.pid) !== 0) fail('R9: the hook-started bridge has a console')
  runHook()
  await sleep(1500)
  if ((await up(HOOK_PORT))?.pid !== hooked.pid) fail('R9: a second hook run replaced the running bridge')
  pass('R9 SessionStart hook: silent, one hidden detached bridge, a second run leaves it alone')

  // ---------- R10 uninstall ----------
  const removed = install('--uninstall')
  if (fs.existsSync(WRAPPER) || fs.existsSync(MANIFEST)) fail('R10: uninstall left the wrapper or manifest')
  for (const browser of ['Google\\Chrome', 'Chromium']) {
    if (!removed.includes(`reg delete HKCU\\Software\\${browser}\\NativeMessagingHosts\\dev.groundworks.nudge /f`)) fail(`R10: no registry removal planned for ${browser}`)
  }
  if (!fs.existsSync(path.join(STORE, 'store.json'))) fail('R10: uninstall touched the store')
  pass('R10 uninstall removes wrapper, manifest and both registry keys (planned), keeps the store')

  // ---------- R11 one-step install.cmd ----------
  const runInstallCmd = (args) => execFileSync('cmd.exe', ['/d', '/s', '/c', `""${path.join(ROOT, 'install.cmd')}" ${args}"`],
    { cwd: PROJECT, env: ENV, windowsVerbatimArguments: true, windowsHide: true, encoding: 'utf8' })
  const launcher = path.join(BIN, 'groundworks-nudge.cmd')
  setupUninstall()
  if (fs.existsSync(launcher)) fail('R11: precondition — launcher still present before install.cmd')
  const oneStep = runInstallCmd('--dry-run')
  if (!fs.existsSync(WRAPPER) || !fs.existsSync(MANIFEST) || !fs.existsSync(launcher)) fail(`R11: install.cmd left out a piece\n${oneStep}`)
  if (!oneStep.includes('[3/3]') || !oneStep.includes(path.join(ROOT, 'extension'))) fail(`R11: install.cmd did not finish or name the extension folder\n${oneStep}`)
  if (!oneStep.includes('dry-run: reg add')) fail('R11: --dry-run did not reach the native host installer')
  const oneStepOff = runInstallCmd('--uninstall --dry-run')
  if (fs.existsSync(WRAPPER) || fs.existsSync(launcher)) fail(`R11: install.cmd --uninstall left the wrapper or launcher\n${oneStepOff}`)
  if (!fs.existsSync(path.join(STORE, 'store.json'))) fail('R11: install.cmd --uninstall touched the store')
  pass('R11 install.cmd runs all three steps from another directory (path with spaces); --uninstall reverses them, keeps the store')

  console.log('\nSuite R: ALL PASS')
} catch (e) {
  console.error(`FAIL: ${e instanceof Fail ? e.message : e.stack}`)
  process.exitCode = 1
} finally {
  for (const child of owned.children) { try { child.kill() } catch { /* gone */ } }
  for (const pid of owned.pids) { try { process.kill(pid) } catch { /* gone */ } }
  await sleep(300)
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }) } catch (e) { console.error(`note: could not remove ${SCRATCH}: ${e.code}`) }
}
