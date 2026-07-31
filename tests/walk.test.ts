import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { walk, BINARY_EXT, TEXT_BEARING_BINARY_EXT } from '../src/vendor/walk'
import { parseGitignore, isIgnored } from '../src/vendor/ignore'
import { readTextEx, OffsetMap } from '../src/vendor/text'

let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ultrai18n-walk-'))
  spawnSync('git', ['init', '-q'], { cwd: root })

  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'docs/images'), { recursive: true })
  mkdirSync(join(root, 'node_modules/pkg'), { recursive: true })
  mkdirSync(join(root, 'generated'), { recursive: true })

  writeFileSync(join(root, '.gitignore'), 'generated/\n*.tmp\n!keep.tmp\n')
  writeFileSync(join(root, 'package.json'), '{"description":"hi"}')
  writeFileSync(join(root, 'src/app.ts'), 'export const a = 1\n')
  writeFileSync(join(root, 'src/icon.svg'), '<svg><title>Close</title></svg>')
  writeFileSync(join(root, 'docs/images/shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]))
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  writeFileSync(join(root, 'node_modules/pkg/index.js'), 'module.exports = 1')
  writeFileSync(join(root, 'generated/out.ts'), 'export const g = 1')
  writeFileSync(join(root, 'scratch.tmp'), 'junk')
  writeFileSync(join(root, 'keep.tmp'), 'kept')
  writeFileSync(join(root, 'empty.ts'), '')
  writeFileSync(join(root, 'binary.dat'), Buffer.from([1, 2, 0, 3]))
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

const relsOf = (r: ReturnType<typeof walk>) => r.files.map((f) => f.rel)

describe('walk', () => {
  it('finds SVG, because SVG is text that carries copy (delta #1)', () => {
    expect(BINARY_EXT.has('.svg')).toBe(false)
    expect(relsOf(walk(root))).toContain('src/icon.svg')
  })

  it('reports skipped paths by name and reason, not as a count (delta #2)', () => {
    const { skipped, skippedDirs } = walk(root)
    const byRel = Object.fromEntries(skipped.map((s) => [s.rel, s.reason]))

    expect(byRel['pnpm-lock.yaml']).toBe('lockfile')
    expect(byRel['docs/images/shot.png']).toBe('binary-ext')
    expect(byRel['scratch.tmp']).toBe('gitignored')
    expect(byRel['binary.dat']).toBeUndefined() // .dat is not a known binary ext; it is read and sniffed

    // A tracked file under an ignored directory has to be attributable, or the
    // census reports it as unaccounted with no way to explain why.
    expect(skippedDirs.map((s) => s.rel)).toContain('node_modules')
    expect(skippedDirs.map((s) => s.rel)).toContain('generated')
  })

  it('flags which skipped binaries a human can still read text in', () => {
    const png = walk(root).skipped.find((s) => s.rel === 'docs/images/shot.png')
    expect(png?.textBearing).toBe(true)
    expect(TEXT_BEARING_BINARY_EXT.has('.woff2')).toBe(false)
  })

  it('lists lockfiles and binaries in census mode (delta #4)', () => {
    const rels = relsOf(walk(root, { includeLockfiles: true, includeBinary: true }))
    expect(rels).toContain('pnpm-lock.yaml')
    expect(rels).toContain('docs/images/shot.png')
  })

  it('honours gitignore negation', () => {
    const rels = relsOf(walk(root))
    expect(rels).toContain('keep.tmp')
    expect(rels).not.toContain('scratch.tmp')
  })

  it('is deterministic and sorted', () => {
    const a = relsOf(walk(root))
    const b = relsOf(walk(root))
    expect(a).toEqual(b)
    expect(a).toEqual([...a].sort())
  })
})

describe('gitignore parity with git check-ignore', () => {
  // The recall claim rests on the walker not silently dropping files, so the
  // ignore semantics are tested against git itself rather than against our
  // reading of the spec.
  //
  // The comparison is against the WALK, not against isIgnored() in isolation.
  // git ignores `bld/x.js` by ignoring the directory, and so does the walker,
  // by never descending into it — but a direct isIgnored('bld/x.js', false)
  // call correctly returns false, because a dirOnly rule does not match a file.
  // Testing the unit in isolation would assert a semantics the walker does not
  // have, and would fail on correct code.
  const patterns = [
    'bld/',
    '*.log',
    '!important.log',
    '/root-only.txt',
    'papers/**/draft.md',
    'a**b.txt',
    '*.py[cod]',
    '[Tt]humbs.db',
    'space\\ file.txt',
  ]
  // Deliberately avoids every name in IGNORE_DIRS, so gitignore is the only
  // exclusion mechanism under test.
  const candidates = [
    'bld/x.js',
    'nested/bld/x.js',
    'app.log',
    'important.log',
    'logs/app.log',
    'root-only.txt',
    'sub/root-only.txt',
    'papers/a/b/draft.md',
    'papers/draft.md',
    'aXXb.txt',
    'a/b.txt',
    'mod.pyc',
    'mod.pyx',
    'Thumbs.db',
    'thumbs.db',
    'space file.txt',
    'plain.ts',
  ]

  it('walks exactly the files git does not ignore', () => {
    const repo = mkdtempSync(join(tmpdir(), 'ultrai18n-ignore-'))
    try {
      spawnSync('git', ['init', '-q'], { cwd: repo })
      writeFileSync(join(repo, '.gitignore'), patterns.join('\n') + '\n')
      for (const rel of candidates) {
        const dir = join(repo, rel.split('/').slice(0, -1).join('/'))
        if (dir !== repo) mkdirSync(dir, { recursive: true })
        writeFileSync(join(repo, rel), 'x')
      }

      const walked = new Set(walk(repo).files.map((f) => f.rel))
      const disagreements: string[] = []
      for (const rel of candidates) {
        const git = spawnSync('git', ['check-ignore', '-q', '--no-index', rel], { cwd: repo })
        const gitIgnores = git.status === 0
        const weWalked = walked.has(rel)
        if (gitIgnores === weWalked) {
          disagreements.push(`${rel}: git ignores=${gitIgnores}, we walked=${weWalked}`)
        }
      }
      expect(disagreements).toEqual([])
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('applies dir-only rules to directories, not to files of the same name', () => {
    const rules = parseGitignore('bld/\n', '')
    expect(isIgnored(rules, 'bld', true)).toBe(true)
    expect(isIgnored(rules, 'bld', false)).toBe(false)
  })
})

describe('readTextEx (delta #3)', () => {
  it('tells an empty file apart from a binary one', () => {
    const empty = readTextEx(join(root, 'empty.ts'))
    expect(empty).toMatchObject({ ok: true, binary: false, bytes: 0, text: '' })

    const bin = readTextEx(join(root, 'binary.dat'))
    expect(bin).toMatchObject({ ok: true, binary: true, text: '' })

    // Upstream's readText() returns "" for both, and for this one too:
    const missing = readTextEx(join(root, 'nope.ts'))
    expect(missing.ok).toBe(false)
  })

  it('marks non-UTF-8 files as not byte-addressable rather than guessing offsets', () => {
    const p = join(root, 'utf16.ts')
    writeFileSync(p, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('const a = 1', 'utf16le')]))
    const r = readTextEx(p)
    expect(r.encoding).toBe('utf16le')
    expect(r.byteAddressable).toBe(false)
    expect(r.text).toBe('const a = 1')
  })

  it('strips a UTF-8 BOM and records the body offset', () => {
    const p = join(root, 'bom.json')
    writeFileSync(p, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}')]))
    const r = readTextEx(p)
    expect(r.encoding).toBe('utf8-bom')
    expect(r.text).toBe('{"a":1}')
    expect(r.bodyStart).toBe(3)
    expect(r.byteAddressable).toBe(true)
  })
})

describe('OffsetMap', () => {
  it('takes the identity path on ASCII', () => {
    const m = new OffsetMap('const a = 1')
    expect(m.byteOf(6)).toBe(6)
  })

  it('maps char indices to UTF-8 byte offsets on accented text', () => {
    // "Données effacées." — the exact shape of string this tool exists to move.
    const text = 'Données effacées.'
    const m = new OffsetMap(text)
    expect(m.byteOf(0)).toBe(0)
    // "Donn" = 4 bytes, then "é" is 2 bytes, so char 5 starts at byte 6.
    expect(m.byteOf(5)).toBe(6)
    expect(m.byteOf(text.length)).toBe(Buffer.byteLength(text, 'utf8'))
  })

  it('handles astral characters without shifting', () => {
    const text = 'a😀b'
    const m = new OffsetMap(text)
    expect(m.byteOf(1)).toBe(1)
    expect(m.byteOf(3)).toBe(5) // 1 + 4
    expect(m.byteOf(text.length)).toBe(Buffer.byteLength(text, 'utf8'))
  })

  it('reports 1-based line and column', () => {
    const m = new OffsetMap('a\nbb\nccc')
    expect(m.lineColOf(0)).toEqual({ line: 1, col: 1 })
    expect(m.lineColOf(2)).toEqual({ line: 2, col: 1 })
    expect(m.lineColOf(6)).toEqual({ line: 3, col: 2 })
  })
})
