import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WINDOWS = process.platform === 'win32'
const SETUP = path.join(HERE, WINDOWS ? '../agent/setup-agent.mjs' : '../agent/setup-agent.sh')
// Windows: a space in the home path, profiles like "C:\Users\First Last" are common
const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), WINDOWS ? 'nudge setup ' : 'nudge-setup-'))
const BIN = path.join(HOME_DIR, '.local/bin')
// USERPROFILE is what os.homedir() reads on Windows, HOME everywhere else
const ENV = { ...process.env, HOME: HOME_DIR, USERPROFILE: HOME_DIR }
const fail = (message) => { throw new Error(message) }
const pass = (message) => console.log(`PASS ${message}`)
const setup = (...args) => WINDOWS
  ? execFileSync(process.execPath, [SETUP, ...args], { env: ENV, encoding: 'utf8', stdio: 'pipe' })
  : execFileSync('bash', [SETUP, ...args], { env: ENV, encoding: 'utf8', stdio: 'pipe' })
const hookCommands = (settings, event) => (settings.hooks?.[event] || []).flatMap((group) => group.hooks || []).map((hook) => hook.command)
const HOOK_FILES = WINDOWS
  ? ['nudge-context.mjs', 'runtime.mjs', 'nudge-session-start.mjs']
  : ['nudge-context.mjs', 'runtime.mjs', 'nudge-session-start.sh']

// Windows: the command has to resolve in each shell an agent may use — cmd,
// PowerShell (Codex) and Git Bash (Claude Code). PATH gets only the test bin
// in front; the system part stays so node and the shells resolve.
const WIN_PATH = `${BIN}${path.delimiter}${process.env.PATH}`
// cmd does not understand the backslash-escaped quotes Node would produce, so
// its command line is passed verbatim, the way Chrome and hook runners do it
const cmd = (command, options) => execFileSync('cmd.exe', ['/d', '/s', '/c', `"${command}"`], { ...options, windowsVerbatimArguments: true, encoding: 'utf8', windowsHide: true })
function viaShell(shell, command, { env: extraEnv = {}, input } = {}) {
  const env = { ...ENV, PATH: WIN_PATH, ...extraEnv }
  if (shell === 'cmd') return cmd(command, { env, input })
  if (shell === 'powershell') return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { env, input, encoding: 'utf8', windowsHide: true })
  return execFileSync('bash', ['-c', command], { env, input, encoding: 'utf8', windowsHide: true })
}
const hasBash = () => { try { execFileSync('bash', ['-c', 'true'], { stdio: 'ignore', windowsHide: true }); return true } catch { return false } }

try {
  for (const [file, marker] of [
    ['.claude/settings.json', 'keep-claude'],
    ['.codex/hooks.json', 'keep-codex'],
  ]) {
    const target = path.join(HOME_DIR, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, JSON.stringify({
      preserved: marker,
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `echo ${marker}` }] }] },
    }))
  }
  for (const skillsHome of ['.claude/skills', '.agents/skills', '.grok/skills']) {
    const alias = path.join(HOME_DIR, skillsHome, 'nudge/SKILL.md')
    fs.mkdirSync(path.dirname(alias), { recursive: true })
    fs.writeFileSync(alias, '---\nname: nudge\ndescription: "Compatibility alias for groundworks-nudge."\n---\n')
    const stale = path.join(HOME_DIR, skillsHome, 'groundworks-nudge/SKILL.md')
    fs.mkdirSync(path.dirname(stale), { recursive: true })
    fs.writeFileSync(stale, '---\nname: groundworks-nudge\ndescription: "Stale installation fixture."\n---\n')
  }

  setup('all')
  const settingsAfterFirst = fs.readFileSync(path.join(HOME_DIR, '.claude/settings.json'), 'utf8')
  setup('all')

  if (WINDOWS) {
    if (fs.readFileSync(path.join(HOME_DIR, '.claude/settings.json'), 'utf8') !== settingsAfterFirst) fail('re-running setup rewrote an unchanged settings file')
    for (const file of ['groundworks-nudge.cmd', 'groundworks-nudge']) {
      if (!fs.existsSync(path.join(BIN, file))) fail(`launcher ${file} was not installed`)
    }
    const shells = ['cmd', 'powershell', ...(hasBash() ? ['bash'] : [])]
    for (const shell of shells) {
      const help = viaShell(shell, 'groundworks-nudge help')
      if (!help.includes('watch --label') || !help.includes('resolve')) fail(`groundworks-nudge does not resolve in ${shell}`)
    }
    pass(`runtime-neutral CLI launcher installs and runs from ${shells.join(', ')} (home path with a space)`)
    if (!hasBash()) console.log('NOTE bash not found: Git Bash launcher not exercised')
  } else {
    const launcher = path.join(BIN, 'groundworks-nudge')
    if (!fs.lstatSync(launcher).isSymbolicLink()) fail('neutral CLI launcher was not installed as a symlink')
    const help = execFileSync(launcher, ['help'], { env: ENV, encoding: 'utf8' })
    if (!help.includes('watch --label') || !help.includes('resolve')) fail('installed launcher does not expose the neutral CLI')
    pass('runtime-neutral CLI launcher installs and runs')
  }

  for (const home of [
    path.join(HOME_DIR, '.claude/skills'),
    path.join(HOME_DIR, '.agents/skills'),
    path.join(HOME_DIR, '.grok/skills'),
  ]) {
    const main = fs.readFileSync(path.join(home, 'groundworks-nudge/SKILL.md'), 'utf8')
    const header = /^---\n([\s\S]*?)\n---/.exec(main)?.[1] || ''
    if (!/^trigger: \/groundworks-nudge$/m.test(header) || !/^argument-hint: "\[short session label\]"$/m.test(header)) fail('Installed Skill lost its custom session-name invocation metadata')
    if (main !== fs.readFileSync(path.join(HERE, '../agent/NUDGE-SKILL.md'), 'utf8')) fail(`Skill differs from repository source in ${home}`)
    if (fs.existsSync(path.join(home, 'nudge/SKILL.md'))) fail(`legacy alias remains in ${home}`)
  }
  pass('Claude Code, Codex and Grok replace stale Skills with exact canonical copies')

  for (const [runtime, configFile, hooksDir] of [
    ['Claude Code', '.claude/settings.json', '.claude/hooks'],
    ['Codex', '.codex/hooks.json', '.codex/hooks'],
  ]) {
    const settings = JSON.parse(fs.readFileSync(path.join(HOME_DIR, configFile), 'utf8'))
    const marker = runtime === 'Claude Code' ? 'keep-claude' : 'keep-codex'
    if (settings.preserved !== marker) fail(`${runtime} top-level settings were overwritten`)
    if (!hookCommands(settings, 'PreToolUse').includes(`echo ${marker}`)) fail(`${runtime} unrelated hooks were overwritten`)
    for (const event of ['SessionStart', 'UserPromptSubmit']) {
      if (hookCommands(settings, event).filter((command) => command.includes('nudge-')).length !== 1) fail(`${runtime} ${event} hook was duplicated by idempotent setup`)
    }
    for (const filename of HOOK_FILES) {
      const installed = path.join(HOME_DIR, hooksDir, filename)
      if (!fs.existsSync(installed)) fail(`${runtime} hook is missing ${filename}`)
      if (!fs.readFileSync(installed).equals(fs.readFileSync(path.join(HERE, '../agent', filename)))) fail(`${runtime} hook differs from repository source: ${filename}`)
    }
    if (WINDOWS) {
      // the installed command line itself must run in a shell: silent, exit 0,
      // no bridge on this port -> the opt-in gate says nothing
      const [prompt] = hookCommands(settings, 'UserPromptSubmit').filter((command) => command.includes('nudge-'))
      if (/\$HOME|\/dev\/null/.test(prompt)) fail(`${runtime} hook command uses POSIX-only syntax: ${prompt}`)
      for (const shell of ['cmd', 'powershell', ...(hasBash() ? ['bash'] : [])]) {
        const out = viaShell(shell, prompt, { env: { NUDGE_PORT: '4859' }, input: '{"prompt":"Nudge 1"}' })
        if (out.trim()) fail(`${runtime} prompt hook spoke in ${shell} without an armed session: ${out}`)
      }
    }
  }
  pass('optional hooks preserve settings and install idempotently for Claude Code and Codex')

  if (WINDOWS) {
    // a settings file that does not parse is never overwritten
    const broken = path.join(HOME_DIR, '.codex/hooks.json')
    const brokenText = '{ "hooks": { // a comment makes this invalid JSON\n } }\n'
    fs.writeFileSync(broken, brokenText)
    const out = execFileSync(process.execPath, [SETUP, 'codex'], { env: ENV, encoding: 'utf8', stdio: 'pipe' })
    if (fs.readFileSync(broken, 'utf8') !== brokenText) fail('setup overwrote a settings file it could not parse')
    pass(`unparsable settings are left untouched (${out.includes('Nudge hooks active') ? 'unexpected success line' : 'skipped with a warning'})`)

    // a foreign file at the launcher path is refused, not replaced
    fs.writeFileSync(path.join(BIN, 'groundworks-nudge.cmd'), '@echo off\r\necho someone else\r\n')
    let refused = false
    try { setup('all') } catch (e) { refused = e.status === 3 }
    if (!refused) fail('setup replaced a groundworks-nudge.cmd it did not write')
    fs.rmSync(path.join(BIN, 'groundworks-nudge.cmd'))
    setup('all')
    pass('a foreign launcher is refused; setup repairs once it is gone')

    // uninstall: everything Nudge put there goes, user data and foreign config stay
    const store = path.join(HOME_DIR, '.nudge')
    fs.mkdirSync(store, { recursive: true })
    fs.writeFileSync(path.join(store, 'store.json'), '{"seq":1,"pins":[]}')
    fs.writeFileSync(path.join(HOME_DIR, '.codex/hooks.json'), JSON.stringify({ preserved: 'keep-codex' }))
    setup('all')
    setup('all', '--uninstall')
    for (const file of [
      '.local/bin/groundworks-nudge.cmd', '.local/bin/groundworks-nudge',
      '.claude/skills/groundworks-nudge', '.agents/skills/groundworks-nudge', '.grok/skills/groundworks-nudge',
      ...HOOK_FILES.flatMap((f) => [`.claude/hooks/${f}`, `.codex/hooks/${f}`]),
    ]) if (fs.existsSync(path.join(HOME_DIR, file))) fail(`uninstall left ${file}`)
    const claude = JSON.parse(fs.readFileSync(path.join(HOME_DIR, '.claude/settings.json'), 'utf8'))
    if (claude.preserved !== 'keep-claude' || !hookCommands(claude, 'PreToolUse').includes('echo keep-claude')) fail('uninstall damaged unrelated Claude Code settings')
    if (claude.hooks.SessionStart || claude.hooks.UserPromptSubmit) fail('uninstall left Nudge hook entries')
    const codex = JSON.parse(fs.readFileSync(path.join(HOME_DIR, '.codex/hooks.json'), 'utf8'))
    if (codex.preserved !== 'keep-codex' || codex.hooks) fail('uninstall damaged or left Codex hook config')
    if (!fs.existsSync(path.join(store, 'store.json'))) fail('uninstall deleted the Nudge store')
    setup('all', '--uninstall') // second run: nothing left to do, still succeeds
    pass('uninstall removes only Nudge files and entries, keeps the store, and is repeatable')
  }

  console.log('\nNudge agent setup: ALL PASS')
} finally {
  fs.rmSync(HOME_DIR, { recursive: true, force: true })
}
