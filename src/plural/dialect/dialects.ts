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

/**
 * Numeric token → categories, keyed by how many forms the family has.
 *
 * These names are LABELS FOR AN ORDINAL POSITION and never claims about
 * grammar. `Category` is a closed CLDR vocabulary, so a position has to borrow
 * a CLDR name in order to be named at all; `cldr: false` on every row using
 * this table is what stops the borrowing from becoming a claim, and such a
 * family is never measured for completeness.
 *
 * Shared by gettext and Qt, which is the point: two runtimes, one table, no
 * detector for either.
 */
const POSITIONAL_ORDER: Record<number, Category[]> = {
  1: ['other'],
  2: ['one', 'other'],
  3: ['one', 'few', 'other'],
  4: ['one', 'few', 'many', 'other'],
  5: ['one', 'two', 'few', 'many', 'other'],
  6: ['zero', 'one', 'two', 'few', 'many', 'other'],
}

/**
 * Symfony's legacy interval spellings.
 *
 * A selector absent from this table DISQUALIFIES the value rather than
 * defaulting: `]2,5[` has no CLDR category, and inventing one would be exactly
 * the guess the citation requirement exists to prevent. An unclaimed interval
 * surfaces through G7 for a human instead.
 */
const SYMFONY_INTERVALS: Record<string, Category> = {
  '{0}': 'zero',
  '{1}': 'one',
  ']-Inf,0[': 'zero',
  '[0,1]': 'one',
  ']0,1]': 'one',
  '[1,Inf[': 'other',
  ']1,Inf[': 'other',
  '[2,Inf[': 'other',
}

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
    // Excluded from the formats that have a dialect of their own, because the
    // suffix rule is a coincidence in them rather than an arrangement: gettext
    // writes `msgid_plural`, and cutting that on `_` yields a base of `msgid`
    // and a token of `plural` — a perfectly-shaped i18next family made entirely
    // out of a keyword. A precedence cannot fix it: this row and the gettext
    // row claim DIFFERENT sites in the same file, so neither shadows the other.
    where: { bundleOnly: true, file: ['!**/*.po', '!**/*.pot', '!**/*.ftl', '!**/*.stringsdict'] },
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

  {
    id: 'fluent.select-expression',
    ecosystem: 'fluent',
    title: 'Fluent select expression on a number',
    docs: 'https://projectfluent.org/fluent/guide/selectors.html',
    primitive: 'fluent',
    // Ahead of everything: a `.ftl` value is read by its own grammar or not at
    // all, and no path- or delimiter-based row should get a look at one.
    precedence: 15,
    where: { file: ['**/*.ftl'] },
    // `{ $n -> [one] … *[other] }` is a syntactic construct, not a convention.
    evidence: { mode: 'intrinsic' },
    read: { primitive: 'fluent', ordinals: false },
    write: { mode: 'replace' },
    cldr: true,
    shape: 'inline-select',
    declaredBy: 'shipped',
    notes:
      'The one arrangement that genuinely costs a parser: Fluent selects by GRAMMAR, with nesting, a mandatory default variant and two kinds of variant key, and no table can express "parse this". `replace` is earned — en→ru turns two variants into four inside a single value, which no delimiter join can do. `ordinals: false` because Fluent has no ordinal concept to read.',
  },

  {
    id: 'apple.stringsdict-variants',
    ecosystem: 'apple',
    title: 'Plural variants in a .stringsdict variable dictionary',
    docs:
      'https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPInternational/StringsdictFileFormat/StringsdictFileFormat.html',
    primitive: 'path-part',
    // Beside its String Catalog sibling, and AHEAD of Rails at 40 — which is
    // the entire reason the row exists. With plist pointers in place,
    // `rails.sibling-object` would already read `/task_count/tasks/one`
    // correctly, but only while `bundleOnly` passes, and `bundleOnly` passes
    // here only because the path happens to contain `en.lproj`. A
    // `.stringsdict` sitting at `Resources/Localizable.stringsdict` would be
    // missed entirely. Intrinsic evidence and a citation beat a coincidence.
    precedence: 26,
    where: { file: ['**/*.stringsdict'] },
    evidence: { mode: 'intrinsic' },
    read: {
      primitive: 'path-part',
      split: { kind: 'path-regex', re: /^(.*)\/(zero|one|two|few|many|other)$/ },
      tokens: CLDR_TOKENS,
      minForms: 2,
    },
    write: {
      mode: 'code-edit',
      blocked:
        "a new form here is a new <key>/<string> pair inside the variable's <dict>, and insertion writes a JSON or YAML sibling rather than XML",
    },
    // Foundation resolves these variants with the CLDR plural rules, so
    // `missing` and `extra` are meaningful — the difference from gettext and Qt.
    cldr: true,
    shape: 'sibling-object',
    declaredBy: 'shipped',
    notes:
      'The archived URL is the one documenting the FILE FORMAT this row reads — NSStringLocalizedFormatKey, NSStringFormatSpecTypeKey, NSStringPluralRuleType. The modern equivalent is https://developer.apple.com/documentation/xcode/localizing-strings-that-contain-plurals. Readable only because the markup extractor gives a plist dict a JSON Pointer; a document-order text index carries no key and no row could have used one.',
  },

  {
    id: 'qt.numerusform',
    ecosystem: 'qt',
    title: 'Positional <numerusform> in a Qt Linguist catalog',
    docs: 'https://doc.qt.io/qt-6/i18n-source-translation.html',
    primitive: 'path-part',
    precedence: 28,
    where: { file: ['**/*.ts'], path: /^message\[\d+\]\/numerusform\[\d+\]$/ },
    evidence: { mode: 'intrinsic' },
    read: {
      primitive: 'path-part',
      split: { kind: 'path-regex', re: /^(message\[\d+\])\/numerusform\[(\d+)\]$/ },
      order: POSITIONAL_ORDER,
      selectorTemplate: '<numerusform>#{token}',
    },
    write: {
      mode: 'insert',
      keyTemplate: 'numerusform[{category}]',
      blocked: 'a new <numerusform> element is a markup edit rather than a sibling key',
    },
    // The index is a position resolved by the target language's rule inside
    // Qt's own runtime, never a CLDR category.
    cldr: false,
    shape: 'other',
    declaredBy: 'shipped',
    notes:
      'Reachable only because `.ts` is sniffed for `<!DOCTYPE TS>` before the extension routes it to the TypeScript grammar. Anchored on the enclosing <message>, not on a document-order text index, so a second message is a second family rather than four forms of one. `insert` never actually inserts: `cldr: false` makes the target keep the source arity, so every form already exists and is replaced at its own byte offset.',
  },

  {
    id: 'gettext.msgstr-index',
    ecosystem: 'gettext',
    title: 'Indexed msgstr in a gettext catalog',
    docs: 'https://www.gnu.org/software/gettext/manual/html_node/Plural-forms.html',
    primitive: 'path-part',
    // Documentation rather than arbitration: no other shipped row can match
    // `…/msgstr[n]` — i18next cuts on `_` or `.`, Rails needs the leaf to BE a
    // category — but saying where it sits costs nothing and saves the next
    // reader the check.
    precedence: 35,
    where: { file: ['**/*.po', '**/*.pot'] },
    evidence: { mode: 'intrinsic' },
    read: {
      primitive: 'path-part',
      split: { kind: 'path-regex', re: /^(.*)\/msgstr\[(\d+)\]$/ },
      order: POSITIONAL_ORDER,
      selectorTemplate: 'msgstr[{token}]',
    },
    write: {
      mode: 'insert',
      keyTemplate: 'msgstr[{category}]',
      blocked:
        "a new form here is a new `msgstr[n]` line whose index is decided by this catalog's own `Plural-Forms:` header — a C expression this engine does not evaluate",
    },
    cldr: false,
    shape: 'other',
    declaredBy: 'shipped',
    notes:
      '`Plural-Forms:` is a C expression this engine does NOT evaluate. An index is a POSITION — index 1 of a three-form Polish catalog is "the second form", never `few` — so this family is `cldr: false` and is never measured for completeness. That is a smaller claim than the one made for i18next, and it is the true one.',
  },

  {
    id: 'symfony.interval',
    ecosystem: 'symfony',
    title: 'Explicit interval selector on each pipe-separated part',
    docs: 'https://symfony.com/doc/4.4/components/translation/usage.html#pluralization',
    primitive: 'value-split',
    // Ahead of `vue-i18n.pipe-positional` at 50, which is the whole point:
    // both read a pipe, and only one of them reads the selectors. Positional
    // would call `{0} …|]0,1] …|]1,Inf[ …` a zero|one|other family by counting
    // parts, and be wrong about all three.
    precedence: 45,
    where: { bundleOnly: true },
    // `catalog`, not `declared`. An explicit interval at the head of every part
    // cannot occur by accident, and `partSelector` is itself the evidence: it
    // requires EVERY part to carry a citable selector before it claims
    // anything. `prefer` supplies precedence and a citation without demanding
    // permission, exactly as the i18next row does.
    evidence: {
      mode: 'catalog',
      prefer: { dependency: ['symfony/translation', 'symfony/framework-bundle'] },
    },
    read: {
      primitive: 'value-split',
      delimiters: ['|'],
      partSelector: { re: /^(\{[^}]*\}|[[\]][^[\]]*[[\]])\s*/, tokens: SYMFONY_INTERVALS },
      requiresCounting: true,
    },
    write: {
      mode: 'code-edit',
      blocked:
        'each part carries its own interval selector, and rejoining translated parts with a bare pipe would drop them — the forms go to the structural worklist with their selectors intact',
    },
    // Intervals answer to Symfony's own matcher, not to CLDR.
    cldr: false,
    shape: 'delimited',
    declaredBy: 'shipped',
    notes:
      "Symfony's legacy interval format. The interval knowledge lives HERE rather than as a guard inside the vue-i18n row, because putting one runtime's spelling inside another's dialect is the coupling this design exists to remove.",
  },
]

export const DIALECTS_BY_ID = new Map(DIALECTS.map((d) => [d.id, d]))
