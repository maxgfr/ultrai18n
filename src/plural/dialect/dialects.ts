// The shipped dialect catalog: how plurals are KNOWN to be written down.
//
// Every row here was a hand-written detector function until it wasn't. What is
// left of `detectKeySuffix` and `detectSiblingObject` after the primitives took
// the algorithm is `separators`, `tokens` and `minForms` — three fields — and
// that is the whole argument for the rewrite.
//
// Each row cites documentation for the same reason a catalog rule does: a claim
// that an arrangement means a plural, with nothing behind it, is a guess. A
// project adds its own rows in `.ultrai18n/dialects.json`, validated against the
// same rules and merged over these.
import type { Category } from '../cldr'
import type { PluralDialect } from './types'

/**
 * Native quantity tokens, mapped onto CLDR.
 *
 * Numeric tokens are absent on purpose: they collide with array indices, and
 * guessing wrong invents a form nobody wrote. `plural` meaning `other` is the
 * i18next v20 spelling and still extremely common.
 */
const CLDR_TOKENS: Record<string, Category> = {
  zero: 'zero',
  one: 'one',
  two: 'two',
  few: 'few',
  many: 'many',
  other: 'other',
}

const KEY_SUFFIX_TOKENS: Record<string, Category> = {
  ...CLDR_TOKENS,
  singular: 'one',
  plural: 'other',
}

/** Where a new sibling key can be written without inventing syntax. */
const INSERTABLE_BUNDLES = ['**/*.json', '**/*.jsonc', '**/*.json5', '**/*.arb', '**/*.yml', '**/*.yaml']

export const DIALECTS: PluralDialect[] = [
  {
    id: 'icu.plural-argument',
    ecosystem: 'icu',
    title: 'ICU MessageFormat plural argument',
    docs: 'https://unicode-org.github.io/icu/userguide/format_parse/messages/',
    primitive: 'icu',
    precedence: 10,
    // An ICU argument attests to itself and can appear anywhere — in a bundle, in
    // a `defineMessages` call, in an `.arb`. Requiring a catalog would lose every
    // message declared in code.
    where: {},
    evidence: { mode: 'intrinsic' },
    read: { primitive: 'icu', ordinals: true },
    write: { mode: 'replace' },
    cldr: true,
    shape: 'inline-select',
    declaredBy: 'shipped',
    notes:
      'react-intl, FormatJS, ARB, Android ICU, Java. The engine keeps the skeleton and hands the translator only the branch bodies, so a target needing four branches where the source has two costs nothing structural.',
  },

  {
    id: 'android.plurals-item',
    ecosystem: 'android',
    title: 'Quantity attribute on a resource item',
    docs: 'https://developer.android.com/guide/topics/resources/string-resource#Plurals',
    primitive: 'path-part',
    precedence: 20,
    // `<plurals><item quantity="one">` cannot occur by accident, and the markup
    // extractor produces this path shape only for that element.
    where: {},
    evidence: { mode: 'intrinsic' },
    read: {
      primitive: 'path-part',
      split: { kind: 'path-regex', re: /^(.*plurals\[[^\]]*\])\/item\[([a-z]+)\]$/ },
      tokens: CLDR_TOKENS,
      selectorTemplate: 'quantity="{token}"',
    },
    write: {
      mode: 'code-edit',
      blocked:
        'adding an <item quantity> element is a markup edit; the engine reports the missing forms rather than writing XML it did not parse structurally',
    },
    cldr: true,
    shape: 'attr-quantity',
    declaredBy: 'shipped',
    notes: 'Android `<plurals>`, and plists shaped the same way.',
  },

  {
    id: 'i18next.key-suffix',
    ecosystem: 'i18n',
    title: 'Category appended to the key',
    docs: 'https://www.i18next.com/translation-function/plurals',
    primitive: 'path-part',
    precedence: 30,
    where: { bundleOnly: true },
    // Catalog strength, not `declared`, and deliberately: this arrangement is
    // shared by i18next, Rails, Symfony and a great deal of hand-rolled code, so
    // demanding a named dependency would refuse the hand-rolled majority. What a
    // dependency buys is PRECEDENCE and a citation, not permission.
    evidence: { mode: 'catalog', prefer: { dependency: ['i18next', 'react-i18next', 'next-i18next'] } },
    read: {
      primitive: 'path-part',
      split: { kind: 'leaf-suffix', separators: ['_', '.'] },
      tokens: KEY_SUFFIX_TOKENS,
      ordinalInfix: ['ordinal'],
    },
    write: {
      mode: 'insert',
      keyTemplate: '{base}{sep}{category}',
      insertableWhen: { file: INSERTABLE_BUNDLES },
      blocked:
        'a new form here means a new key, and insertion is only supported for JSON and YAML locale bundles',
    },
    cldr: true,
    shape: 'key-suffix',
    declaredBy: 'shipped',
    notes:
      'i18next `key_one`, Rails `key.one`, and any hand-rolled `_singular`/`_plural`. Numeric suffixes (`key_0`) are deliberately NOT read as categories: they collide with array indices.',
  },

  {
    id: 'rails.sibling-object',
    ecosystem: 'i18n',
    title: 'Categories as sibling keys of one object',
    docs: 'https://guides.rubyonrails.org/i18n.html#pluralization',
    primitive: 'path-part',
    precedence: 40,
    where: { bundleOnly: true },
    evidence: { mode: 'catalog', prefer: { dependency: ['rails', 'i18n', 'vue-i18n'] } },
    read: {
      primitive: 'path-part',
      split: { kind: 'leaf-is-token' },
      tokens: CLDR_TOKENS,
      // Two category-named siblings is the signature. One is just a key called
      // `other`, which is a word people use for other things.
      minForms: 2,
    },
    write: {
      mode: 'insert',
      keyTemplate: '{category}',
      insertableWhen: { file: INSERTABLE_BUNDLES },
      blocked:
        'a new form here means a new key, and insertion is only supported for JSON and YAML locale bundles',
    },
    cldr: true,
    shape: 'sibling-object',
    declaredBy: 'shipped',
    notes: 'Rails, vue-i18n object form, Flutter.',
  },

  {
    id: 'vue-i18n.pipe-positional',
    ecosystem: 'vue',
    title: 'Forms separated by a pipe',
    docs: 'https://vue-i18n.intlify.dev/guide/essentials/pluralization',
    primitive: 'value-split',
    precedence: 50,
    where: { bundleOnly: true },
    evidence: { mode: 'catalog', prefer: { dependency: ['vue-i18n', '@intlify/core'] } },
    read: {
      primitive: 'value-split',
      delimiters: ['|'],
      order: { 2: ['one', 'other'], 3: ['zero', 'one', 'other'] },
      requiresCounting: true,
    },
    write: { mode: 'replace', join: ' | ' },
    // Positional, not CLDR. Handing this four Russian categories would produce a
    // string vue-i18n cannot index, so the target keeps the source's arity.
    cldr: false,
    shape: 'delimited',
    declaredBy: 'shipped',
    notes:
      'vue-i18n. Positional rather than named: two parts are one|other, three are zero|one|other. Only read inside a locale bundle, and only when a part carries a number — otherwise "Save | Cancel" would become a plural family.',
  },

  {
    id: 'apple.xcstrings-variations',
    ecosystem: 'apple',
    title: 'String Catalog plural variations',
    docs: 'https://developer.apple.com/documentation/xcode/localizing-and-varying-text-with-a-string-catalog',
    primitive: 'path-part',
    precedence: 25,
    where: { file: ['**/*.xcstrings'] },
    // A `variations/plural/<category>/stringUnit/value` path cannot occur by
    // accident: it is Xcode's own schema, and nothing else writes it.
    evidence: { mode: 'intrinsic' },
    read: {
      primitive: 'path-part',
      split: { kind: 'path-regex', re: /^(.*\/variations\/plural)\/([a-z]+)\/stringUnit\/value$/ },
      tokens: CLDR_TOKENS,
    },
    write: {
      mode: 'code-edit',
      blocked:
        'a new form here means a new `stringUnit` object inside `variations/plural`, and insertion writes a scalar sibling rather than a nested object',
    },
    cldr: true,
    // None of the five arrangements: the category is a path segment three levels
    // above the value. Calling it a sibling-object would be a lie of convenience.
    shape: 'other',
    declaredBy: 'shipped',
    notes:
      'Xcode 15 String Catalogs. Readable only because `.xcstrings` is registered as JSON — without that the file sweeps and the structure is gone.',
  },

  {
    id: 'polyglot.quad-pipe',
    ecosystem: 'i18n',
    title: 'Polyglot.js pipe-separated plural',
    docs: 'https://airbnb.io/polyglot.js/#pluralization',
    primitive: 'value-split',
    precedence: 55,
    where: { bundleOnly: true },
    // `declared`, unlike its vue-i18n neighbour, and for a concrete reason: four
    // consecutive pipes are rare but not impossible in ordinary text, and a
    // repository that has never heard of Polyglot should not have a string eaten
    // by a runtime it does not use.
    evidence: { mode: 'declared', dependency: ['node-polyglot', 'polyglot'] },
    read: {
      primitive: 'value-split',
      // Longest first is enforced by the primitive, so this row cannot be
      // shadowed by vue-i18n's single pipe.
      delimiters: ['||||'],
      order: { 2: ['one', 'other'] },
      requiresCounting: true,
    },
    write: { mode: 'replace', join: ' |||| ' },
    cldr: false,
    shape: 'delimited',
    declaredBy: 'shipped',
    notes:
      'Polyglot uses `||||` and a `smart_count` interpolation. Positional like vue-i18n, so the target keeps the source arity.',
  },
]

export const DIALECTS_BY_ID = new Map(DIALECTS.map((d) => [d.id, d]))
