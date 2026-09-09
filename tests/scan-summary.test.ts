import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

it('public scan --summary is compact while preserving full inventory accounting', () => {
  const repo = mkdtempSync(join(tmpdir(), 'ultrai18n-summary-'))
  const out = mkdtempSync(join(tmpdir(), 'ultrai18n-summary-out-'))
  const engine = resolve('skills/ultrai18n/scripts/ultrai18n.mjs')
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, [engine, ...args, '--repo', repo], {
      encoding: 'utf8',
      timeout: 120000,
    })
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    return JSON.parse(result.stdout)
  }

  try {
    mkdirSync(join(repo, 'locales'), { recursive: true })
    const messages = Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [`message${i}`, `Message ${i}`]),
    )
    writeFileSync(join(repo, 'locales', 'en.json'), JSON.stringify(messages, null, 2) + '\n')
    writeFileSync(join(repo, 'fixture.bin'), Buffer.from('binary payload with readable words\0', 'utf8'))
    for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'fixture']]) {
      expect(spawnSync('git', args, { cwd: repo }).status).toBe(0)
    }

    const summary = run('scan', '--from', 'en', '--to', 'fr', '--out', out, '--summary')
    const full = run('scan', '--from', 'en', '--to', 'fr', '--out', out, '--json')
    const inventoryBytes = readFileSync(join(out, 'inventory.json'))
    const inventorySha256 = createHash('sha256').update(inventoryBytes).digest('hex')

    expect(summary.inventorySha256).toBe(inventorySha256)
    expect(Object.values(summary.classificationCounts).reduce((a: number, n) => a + Number(n), 0)).toBe(summary.sites)
    expect(summary.sites).toBe(full.sites.length)
    expect(summary.sites).toBeGreaterThan(200)
    expect(JSON.stringify(summary).length).toBeLessThan(JSON.stringify(full).length / 10)
    expect(summary.files.total).toBe(full.census.length)
    expect(summary.files.scanned).toBe(full.census.filter((c: { bucket: string }) => c.bucket !== 'skipped').length)
    expect(summary.files.skipped).toBe(full.census.filter((c: { bucket: string }) => c.bucket === 'skipped').length)
    expect(summary.files.skipped).toBeGreaterThanOrEqual(1)
    expect(summary.skippedExamples.some((c: { file: string }) => c.file === 'fixture.bin')).toBe(true)
    expect(summary.limits).toEqual(full.limits)
    expect(summary.interpretation).toContain('classification accuracy')
    expect(summary).not.toHaveProperty('classificationCertainty')
    expect(summary).not.toHaveProperty('sitesDetail')
    expect(full.sites).toHaveLength(summary.sites)
    expect(full.census.find((c: { file: string }) => c.file === 'fixture.bin')).toMatchObject({ bucket: 'skipped' })
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(out, { recursive: true, force: true })
  }
}, 180000)
