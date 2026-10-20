#!/usr/bin/env node
// Register the Nudge native messaging host with Chrome on WINDOWS (once per
// machine). The macOS/Linux installer is install-native-host.sh.
//
// Usage:
//   node bridge/install-native-host.mjs [extension-id]   install or repair
//   node bridge/install-native-host.mjs --uninstall      remove the registration
//   --dry-run   write nothing to the registry, print the planned registry calls
//
// Windows finds a native host through the registry, not a folder: a per-user
// key HKCU\Software\<browser>\NativeMessagingHosts\<name> whose default value is
// the path of the host manifest. Chrome then starts the manifest's `path`
// through `cmd.exe /d /s /c`, so the host is a generated .cmd wrapper that pins
// node and the absolute path of the launcher. Wrapper and manifest are machine
// specific and live next to this script, untracked in git.
//
// Without an argument the extension id is derived from the extension folder,
// the way Chrome computes the id of an unpacked extension. If chrome://extensions
// shows a different id, pass that one. Moving the repository changes the id:
// load the extension again from the new place and re-run this script.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deriveExtensionId, isExtensionId } from './extension-id.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOST_NAME = 'dev.groundworks.nudge'
const WRAPPER = path.join(HERE, 'native-host-wrapper.cmd')
const MANIFEST = path.join(HERE, `${HOST_NAME}.json`)
// Chrome and Chromium both get the key (the Playwright test browser is Chromium)
const KEYS = [
  `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
  `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${HOST_NAME}`,
]

const args = process.argv.slice(2)
const DRY = args.includes('--dry-run')
const UNINSTALL = args.includes('--uninstall')
const positional = args.filter((a) => !a.startsWith('--'))
const die = (message, code = 1) => { console.error(`error: ${message}`); process.exit(code) }

if (process.platform !== 'win32') die('this installer is for Windows. On macOS/Linux run ./bridge/install-native-host.sh')

function reg(argv) {
  if (DRY) { console.log(`dry-run: reg ${argv.join(' ')}`); return '' }
  return execFileSync('reg.exe', argv, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
}
function currentValue(key) {
  if (DRY) return null
  try {
    const out = execFileSync('reg.exe', ['query', key, '/ve'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    return out.match(/REG_SZ\s+(.+?)\s*$/m)?.[1] || null
  } catch { return null } // key absent
}

if (UNINSTALL) {
  for (const key of KEYS) {
    const value = currentValue(key)
    if (!DRY && !value) { console.log(`not registered: ${key}`); continue }
    if (value && path.resolve(value).toLowerCase() !== MANIFEST.toLowerCase())
      console.log(`note: ${key} pointed at ${value} (another checkout); removing it`)
    reg(['delete', key, '/f'])
    console.log(`removed: ${key}`)
  }
  for (const file of [WRAPPER, MANIFEST]) {
    if (fs.existsSync(file)) { fs.rmSync(file); console.log(`removed: ${file}`) }
  }
  console.log('Your prompts and screenshots in the Nudge store were left untouched.')
  process.exit(0)
}

const EXT_DIR = fs.realpathSync.native(path.join(HERE, '..', 'extension'))
const EXT_ID = positional[0] || deriveExtensionId(EXT_DIR)
if (!isExtensionId(EXT_ID)) die(`'${EXT_ID}' is not a Chrome extension id (32 letters a-p)`, 2)

const [major] = process.versions.node.split('.').map(Number)
if (major < 22) die(`Node.js 22 or newer is required (this is ${process.version})`)

// The wrapper pins THIS node. cmd expands %…% even inside quotes, so a literal
// percent sign in a path is doubled. CRLF: cmd misparses some LF-only scripts.
const cmdQuote = (p) => `"${String(p).replace(/%/g, '%%')}"`
const wrapper = [
  '@echo off',
  'rem Groundworks Nudge native host launcher. Generated per machine by',
  'rem install-native-host.mjs; not tracked in git. @echo off matters: any echo',
  'rem on stdout would corrupt the native messaging stream.',
  `${cmdQuote(process.execPath)} ${cmdQuote(path.join(HERE, 'native-host.mjs'))} %*`,
  '',
].join('\r\n')
fs.writeFileSync(WRAPPER, wrapper)

const manifest = {
  name: HOST_NAME,
  description: 'Nudge bridge launcher (UI prompting for local coding agents)',
  path: WRAPPER,
  type: 'stdio',
  allowed_origins: [`chrome-extension://${EXT_ID}/`],
}
fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`wrote: ${WRAPPER}`)
console.log(`wrote: ${MANIFEST}`)

for (const key of KEYS) {
  const before = currentValue(key)
  if (before && path.resolve(before).toLowerCase() !== MANIFEST.toLowerCase())
    console.log(`note: ${key} pointed at ${before}; it now points at this checkout`)
  reg(['add', key, '/ve', '/t', 'REG_SZ', '/d', MANIFEST, '/f'])
  console.log(`registered: ${key}`)
}
console.log(`extension id: ${EXT_ID}${positional[0] ? '' : ` (derived from ${EXT_DIR})`}`)
console.log('If chrome://extensions shows a different id, re-run: node bridge\\install-native-host.mjs <that-id>')
