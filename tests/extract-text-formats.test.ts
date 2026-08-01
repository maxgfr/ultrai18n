import { describe, it, expect } from 'vitest'
import { extractMarkdown, slugify } from '../src/extract/markdown'
import { extractCss } from '../src/extract/css'
import { extractHtml } from '../src/extract/html'
import { OffsetMap } from '../src/vendor/text'

const md = (src: string, file = 'README.md') => extractMarkdown(file, src, new OffsetMap(src))
const css = (src: string, file = 'index.css') => extractCss(file, src, new OffsetMap(src))
const html = (src: string, file = 'index.html') => extractHtml(file, src, new OffsetMap(src))
const values = (r: { sites: { value: string }[] }) => r.sites.map((s) => s.value)

describe('markdown', () => {
  it('extracts headings, paragraphs and list items', () => {
    const out = values(md('# Contribuer\n\nMerci d\'y jeter un œil.\n\n- Premier point\n- Second point\n'))
    expect(out).toContain('Contribuer')
    expect(out).toContain("Merci d'y jeter un œil.")
    expect(out).toContain('Premier point')
    expect(out).toContain('Second point')
  })

  it('does not extract fenced code', () => {
    const out = values(md('Texte avant.\n\n```js\nconst notProse = "hello world"\n```\n\nTexte après.\n'))
    expect(out).toContain('Texte avant.')
    expect(out).toContain('Texte après.')
    expect(out.join(' ')).not.toContain('notProse')
  })

  it('keeps link text but drops the URL', () => {
    const out = values(md('Voir [la documentation](https://example.com/docs) pour la suite.\n'))
    expect(out.join(' ')).toContain('la documentation')
    expect(out.join(' ')).not.toContain('example.com')
  })

  it('extracts table cells individually', () => {
    const out = values(md('| Colonne une | Colonne deux |\n| --- | --- |\n| Valeur ici | Autre valeur |\n'))
    expect(out).toContain('Colonne une')
    expect(out).toContain('Autre valeur')
  })

  it('anchors a heading by its level, which is what a slug is derived FROM', () => {
    // The extractor used to return a parallel `headings` array carrying the
    // same slugs `check` derives from the sites themselves. Nothing read it,
    // and two derivations of one fact drift. The site's anchor is the fact.
    const site = md('## Démarrer le projet\n').sites[0]!
    expect(site.path).toMatch(/^h2\[/)
    expect(slugify(site.value)).toBe('démarrer-le-projet')
    expect(slugify('Getting Started!')).toBe('getting-started')
  })

  it('reports byte spans that round-trip', () => {
    const src = '# Réglages avancés\n'
    const site = md(src).sites[0]!
    const buf = Buffer.from(src, 'utf8')
    expect(buf.subarray(site.span.start, site.span.end).toString('utf8')).toBe('Réglages avancés')
  })

  it('reads one region of a host file with absolute offsets', () => {
    // Markdown nested inside a YAML block scalar shares one coordinate system
    // with its host, or the patcher writes at the wrong place in the right file.
    //
    // Read as a RANGE over the host text rather than as a dedented string plus
    // a base offset. That distinction is the whole point: the body is indented,
    // so every line past the first has lost its own indentation as well, and no
    // single constant can put those offsets back.
    const src = 'jobs:\n  release:\n    body: |\n      # Titre\n      Deuxième ligne ici.\n'
    const from = src.indexOf('      # Titre')
    const { sites } = extractMarkdown('w.yml', src, new OffsetMap(src), { from, to: src.length })
    const buf = Buffer.from(src, 'utf8')
    expect(sites.map((s) => s.value)).toEqual(['Titre', 'Deuxième ligne ici.'])
    for (const site of sites) {
      expect(buf.subarray(site.span.start, site.span.end).toString('utf8')).toBe(site.value)
    }
  })

  it('reads nothing outside the region it was given', () => {
    const src = 'Avant la région.\n\nDans la région.\n'
    const from = src.indexOf('Dans')
    const { sites } = extractMarkdown('a.md', src, new OffsetMap(src), { from, to: src.length })
    expect(sites.map((s) => s.value)).toEqual(['Dans la région.'])
  })
})

describe('css', () => {
  it('finds comments — the residue a whole-repo pass leaves behind', () => {
    // This is the exact shape of what two human translation passes missed.
    const out = values(css('/* Le thème vit ici, en CSS. */\n.a { color: red }\n'))
    expect(out).toEqual(['Le thème vit ici, en CSS.'])
  })

  it('strips JSDoc-style leading asterisks from block comments', () => {
    const out = values(css('/*\n * Première ligne.\n * Deuxième ligne.\n */\n'))
    expect(out[0]).toBe('Première ligne.\nDeuxième ligne.')
  })

  it('extracts quoted content values', () => {
    expect(values(css('.a::after { content: "Nouveau" }'))).toContain('Nouveau')
  })

  it('ignores comments with no words, and selectors entirely', () => {
    expect(values(css('/* --- */\n.btn-primary { color: red }\n'))).toEqual([])
  })

  it('collects class names for the identifier vocabulary', () => {
    const { identifiers } = css('.btn-primary { --color-ink: red }')
    expect(identifiers.has('btn-primary')).toBe(true)
    expect(identifiers.has('--color-ink')).toBe(true)
  })
})

describe('html', () => {
  it('discriminates meta by its own name, not by the content attribute', () => {
    // `viewport` reads like prose and is a layout directive. Emitting it with
    // attrName `content` would leave the catalog nothing to discriminate on.
    const r = html(
      '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
        '<meta name="description" content="Un minuteur de focus.">',
    )
    const byAttr = Object.fromEntries(r.sites.map((s) => [s.container.attrName, s.value]))
    expect(byAttr['viewport']).toBe('width=device-width, initial-scale=1')
    expect(byAttr['description']).toBe('Un minuteur de focus.')
  })

  it('reads OpenGraph properties', () => {
    const r = html('<meta property="og:description" content="Une description sociale.">')
    expect(r.sites[0]!.container.attrName).toBe('og:description')
  })

  it('extracts title text and text-bearing attributes', () => {
    const out = values(html('<title>basilico — minuteur</title><img alt="Capture des réglages">'))
    expect(out).toContain('basilico — minuteur')
    expect(out).toContain('Capture des réglages')
  })

  it('ignores class, id and href', () => {
    const out = values(html('<a class="btn" id="go" href="/reglages">Aller aux réglages</a>'))
    expect(out).toEqual(['Aller aux réglages'])
  })

  it('never reads script or style bodies as prose', () => {
    const out = values(html('<script>const s = "pas de la prose"</script><style>.a{color:red}</style><p>Vraie prose</p>'))
    expect(out).toEqual(['Vraie prose'])
  })

  it('extracts SVG accessible names, which is why SVG is not treated as an image', () => {
    const out = values(html('<svg><title>Fermer</title><desc>Bouton de fermeture</desc><path d="M0 0"/></svg>', 'icon.svg'))
    expect(out).toContain('Fermer')
    expect(out).toContain('Bouton de fermeture')
  })

  it('survives template syntax it does not understand', () => {
    // A parser that rejects these reads zero Vue, Svelte, Astro or ERB files.
    const out = values(html('<p>Bonjour {{ user.name }}, bienvenue</p>', 'App.vue'))
    expect(out.join(' ')).toContain('Bonjour')
  })

  it('reads bound attribute forms', () => {
    const r = html('<button :title="x" aria-label="Fermer la fenêtre">x</button>', 'App.vue')
    expect(values(r)).toContain('Fermer la fenêtre')
  })

  it('round-trips byte spans on accented attribute values', () => {
    const src = '<img alt="Capture des réglages">'
    const site = html(src).sites[0]!
    const buf = Buffer.from(src, 'utf8')
    expect(buf.subarray(site.valueSpan.start, site.valueSpan.end).toString('utf8')).toBe(
      'Capture des réglages',
    )
  })
})
