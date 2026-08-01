// The four readers TODO §1 and §3 asked for, and the one sniff.
//
// Each of these formats was previously surfaced as `unclassified` and refused
// by G2 — honest, and useless to somebody trying to translate a repository that
// uses gettext. The assertions below are about STRUCTURE rather than counts:
// what makes a plural readable is which key owns which value, and every one of
// these formats expresses that differently.
import { describe, it, expect } from 'vitest'
import { OffsetMap } from '../src/vendor/text'
import { extractPo } from '../src/extract/po'
import { extractToml } from '../src/extract/toml'
import { extractFtl } from '../src/extract/ftl'
import { extractDockerfile, isDockerfile } from '../src/extract/dockerfile'
import { extractHtml, isQtTranslation } from '../src/extract/html'
import { parseFluent, scanFluentPattern, serializeSelect } from '../src/plural/fluent'

const paths = (r: { sites: { path: string }[] }) => r.sites.map((s) => s.path)
const byPath = (r: { sites: { path: string; value: string }[] }, p: string) =>
  r.sites.find((s) => s.path === p)?.value

function read<T>(text: string, f: (file: string, text: string, map: OffsetMap) => T): T {
  return f('x', text, new OffsetMap(text))
}

describe('gettext .po', () => {
  const PO = `# Traduction française
#. Shown in the inbox header
#: src/app.py:12
#, fuzzy
msgctxt "inbox"
msgid "one unread message"
msgid_plural "%d unread messages"
msgstr[0] "un message non lu"
msgstr[1] "%d messages non lus"

#~ msgid "removed long ago"
#~ msgstr "supprimé il y a longtemps"
`

  it('anchors on the entry identity, not on its position in the file', () => {
    // `msgmerge` regenerates and reorders these files constantly. A positional
    // anchor would drift on every regeneration and every pinned exception would
    // quietly stop applying.
    const r = read(PO, extractPo)
    // EOT between context and id, which is gettext's own context glue.
    const base = '/inbox\u0004one unread message'
    expect(paths(r)).toContain(`${base}/msgstr[0]`)
    expect(paths(r)).toContain(`${base}/msgid_plural`)
  })

  it('reads a msgctxt as a key, so the classifier settles it structurally', () => {
    const r = read(PO, extractPo)
    const ctx = r.sites.find((s) => s.path.endsWith('/msgctxt'))
    expect(ctx?.kind).toBe('key')
    expect(ctx?.container.isKey).toBe(true)
  })

  it('treats an obsolete entry as the format declaring it dead', () => {
    // `#~` is gettext's own machine-readable exception, exactly like Android's
    // `translatable="false"` — so it reuses the mechanism `classify` already
    // honours before any rule, rather than inventing a second one.
    const r = read(PO, extractPo)
    const dead = r.sites.filter((s) => s.path.startsWith('/~obsolete'))
    expect(dead.length).toBeGreaterThan(0)
    expect(dead.every((s) => s.container.untranslatable === true)).toBe(true)
  })

  it('records the fuzzy flag rather than acting on it', () => {
    const r = read(PO, extractPo)
    expect(r.fuzzy.length).toBe(1)
  })

  it('captures Plural-Forms verbatim and evaluates nothing', () => {
    // The honest limit, and the reason the gettext dialect is `cldr: false`.
    const r = read(
      'msgid ""\nmsgstr ""\n"Plural-Forms: nplurals=3; plural=(n==1) ? 0 : 1;\\n"\n',
      extractPo,
    )
    expect(r.pluralForms).toBe('nplurals=3; plural=(n==1) ? 0 : 1;')
    expect(r.sites).toHaveLength(0)
  })

  it('reads a source reference and never emits one', () => {
    const r = read(PO, extractPo)
    expect(r.sites.some((s) => s.value.includes('src/app.py'))).toBe(false)
  })

  it('claims every byte, which is what lets a sweep contradict the engine', () => {
    const r = read(PO, extractPo)
    expect(r.claimedBytes).toBe(Buffer.byteLength(PO, 'utf8'))
    expect(r.complete).toBe(true)
  })

  it('joins a continuation run into one site', () => {
    // Three quoted lines are one sentence. Emitting three sites would hand a
    // translator three fragments of one decision.
    const r = read('msgid ""\n"Une phrase "\n"coupée en deux."\n', extractPo)
    expect(byPath(r, '/Une phrase coupée en deux./msgid')).toBe('Une phrase coupée en deux.')
  })
})

describe('TOML', () => {
  const TOML = `# Le manifeste
[package]
name = "atelier"
description = "Le noyau de l'atelier"
keywords = ["publication", "editeur"]
edition = "2021"

[[bin]]
name = "atelier-cli"

[tool.poetry]
readme = 'README.md'
`

  it('emits JSON Pointers, so a pointer rule fires unchanged', () => {
    const r = read(TOML, extractToml)
    expect(byPath(r, '/package/description')).toBe("Le noyau de l'atelier")
    expect(byPath(r, '/package/keywords/0')).toBe('publication')
  })

  it('numbers an array-of-table so two instances are two paths', () => {
    const r = read(TOML, extractToml)
    expect(paths(r)).toContain('/bin/0/name')
  })

  it('splits a dotted table header', () => {
    const r = read(TOML, extractToml)
    expect(paths(r)).toContain('/tool/poetry/readme')
  })

  it('claims every byte of a file it read end to end', () => {
    const r = read(TOML, extractToml)
    expect(r.claimedBytes).toBe(Buffer.byteLength(TOML, 'utf8'))
  })

  it('reads a multi-line basic string as one value', () => {
    const r = read('[p]\ndesc = """\nDeux lignes\nde prose\n"""\n', extractToml)
    expect(byPath(r, '/p/desc')).toContain('Deux lignes')
  })
})

describe('Fluent', () => {
  const FTL = `### Le catalogue
# Un commentaire
unread-count = { $count ->
    [one] One unread message
   *[other] { $count } unread messages
}
greeting = Bonjour
    .title = Une infobulle
`

  it('emits one site per pattern, selector included', () => {
    // The whole select stays in one value and the PRIMITIVE parses it, exactly
    // as an ICU message living in a JSON string is one site. A variant is not
    // independently translatable: the arity of the set changes with the target.
    const r = read(FTL, extractFtl)
    expect(byPath(r, '/unread-count')).toContain('*[other]')
    expect(byPath(r, '/greeting')).toBe('Bonjour')
    expect(paths(r)).toContain('/greeting/.title')
  })

  it('never puts a placeable in holes', () => {
    // `apply` splices a hole back as `${expr}` — JavaScript template syntax —
    // so a Fluent `{ $userName }` recorded as a hole would be written out as a
    // literal `${$userName}`.
    const r = read(FTL, extractFtl)
    expect(r.sites.every((s) => s.holes.length === 0)).toBe(true)
  })

  it('reads a selector whose closing brace sits at column zero', () => {
    // The convention in every real `.ftl`, and the one that truncated the value
    // one character short of balanced: the scanner then found no closing brace,
    // reported `ok: false`, and every Fluent plural went unclaimed while the
    // file itself looked perfectly well read.
    const { entries } = parseFluent(FTL)
    const scan = scanFluentPattern(entries.find((e) => e.id === 'unread-count')!.value!.text)
    expect(scan.ok).toBe(true)
    expect(scan.selects[0]!.variants.map((v) => v.key)).toEqual(['one', 'other'])
    expect(scan.selects[0]!.variants[1]!.default).toBe(true)
  })

  it('rebuilds a select with more variants than it had', () => {
    // The reason the row may declare `write: replace` at all.
    const { entries } = parseFluent(FTL)
    const scan = scanFluentPattern(entries.find((e) => e.id === 'unread-count')!.value!.text)
    const out = serializeSelect(
      scan.selects[0]!,
      { one: 'одно', few: 'мало', many: 'много', other: 'много' },
      ['one', 'few', 'many', 'other'],
    )
    for (const c of ['one', 'few', 'many', 'other']) expect(out).toContain(`[${c}]`)
    // Fluent requires exactly one default variant; a select without one is a
    // syntax error, not a degraded rendering.
    expect(out.match(/\*\[/g)).toHaveLength(1)
  })
})

describe('Dockerfile', () => {
  const DOCKER = `# syntax=docker/dockerfile:1
# Le conteneur de production
FROM node:22-alpine
RUN apt-get install -y build-essential ca-certificates
LABEL org.opencontainers.image.title="Atelier" \\
      org.opencontainers.image.description="Un atelier de publication"
ENV APP_NAME "Atelier de publication"
`

  it('recognises the family of names', () => {
    expect(isDockerfile('Dockerfile')).toBe(true)
    expect(isDockerfile('ops/Dockerfile.prod')).toBe(true)
    expect(isDockerfile('web.dockerfile')).toBe(true)
    expect(isDockerfile('README.md')).toBe(false)
  })

  it('gives docker.label the key it always matched on', () => {
    // The rule was never wrong. The prose extractor's key was `p[0]`, so
    // nothing had ever handed it a key to match.
    const r = read(DOCKER, extractDockerfile)
    expect(byPath(r, '/LABEL/org.opencontainers.image.description')).toBe('Un atelier de publication')
  })

  it('reads an instruction and judges it non-textual rather than emitting it', () => {
    const r = read(DOCKER, extractDockerfile)
    expect(r.sites.some((s) => s.value.includes('apt-get'))).toBe(false)
    expect(r.sites.some((s) => s.value.includes('node:22-alpine'))).toBe(false)
    expect(r.claimedBytes).toBe(Buffer.byteLength(DOCKER, 'utf8'))
  })

  it('skips a parser directive and keeps a human comment', () => {
    const r = read(DOCKER, extractDockerfile)
    expect(r.sites.some((s) => s.value.includes('docker/dockerfile:1'))).toBe(false)
    expect(r.sites.some((s) => s.value === 'Le conteneur de production')).toBe(true)
  })
})

describe('plist and Qt, through the markup extractor', () => {
  const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>task_count</key>
  <dict>
    <key>tasks</key>
    <dict>
      <key>one</key>
      <string>One task remaining</string>
      <key>other</key>
      <string>%d tasks remaining</string>
    </dict>
  </dict>
</dict>
</plist>
`

  const QT = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE TS>
<TS version="2.1" language="fr_FR">
<context><name>MainWindow</name>
  <message numerus="yes"><source>%n task</source>
    <translation><numerusform>%n tâche</numerusform><numerusform>%n tâches</numerusform></translation>
  </message>
  <message numerus="yes"><source>%n file</source>
    <translation><numerusform>%n fichier</numerusform><numerusform>%n fichiers</numerusform></translation>
  </message>
</context>
</TS>
`

  it('gives a plist dict a JSON Pointer, not a document-order index', () => {
    // `string/text[7]` says where a value sits and nothing about which key owns
    // it — and which key owns it is exactly what an Apple plural is made of.
    const r = read(PLIST, extractHtml)
    // The <key> and its value share a pointer, exactly as a JSON key shares one
    // with its own value; `disambiguatePaths` suffixes the second at scan time.
    // Asserting both sides is the stronger claim anyway: the key is emitted as
    // a KEY, so the classifier settles it structurally rather than guessing at
    // the word "one".
    const at = (p: string) => r.sites.filter((s) => s.path === p)
    expect(at('/task_count/tasks/one').map((s) => s.value)).toEqual(['one', 'One task remaining'])
    expect(at('/task_count/tasks/one')[0]!.kind).toBe('key')
    expect(at('/task_count/tasks/other').map((s) => s.value)).toEqual(['other', '%d tasks remaining'])
  })

  it('sniffs Qt at the head of the file only', () => {
    expect(isQtTranslation(QT)).toBe(true)
    // A TypeScript module that merely contains the string must not be routed to
    // the markup extractor.
    expect(isQtTranslation('const s = "<TS version=\\"2.1\\">"\n')).toBe(false)
  })

  it('makes a second Qt message a second family, not four forms of one', () => {
    // The failure a flat `numerusform/text[n]` counter would have produced
    // silently: one shared base for every numerusform in the catalog.
    const r = read(QT, extractHtml)
    expect(paths(r)).toContain('message[0]/numerusform[0]')
    expect(paths(r)).toContain('message[0]/numerusform[1]')
    expect(paths(r)).toContain('message[1]/numerusform[0]')
  })

  it('leaves ordinary markup paths exactly as they were', () => {
    // Everything above is gated on the document's first element, and this is
    // the assertion that keeps it that way.
    const r = read(
      '<html><head><title>Atelier</title><meta name="description" content="Un atelier"></head>' +
        '<body><p>Bonjour le monde</p><img alt="Une capture"></body></html>',
      extractHtml,
    )
    expect(paths(r)).toContain('title/text[0]')
    expect(paths(r)).toContain('meta[description]@content')
    expect(r.sites.some((s) => s.path.startsWith('img@alt'))).toBe(true)
  })
})
