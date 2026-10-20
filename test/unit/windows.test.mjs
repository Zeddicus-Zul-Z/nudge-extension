import { describe, expect, it } from 'vitest'
import { deriveExtensionId, isExtensionId } from '../../bridge/extension-id.mjs'
import { parseAncestry } from '../../bridge/ancestry.mjs'

describe('unpacked extension id', () => {
  it('is 32 letters a-p on every platform', () => {
    expect(isExtensionId(deriveExtensionId('/home/dev/nudge-extension/extension', 'linux'))).toBe(true)
    expect(isExtensionId(deriveExtensionId('C:\\src\\nudge-extension\\extension', 'win32'))).toBe(true)
  })

  it('hashes UTF-8 on POSIX and UTF-16LE with an upper-case drive on Windows', () => {
    // same string, different encodings, different ids — the Windows id is what
    // Chromium shows (proven against real Chromium in test/windows-chrome.mjs)
    expect(deriveExtensionId('C:\\a b\\extension', 'win32')).not.toBe(deriveExtensionId('C:\\a b\\extension', 'linux'))
    expect(deriveExtensionId('c:\\a b\\extension', 'win32')).toBe(deriveExtensionId('C:\\a b\\extension', 'win32'))
    // regression vectors, locked so a refactor cannot silently change the id.
    // The POSIX one equals install-native-host.sh's shell pipeline output.
    expect(deriveExtensionId('/home/dev/nudge-extension/extension', 'linux')).toBe('okldcieegkohefpnjelnpiiipapeghio')
    expect(deriveExtensionId('C:\\src\\nudge-extension\\extension', 'win32')).toBe('acabdknohhalcbdoibjeminjlojghgeg')
  })
})

describe('Windows watcher ancestry', () => {
  const line = (pid, ppid, name, created) => `${pid}|${ppid}|${name}|${created}`

  it('walks the shims up to and including the agent, then stops', () => {
    const text = [
      line(40, 30, 'node.exe', 400), // the watcher itself
      line(30, 20, 'cmd.exe', 300), // groundworks-nudge.cmd
      line(20, 10, 'bash.exe', 200), // the agent's shell
      line(10, 5, 'claude.exe', 100), // the agent
      line(5, 1, 'T3 Code.exe', 50), // beyond the agent: not ours to watch
    ].join('\r\n')
    expect(parseAncestry(text)).toEqual([
      { pid: 30, name: 'cmd.exe' }, { pid: 20, name: 'bash.exe' }, { pid: 10, name: 'claude.exe' },
    ])
  })

  it('stops at a recycled pid (a parent younger than its child) and at system roots', () => {
    expect(parseAncestry([line(40, 30, 'node.exe', 400), line(30, 20, 'cmd.exe', 500)].join('\n'))).toEqual([])
    expect(parseAncestry([line(40, 30, 'node.exe', 400), line(30, 2, 'explorer.exe', 100)].join('\n'))).toEqual([])
    expect(parseAncestry([line(40, 30, 'node.exe', 400), line(31, 20, 'cmd.exe', 100)].join('\n'))).toEqual([])
  })

  it('returns nothing usable for empty or garbled output', () => {
    expect(parseAncestry('')).toEqual([])
    expect(parseAncestry('not|a|row')).toEqual([])
  })
})
