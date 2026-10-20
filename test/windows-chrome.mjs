// Suite S — Windows: the id the native host installer derives is the id
// Chromium actually gives the unpacked extension. A wrong id means Chrome
// refuses the host (allowed_origins) and the bridge is never started.
// Loads the extension from the repository AND from a copy under a path with
// spaces. Real Chromium, no bridge, no registry. Windows only.
import { chromium } from 'playwright'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deriveExtensionId } from '../bridge/extension-id.mjs'

if (process.platform !== 'win32') { console.log('SKIP Suite S: Windows only'); process.exit(0) }

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_EXT = fs.realpathSync.native(path.join(HERE, '../extension'))
const SPACED = fs.mkdtempSync(path.join(os.tmpdir(), 'nudge wc '))
const SPACED_EXT = path.join(SPACED, 'Nudge Checkout', 'extension')
fs.cpSync(REPO_EXT, SPACED_EXT, { recursive: true })

const fail = (message) => { console.error('FAIL:', message); process.exitCode = 1 }

async function loadedId(ext) {
  const ctx = await chromium.launchPersistentContext('', {
    headless: false,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  })
  try {
    const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 10000 })
    return new URL(sw.url()).host
  } finally { await ctx.close() }
}

try {
  for (const [name, ext] of [['repository path', REPO_EXT], ['path with spaces', fs.realpathSync.native(SPACED_EXT)]]) {
    const actual = await loadedId(ext)
    const derived = deriveExtensionId(ext)
    if (actual !== derived) fail(`S1 ${name}: derived ${derived}, Chromium loaded ${actual} (${ext})`)
    else console.log(`PASS S1 ${name}: derived id = Chromium id (${actual})`)
  }
} finally {
  fs.rmSync(SPACED, { recursive: true, force: true })
}
if (!process.exitCode) console.log('\nSuite S: ALL PASS')
