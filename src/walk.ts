// Inventory policy; codeindex owns traversal, gitignore and text decoding.
import { walk as engineWalk, type WalkOptions as EngineWalkOptions, type WalkedFile, type WalkSkip } from './vendor/codeindex-engine.mjs'
export type { WalkedFile } from './vendor/codeindex-engine.mjs'
export const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.icns', '.pdf', '.zip',
  '.gz', '.tar', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.jar', '.war', '.class', '.so', '.dylib',
  '.dll', '.exe', '.bin', '.o', '.a', '.wasm', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp3',
  '.mp4', '.mov', '.avi', '.webm', '.wav', '.flac', '.ogg', '.lock', '.min.js', '.map',
])
export const TEXT_BEARING_BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.icns',
  '.pdf', '.mp4', '.mov', '.avi', '.webm', '.mp3', '.wav', '.flac', '.ogg',
  '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.odt', '.ods', '.odp',
  '.sqlite', '.sqlite3', '.db',
])
export type WalkOptions = Pick<EngineWalkOptions, 'maxFileBytes' | 'maxFiles' | 'gitignore' | 'ignoreDirs' | 'includeLockfiles' | 'includeBinary' | 'includeOversize'>
export type Skipped = Omit<WalkSkip, 'directory'> & { textBearing?: boolean }
export interface WalkResult { files: WalkedFile[]; capped: boolean; skipped: Skipped[]; skippedDirs: Skipped[] }
export function walk(root: string, opts: WalkOptions = {}): WalkResult {
  const skipped: Skipped[] = [], skippedDirs: Skipped[] = []
  const result = engineWalk(root, { ...opts, binaryExtensions: BINARY_EXT, onSkip: ({ directory, ...entry }) => {
    const record: Skipped = entry
    if (entry.reason === 'binary-ext') record.textBearing = TEXT_BEARING_BINARY_EXT.has(entry.rel.slice(entry.rel.lastIndexOf('.')).toLowerCase())
    ;(directory ? skippedDirs : skipped).push(record)
  } })
  const compare = (a: { rel: string }, b: { rel: string }) => a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0
  return { files: result.files.sort(compare), capped: result.capped, skipped: skipped.sort(compare), skippedDirs: skippedDirs.sort(compare) }
}
