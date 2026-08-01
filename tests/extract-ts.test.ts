import { describe, it, expect, beforeAll } from 'vitest'
import { extractTs } from '../src/extract/ts'
import { prepareGrammars, parserForExt } from '../src/ast/parse'
import { OffsetMap } from '../src/vendor/text'
import type { RawSite } from '../src/extract/raw'

let parse: (src: string, file?: string) => { sites: RawSite[]; tokens: ReturnType<typeof extractTs>['tokens'] }

beforeAll(async () => {
  await prepareGrammars(['.tsx'])
  const parser = await parserForExt('.tsx')
  if (!parser) throw new Error('tsx grammar unavailable — the AST tier cannot be tested')
  parse = (src, file = 'a.tsx') => {
    const tree = parser.parse(src)!
    return extractTs(file, src, tree, new OffsetMap(src))
  }
})

const valuesOf = (sites: RawSite[]) => sites.map((s) => s.value)
const find = (sites: RawSite[], value: string) => sites.find((s) => s.value === value)

describe('what a symbol indexer misses', () => {
  it('finds JSX text', () => {
    // codeindex's STRING_NODE regex does not match `jsx_text`, so the visible
    // text of a React component is invisible to it.
    const { sites } = parse(`export const C = () => <p>Nothing to work on yet.</p>`)
    const site = find(sites, 'Nothing to work on yet.')
    expect(site).toBeDefined()
    expect(site!.kind).toBe('jsx-text')
    expect(site!.container.element).toBe('p')
  })

  it('ignores whitespace-only and letterless JSX text', () => {
    const { sites } = parse(`export const C = () => <ul>\n  <li>a</li>\n  {' — '}\n</ul>`)
    expect(sites.filter((s) => s.kind === 'jsx-text').map((s) => s.value)).toEqual(['a'])
  })

  it('finds interpolated template literals', () => {
    // codeindex requires kids.length === 0, so every interpolated template is
    // dropped — which is most of the aria-labels in a real app.
    const { sites } = parse('const s = `Move ${task.title} up`')
    const site = find(sites, 'Move {0} up')
    expect(site).toBeDefined()
    expect(site!.kind).toBe('template')
    expect(site!.holes).toHaveLength(1)
    expect(site!.holes[0]!.expr).toBe('task.title')
  })

  it('treats the whole template as one site, not one per fragment', () => {
    // "Move {0} up" -> "Monter {0}" deletes a static chunk outright. A
    // per-fragment site could not express that.
    const { sites } = parse('const s = `Move ${t} up`')
    expect(sites.filter((s) => s.kind === 'template')).toHaveLength(1)
    expect(valuesOf(sites)).not.toContain('Move ')
  })

  it('numbers multiple holes in source order', () => {
    const { sites } = parse('const s = `${done} of ${total} sessions`')
    expect(find(sites, '{0} of {1} sessions')).toBeDefined()
  })
})

describe('grammar holes — where the engine must refuse', () => {
  it('flags a plural rule baked into a ternary', () => {
    // French agrees the adjective too, so the target needs a DIFFERENT NUMBER
    // of agreement sites. No string substitution can produce that.
    const { sites } = parse(
      'const s = `${done} of ${est} estimated pomodoro${est > 1 ? "s" : ""}`',
    )
    const site = sites.find((s) => s.kind === 'template')!
    const grammarHoles = site.holes.filter((h) => h.grammar)
    expect(grammarHoles).toHaveLength(1)
    expect(grammarHoles[0]!.index).toBe(2)
  })

  it('does not flag an ordinary data hole', () => {
    const { sites } = parse('const s = `Move ${task.title} up`')
    expect(sites.find((s) => s.kind === 'template')!.holes.every((h) => !h.grammar)).toBe(true)
  })
})

describe('container semantics', () => {
  it('separates object keys from their values', () => {
    // basilico: `focus: 'Focus'` — the key is a persisted enum, the value is a
    // display label, one token apart.
    const { sites } = parse(`const MODE_LABEL = { focus: 'Focus', shortBreak: 'Short break' }`)
    expect(find(sites, 'Focus')!.container.isKey).toBe(false)
    expect(find(sites, 'Focus')!.container.siblingKeys).toEqual(['focus', 'shortBreak'])
  })

  it('marks module specifiers', () => {
    const { sites } = parse(`import { a } from './protocol'`)
    expect(find(sites, './protocol')!.container.moduleSpecifier).toBe(true)
  })

  it('marks literals that are compared rather than rendered', () => {
    const { sites } = parse(`if (msg.type === 'sync') { }`)
    expect(find(sites, 'sync')!.container.compared).toBe(true)
  })

  it('marks membership tests', () => {
    const { sites } = parse(`const ok = list.includes('done')`)
    expect(find(sites, 'done')!.container.compared).toBe(true)
  })

  it('marks storage keys', () => {
    const { sites } = parse(`localStorage.getItem('basilico:v1:app')`)
    expect(find(sites, 'basilico:v1:app')!.container.persisted).toBe(true)
  })

  it('marks schema enum members', () => {
    const { sites } = parse(`const s = z.enum(['active', 'done', 'archived'])`)
    expect(find(sites, 'done')!.container.enumMember).toBe(true)
  })

  it('marks type union members', () => {
    const { sites } = parse(`type Mode = 'focus' | 'shortBreak' | 'longBreak'`)
    expect(find(sites, 'focus')!.container.enumMember).toBe(true)
  })

  it('carries the attribute name, which is what drives classification', () => {
    const { sites } = parse(`const C = () => <button title="Close" className="btn">x</button>`)
    expect(find(sites, 'Close')!.container.attrName).toBe('title')
    expect(find(sites, 'btn')!.container.attrName).toBe('className')
  })

  it('finds text inside an expression attribute', () => {
    const { sites } = parse('const C = () => <li aria-label={`Move ${t} up`}>x</li>')
    const site = find(sites, 'Move {0} up')!
    expect(site.container.attrName).toBe('aria-label')
    expect(site.kind).toBe('attr')
  })

  it('knows it is in a test file', () => {
    const { sites } = parse(`expect(x).toBe('Focus finished')`, 'e2e/extension.spec.ts')
    expect(find(sites, 'Focus finished')!.container.inTest).toBe(true)
  })
})

describe('comments', () => {
  it('extracts line and block comments with markers stripped', () => {
    const { sites } = parse(`// un commentaire\n/* un autre */\nconst a = 1`)
    const comments = sites.filter((s) => s.kind === 'comment')
    expect(comments.map((c) => c.value)).toEqual(['un commentaire', 'un autre'])
  })

  it('strips JSDoc leading asterisks', () => {
    const { sites } = parse(`/**\n * Le thème vit ici.\n * Deuxième ligne.\n */\nconst a = 1`)
    expect(sites.find((s) => s.kind === 'comment')!.value).toBe('Le thème vit ici.\nDeuxième ligne.')
  })
})

describe('a JSX attribute expression is descended into, not scanned', () => {
  // It used to run its OWN walk over the value looking for a string or a
  // template, then prune the outer one — so anything else inside `onAdopt={…}`
  // never reached the main visitor. `sites --audit` found a three-line comment
  // vanishing on a real repository; underneath it was the far worse one.
  const attr = (src: string) => parse(src).sites

  it('finds a rendered JSX label inside an attribute expression', () => {
    // `claimRatio` was 1.0 for the file this came from. Real UI copy, silently
    // absent, in a file asserting it had accounted for every byte.
    const found = attr('const A = () => <Table empty={<p>Aucun projet pour le moment</p>} />')
    expect(found.map((s) => s.value)).toContain('Aucun projet pour le moment')
    expect(found.find((s) => s.value.startsWith('Aucun'))!.kind).toBe('jsx-text')
  })

  it('finds a comment inside an attribute expression', () => {
    const found = attr('const A = () => <C onGo={\n  // Attend les données\n  ready ? go : undefined\n} />')
    expect(found.some((s) => s.kind === 'comment' && s.value === 'Attend les données')).toBe(true)
  })

  it('still reads a plain attribute string as an attribute', () => {
    // `attr` is not cosmetic: `syntaxFor` reads it, and a JSX attribute escapes
    // its value as entities rather than with backslashes.
    const site = attr('const A = () => <C label="Liste des projets" />').find((s) => s.value.startsWith('Liste'))!
    expect(site.kind).toBe('attr')
    expect(site.container.attrName).toBe('label')
  })

  it('still reads a string inside an expression as that attribute\'s', () => {
    const site = attr('const A = () => <C title={cond ? "Ouvrir la fiche" : ""} />').find((s) => s.value.startsWith('Ouvrir'))!
    expect(site.kind).toBe('attr')
    expect(site.container.attrName).toBe('title')
  })

  it('still reads a template inside an expression as that attribute\'s', () => {
    const site = attr('const A = () => <C hint={`Reste ${n}`} />').find((s) => s.value.startsWith('Reste'))!
    expect(site.kind).toBe('attr')
    expect(site.container.attrName).toBe('hint')
    expect(site.holes).toHaveLength(1)
  })

  it('keeps a nested element\'s own attribute distinct from its parent\'s', () => {
    const found = attr('const A = () => <C render={(x) => <span title="Ouvrir">{x}</span>} label="Liste" />')
    const byValue = new Map(found.map((s) => [s.value, s.container.attrName]))
    expect(byValue.get('Ouvrir')).toBe('title')
    expect(byValue.get('Liste')).toBe('label')
  })
})

describe('byte offsets', () => {
  it('reports BYTE spans even though tree-sitter indexes UTF-16 units', () => {
    // Measured, not assumed: tree-sitter gives endIndex 29 for this source
    // while it is 31 bytes. Writing at 29 would corrupt the file.
    const src = `const a = 'Données effacées.'`
    const { sites } = parse(src)
    const site = find(sites, 'Données effacées.')!
    const buf = Buffer.from(src, 'utf8')
    expect(buf.subarray(site.span.start, site.span.end).toString('utf8')).toBe("'Données effacées.'")
    expect(buf.subarray(site.valueSpan.start, site.valueSpan.end).toString('utf8')).toBe(
      'Données effacées.',
    )
  })

  it('gives spans that round-trip for JSX text too', () => {
    const src = `const C = () => <p>Pendant les focus uniquement. Consomme de la batterie.</p>`
    const { sites } = parse(src)
    const site = sites.find((s) => s.kind === 'jsx-text')!
    const buf = Buffer.from(src, 'utf8')
    expect(buf.subarray(site.span.start, site.span.end).toString('utf8')).toBe(site.value)
  })

  it('reports 1-based line and column', () => {
    const { sites } = parse(`const a = 1\nconst b = 'hi'`)
    expect(find(sites, 'hi')!.line).toBe(2)
  })
})

describe('escapes', () => {
  it('decodes escape sequences into the value', () => {
    const { sites } = parse(`const a = 'Oui, c\\'est fini'`)
    const site = find(sites, "Oui, c'est fini")!
    expect(site.escapes).toBe(true)
    expect(site.raw).toBe(`'Oui, c\\'est fini'`)
  })

  it('decodes unicode escapes, so detection sees real characters', () => {
    const { sites } = parse(`const a = 'Donn\\u00e9es'`)
    expect(find(sites, 'Données')).toBeDefined()
  })
})

describe('anchor paths', () => {
  it('names the enclosing declaration and object key', () => {
    const { sites } = parse(`const MODE_LABEL = { focus: 'Focus' }`)
    expect(find(sites, 'Focus')!.path).toBe('MODE_LABEL/focus')
  })

  it('does not contain the value', () => {
    const { sites } = parse(`const t = { a: 'Yes, erase it all' }`)
    expect(find(sites, 'Yes, erase it all')!.path).not.toContain('erase')
  })

  it('indexes repeated JSX siblings', () => {
    const { sites } = parse(`const C = () => <ul><li>one</li><li>two</li></ul>`)
    const paths = sites.filter((s) => s.kind === 'jsx-text').map((s) => s.path)
    expect(paths[0]).toContain('li[0]')
    expect(paths[1]).toContain('li[1]')
  })
})

describe('token indexes', () => {
  it('collects enum, compared and persisted values repo-wide', () => {
    const { tokens } = parse(
      `type S = 'active' | 'done'\nif (x === 'done') {}\nlocalStorage.setItem('k:1', v)`,
    )
    expect(tokens.enums.has('done')).toBe(true)
    expect(tokens.compared.has('done')).toBe(true)
    expect(tokens.persisted.has('k:1')).toBe(true)
  })
})
