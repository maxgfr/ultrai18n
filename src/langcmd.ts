// The language detector, standalone.
//
// It has always been wired into `scan`, which elects a source language from a
// letter-weighted vote across the whole tree and then never explains itself.
// That vote decides what G4 gates on, so "why does this repository think it is
// Portuguese" is a question somebody eventually needs answered.
//
// Three modes, and only one of them can be wrong — so only one of them gates.
import { detect, SUPPORTED } from './lang/detect'
import type { Inventory, LanguageGuess } from './types'

export interface LangProfile {
  repo: string
  elected: string | null
  /** Letters between the winner and the runner-up, as a fraction of the total. */
  margin: number
  languages: { lang: string; sites: number; letters: number; share: number }[]
  undecided: number
  loudestFiles: { file: string; lang: string; letters: number }[]
}

/**
 * Reconstruct the vote `scan` took silently.
 *
 * Weighted by LETTERS rather than by sites, exactly as the election is: forty
 * one-word buttons should not outvote a page of prose, and a repository whose
 * UI is short strings would otherwise elect whatever language its longest
 * comment happened to be in.
 */
export function profile(inv: Inventory): LangProfile {
  const byLang = new Map<string, { sites: number; letters: number }>()
  const byFile = new Map<string, Map<string, number>>()
  let undecided = 0

  for (const site of inv.sites) {
    const lang = site.lang.detected
    if (!lang) {
      undecided++
      continue
    }
    const letters = site.lang.letters || site.value.length
    const acc = byLang.get(lang) ?? { sites: 0, letters: 0 }
    acc.sites++
    acc.letters += letters
    byLang.set(lang, acc)

    const perFile = byFile.get(site.file) ?? new Map<string, number>()
    perFile.set(lang, (perFile.get(lang) ?? 0) + letters)
    byFile.set(site.file, perFile)
  }

  const total = [...byLang.values()].reduce((n, a) => n + a.letters, 0)
  const languages = [...byLang.entries()]
    .map(([lang, a]) => ({ lang, sites: a.sites, letters: a.letters, share: total ? round(a.letters / total) : 0 }))
    .sort((a, b) => b.letters - a.letters || (a.lang < b.lang ? -1 : 1))

  const loudestFiles = [...byFile.entries()]
    .map(([file, perFile]) => {
      const [lang, letters] = [...perFile.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['?', 0]
      return { file, lang, letters }
    })
    .sort((a, b) => b.letters - a.letters)
    .slice(0, 10)

  return {
    repo: inv.repo,
    elected: inv.sourceLanguage,
    margin: languages.length > 1 ? round(languages[0]!.share - languages[1]!.share) : languages.length ? 1 : 0,
    languages,
    undecided,
    loudestFiles,
  }
}

export interface Sample {
  lang: string
  text: string
}

/**
 * One sample per supported language.
 *
 * This is a REACHABILITY check on `SUPPORTED`, in the same spirit as the
 * catalog ratchet: a language the detector claims to know and can never
 * actually identify is a claim with nothing behind it.
 */
export const SAMPLES: Sample[] = [
  { lang: 'en', text: 'The quick brown fox jumps over the lazy dog and then goes back to sleep.' },
  { lang: 'fr', text: "Le renard brun et rapide saute par-dessus le chien paresseux, puis s'en retourne dormir." },
  { lang: 'es', text: 'El rápido zorro marrón salta sobre el perro perezoso y luego vuelve a dormir.' },
  { lang: 'de', text: 'Der schnelle braune Fuchs springt über den faulen Hund und legt sich wieder schlafen.' },
  { lang: 'it', text: 'La rapida volpe marrone salta sopra il cane pigro e poi torna a dormire.' },
  { lang: 'pt', text: 'A rápida raposa castanha salta sobre o cão preguiçoso e depois volta a dormir.' },
  { lang: 'nl', text: 'Het is niet mogelijk om deze instellingen op te slaan zonder een geldig adres.' },
  { lang: 'sv', text: 'Det är inte möjligt att spara dessa inställningar utan en giltig adress.' },
  { lang: 'da', text: 'Det er ikke muligt at gemme disse indstillinger uden en gyldig adresse.' },
  { lang: 'pl', text: 'Nie można zapisać tych ustawień bez podania prawidłowego adresu.' },
  { lang: 'ro', text: 'Nu este posibil să salvați aceste setări fără o adresă validă.' },
  { lang: 'tr', text: 'Geçerli bir adres olmadan bu ayarları kaydetmek mümkün değildir.' },
  { lang: 'ru', text: 'Невозможно сохранить эти настройки без указания действительного адреса.' },
  { lang: 'ja', text: '有効なアドレスを指定せずにこれらの設定を保存することはできません。' },
]

export interface SampleResult {
  lang: string
  got: string | null
  confidence: number
  ok: boolean
  text: string
}

export function selfTest(): SampleResult[] {
  return SAMPLES.map((s) => {
    const guess = detect(s.text)
    return { lang: s.lang, got: guess.detected, confidence: guess.confidence, ok: guess.detected === s.lang, text: s.text }
  })
}

export function formatGuess(text: string, g: LanguageGuess): string {
  const lines = [
    `ultrai18n lang  ${JSON.stringify(clip(text))}`,
    '',
    `  detected: ${g.detected ?? '(undecided)'}   confidence: ${g.confidence}   method: ${g.method}`,
    `  letters: ${g.letters}   bucket: ${g.bucket}${g.mixed ? '   mixed script' : ''}`,
  ]
  if (g.alternatives.length) {
    lines.push(
      `  alternatives: ${g.alternatives.map(([lang, score]) => `${lang} (${score})`).join(', ')}`,
    )
  }
  if (g.signals.length) {
    lines.push('', '  signals:')
    for (const s of g.signals) lines.push(`    ${s}`)
  }
  lines.push(
    '',
    // Undecided is an ANSWER. Refusing below the length threshold is the
    // detector working, so this exits 0 and says so rather than looking like a
    // failure.
    g.detected
      ? `VERDICT  ${g.detected} at ${g.confidence}`
      : 'VERDICT  undecided — too short or too ambiguous to answer, which is an answer',
  )
  return lines.join('\n')
}

export function formatProfile(p: LangProfile): string {
  const lines = [`ultrai18n lang  ${p.repo}`, '']
  lines.push(`  source language elected by scan: ${p.elected ?? '(none)'}`)
  lines.push(`  margin over the runner-up: ${p.margin}`)
  lines.push('')
  lines.push('  weighted by LETTERS, not by sites — forty one-word buttons must not outvote a page of prose')
  for (const l of p.languages) {
    lines.push(`    ${l.lang.padEnd(4)} ${String(l.sites).padStart(6)} site(s)  ${String(l.letters).padStart(8)} letters  ${(l.share * 100).toFixed(1)}%`)
  }
  lines.push(`    ${'—'.padEnd(4)} ${String(p.undecided).padStart(6)} site(s) the detector declined to answer for`)

  if (p.loudestFiles.length) {
    lines.push('', 'LOUDEST FILES')
    for (const f of p.loudestFiles) lines.push(`  ${f.lang}  ${String(f.letters).padStart(7)}  ${f.file}`)
  }

  lines.push(
    '',
    p.elected
      ? `VERDICT  ${p.elected} — ${p.languages.length} language(s) seen, margin ${p.margin}`
      : 'VERDICT  undecided — no language carried the vote',
  )
  return lines.join('\n')
}

export function formatSelfTest(results: SampleResult[]): string {
  const lines = ['ultrai18n lang --test', '']
  for (const r of results) {
    lines.push(`  ${r.ok ? '✓' : '✗'} ${r.lang.padEnd(4)} → ${(r.got ?? '(undecided)').padEnd(12)} ${r.confidence}`)
  }
  const failed = results.filter((r) => !r.ok)
  lines.push('', `  ${SUPPORTED.length} language(s) supported, ${results.length} sampled`)
  lines.push(
    '',
    failed.length
      ? `VERDICT  fail — ${failed.length} sample(s) misdetected: ${failed.map((f) => f.lang).join(', ')}`
      : `VERDICT  ok — every sampled language identified`,
  )
  return lines.join('\n')
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}

function clip(s: string, n = 70): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > n ? flat.slice(0, n - 1) + '…' : flat
}
