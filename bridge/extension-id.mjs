// The id Chrome gives an unpacked extension: sha256 of its absolute path, the
// first 32 hex digits mapped onto the letters a-p. install-native-host.sh does
// the same in shell for macOS/Linux, where the path is hashed as UTF-8 bytes.
// On Windows Chrome hashes the path's UTF-16LE bytes, with the drive letter
// upper-cased (crx_file::id_util::GenerateIdForPath).
import crypto from 'node:crypto'

export function deriveExtensionId(absPath, platform = process.platform) {
  let p = String(absPath)
  let bytes
  if (platform === 'win32') {
    if (/^[a-z]:/.test(p)) p = p[0].toUpperCase() + p.slice(1)
    bytes = Buffer.from(p, 'utf16le')
  } else {
    bytes = Buffer.from(p, 'utf8')
  }
  const hex = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 32)
  return hex.replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)))
}

export const isExtensionId = (id) => /^[a-p]{32}$/.test(String(id || ''))
