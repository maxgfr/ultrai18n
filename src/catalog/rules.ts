import type { Rule } from './types'

const NOT_VENDORED = ['!**/node_modules/**', '!**/vendor/**', '!**/dist/**', '!**/build/**']

/**
 * The surface catalog: where human-readable text is KNOWN to live.
 *
 * Every rule here exists because the location is documented as user-visible,
 * not because it looked like copy. That is the difference between finding
 * `package.json`'s description by rule and finding it by luck — and luck is
 * what fails on the file nobody thought to open.
 */
export const RULES: Rule[] = [
  // --------------------------------------------------------------------- npm
  {
    id: 'npm.package-json.description',
    ecosystem: 'npm',
    title: 'package.json "description"',
    docs: 'https://docs.npmjs.com/cli/configuring-npm/package-json#description',
    when: { kind: 'pointer', file: ['**/package.json', ...NOT_VENDORED], pointer: ['/description'] },
    emit: {
      surface: 'meta.package.description',
      verdict: 'translate',
      flags: ['published-artifact', 'registry-visible'],
    },
    companions: [
      {
        when: {
          kind: 'pointer',
          file: ['**/package.json', ...NOT_VENDORED],
          pointer: [
            '/name', '/version', '/license', '/main', '/module', '/types', '/packageManager',
            '/exports/**', '/scripts/*', '/dependencies/*', '/devDependencies/*',
            '/peerDependencies/*', '/engines/*', '/bin/*', '/files/*', '/repository/**',
            '/publishConfig/**', '/workspaces/*',
          ],
        },
        emit: { surface: 'identifier.binding', verdict: 'do-not-translate', reason: 'identifier' },
      },
      {
        when: { kind: 'pointer', file: ['**/package.json'], pointer: ['/keywords/*'] },
        emit: { surface: 'meta.package.keywords', verdict: 'needs-judgment', reason: 'discovery-token' },
      },
      {
        when: { kind: 'pointer', file: ['**/package.json'], pointer: ['/author', '/contributors/*'] },
        emit: { surface: 'identifier.binding', verdict: 'do-not-translate', reason: 'proper-noun' },
      },
    ],
    mirrors: ['web.manifest.text-fields', 'html.meta.prose'],
    notes:
      'Rendered on npmjs.com and by `npm search`. An AI reads package.json as dependency config and never looks at /description — the miss that motivated this tool. Three of three were missed in the reference repo.',
  },

  // --------------------------------------------------------------------- web
  {
    id: 'web.manifest.inlined-in-build-config',
    ecosystem: 'web',
    title: 'Web app manifest inlined in a bundler config',
    docs: 'https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest',
    when: {
      kind: 'structural',
      file: [
        '**/vite.config.*', '**/nuxt.config.*', '**/astro.config.*', '**/next.config.*',
        '**/svelte.config.*', '**/webpack.config.*', '**/rspack.config.*', '**/quasar.conf.*',
        '**/vue.config.*', '**/gatsby-config.*',
      ],
      path: /manifest\/(name|short_name|description|categories|screenshots|shortcuts)/,
    },
    emit: {
      surface: 'meta.webmanifest',
      verdict: 'translate',
      flags: ['published-artifact', 'invisible-to-filename-search'],
    },
    companions: [
      {
        when: {
          kind: 'structural',
          file: ['**/vite.config.*', '**/nuxt.config.*', '**/astro.config.*', '**/next.config.*'],
          path: /manifest\/(lang|dir)$/,
        },
        emit: { surface: 'locale.declaration', verdict: 'locale-marker' },
      },
      {
        when: {
          kind: 'structural',
          file: ['**/vite.config.*', '**/nuxt.config.*', '**/astro.config.*', '**/next.config.*'],
          path: /(manifest\/(id|start_url|scope|display|orientation|theme_color|background_color|icons)|cacheId|globPatterns|base)/,
        },
        emit: { surface: 'token.url-slug', verdict: 'do-not-translate', reason: 'url-or-slug' },
      },
    ],
    notes:
      'The manifest exists only at build time, so `find -name manifest.json` returns nothing and a file-name-driven search misses the entire PWA listing.',
  },
  {
    id: 'web.manifest.text-fields',
    ecosystem: 'web',
    title: 'Web app manifest',
    docs: 'https://developer.mozilla.org/en-US/docs/Web/Manifest',
    when: {
      kind: 'pointer',
      file: ['**/manifest.json', '**/manifest.webmanifest', '**/*.webmanifest'],
      pointer: [
        '/name', '/short_name', '/description', '/categories/*',
        '/shortcuts/*/name', '/shortcuts/*/short_name', '/shortcuts/*/description',
        '/screenshots/*/label',
      ],
    },
    emit: { surface: 'meta.webmanifest', verdict: 'translate', flags: ['published-artifact'] },
    companions: [
      {
        when: { kind: 'pointer', file: ['**/manifest*.json', '**/*.webmanifest'], pointer: ['/lang', '/dir'] },
        emit: { surface: 'locale.declaration', verdict: 'locale-marker' },
      },
    ],
  },

  // ------------------------------------------------------------ webextension
  {
    id: 'webext.manifest.text',
    ecosystem: 'webextension',
    title: 'Browser extension manifest',
    docs: 'https://developer.chrome.com/docs/extensions/reference/manifest',
    when: {
      kind: 'pointer',
      file: ['**/manifest.json', ...NOT_VENDORED],
      requiresPointer: '/manifest_version',
      pointer: [
        '/name', '/short_name', '/description',
        '/action/default_title', '/browser_action/default_title', '/page_action/default_title',
        '/commands/*/description', '/omnibox/keyword',
      ],
    },
    emit: { surface: 'meta.extension-manifest', verdict: 'translate', flags: ['store-listing'], maxLength: 132 },
    companions: [
      {
        when: {
          kind: 'pointer',
          file: ['**/manifest.json'],
          pointer: [
            '/permissions/*', '/host_permissions/*', '/content_scripts/*/matches/*',
            '/content_scripts/*/js/*', '/background/service_worker', '/key', '/update_url',
            '/web_accessible_resources/**', '/content_security_policy/**', '/icons/**',
          ],
        },
        emit: { surface: 'token.api-contract', verdict: 'do-not-translate', reason: 'api-contract' },
      },
      {
        when: { kind: 'pointer', file: ['**/manifest.json'], pointer: ['/default_locale'] },
        emit: { surface: 'locale.declaration', verdict: 'locale-marker' },
      },
    ],
    notes:
      'A content_scripts match pattern looks like a URL because it is one; translating it silently disables the extension.',
  },
  {
    id: 'webext.locales.messages',
    ecosystem: 'webextension',
    title: 'Extension _locales message bundle',
    docs: 'https://developer.chrome.com/docs/extensions/reference/api/i18n',
    when: { kind: 'pointer', file: ['**/_locales/*/messages.json'], pointer: ['/*/message', '/*/description'] },
    emit: { surface: 'i18n.message', verdict: 'translate' },
    companions: [
      {
        when: { kind: 'pointer', file: ['**/_locales/*/messages.json'], pointer: ['/*/placeholders/**'] },
        emit: { surface: 'token.api-contract', verdict: 'do-not-translate', reason: 'interpolation' },
      },
    ],
  },

  // ------------------------------------------------------------------ github
  {
    id: 'github.issue-forms',
    ecosystem: 'github',
    title: 'GitHub issue form',
    docs: 'https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-githubs-form-schema',
    when: {
      kind: 'pointer',
      file: ['.github/ISSUE_TEMPLATE/*.yml', '.github/ISSUE_TEMPLATE/*.yaml'],
      pointer: [
        '/name', '/description', '/title',
        '/body/*/attributes/label', '/body/*/attributes/description',
        '/body/*/attributes/placeholder', '/body/*/attributes/value',
        '/body/*/attributes/options/*', '/body/*/attributes/options/*/label',
        '/contact_links/*/name', '/contact_links/*/about',
      ],
    },
    emit: { surface: 'ui.issue-form', verdict: 'translate', flags: ['public-facing'] },
    companions: [
      {
        when: {
          kind: 'pointer',
          file: ['.github/ISSUE_TEMPLATE/*.yml', '.github/ISSUE_TEMPLATE/*.yaml'],
          pointer: ['/body/*/id', '/body/*/type', '/labels/*', '/assignees/*', '/body/*/attributes/render'],
        },
        emit: { surface: 'identifier.binding', verdict: 'do-not-translate', reason: 'identifier' },
      },
    ],
    notes:
      'A label in /labels/* must match a label that EXISTS in the repo; translating it silently breaks the template.',
  },
  {
    id: 'github.release-notes-body',
    ecosystem: 'github',
    title: 'Release-notes body inside a workflow',
    docs: 'https://github.com/softprops/action-gh-release#-usage',
    when: {
      kind: 'pointer',
      file: ['.github/workflows/*.yml', '.github/workflows/*.yaml'],
      pointerRegex: /^\/jobs\/[^/]+\/steps\/\d+\/with\/(body|release_name|release_notes)$/,
    },
    emit: { surface: 'ui.release-notes', verdict: 'translate', flags: ['public-facing'] },
    companions: [
      {
        when: {
          kind: 'pointer',
          file: ['.github/workflows/*.yml', '.github/workflows/*.yaml'],
          pointerRegex: /^\/jobs\/[^/]+\/steps\/\d+\/(uses|if|run|id)$|\/with\/(files|body_path|token|tag_name|node-version)$/,
        },
        emit: { surface: 'token.api-contract', verdict: 'do-not-translate', reason: 'code-token' },
      },
    ],
    notes:
      'Markdown nested in YAML that renders on the public Releases page. Ordinary YAML tooling reports one opaque scalar.',
  },
  {
    id: 'github.workflow-prose',
    ecosystem: 'github',
    title: 'Workflow and job names shown in the Actions UI',
    docs: 'https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions#name',
    when: {
      kind: 'pointer',
      file: ['.github/workflows/*.yml', '.github/workflows/*.yaml'],
      pointerRegex: /^\/name$|^\/jobs\/[^/]+\/name$|^\/jobs\/[^/]+\/steps\/\d+\/name$/,
    },
    emit: { surface: 'meta.ci', verdict: 'translate' },
  },

  // ------------------------------------------------------------------- html
  {
    id: 'html.meta.prose',
    ecosystem: 'web',
    title: 'HTML head metadata and social preview',
    docs: 'https://ogp.me/',
    when: {
      kind: 'attr',
      file: ['**/*.html', '**/*.htm', '**/*.vue', '**/*.svelte', '**/*.astro', '**/*.ejs', '**/*.hbs', '**/*.erb'],
      element: /^meta$/,
      attr: /^(description|keywords|author|application-name|apple-mobile-web-app-title|subject|abstract|og:title|og:description|og:site_name|og:image:alt|twitter:title|twitter:description|twitter:image:alt|article:section|article:tag)$/,
    },
    emit: { surface: 'meta.head', verdict: 'translate', flags: ['seo'], maxLength: 160 },
    companions: [
      {
        when: {
          kind: 'attr',
          file: ['**/*.html', '**/*.htm', '**/*.vue', '**/*.svelte', '**/*.astro'],
          element: /^meta$/,
          attr: /^(viewport|theme-color|robots|color-scheme|referrer|format-detection|charset|content-type|msapplication-.*|google-site-verification|og:url|og:type|og:image|twitter:card|twitter:site|twitter:creator)$/,
        },
        emit: { surface: 'token.api-contract', verdict: 'do-not-translate', reason: 'code-token' },
      },
      {
        when: {
          kind: 'attr',
          file: ['**/*.html', '**/*.htm', '**/*.vue', '**/*.svelte', '**/*.astro'],
          element: /^(meta|html|link)$/,
          attr: /^(og:locale|lang|hreflang|dir)$/,
        },
        emit: { surface: 'locale.declaration', verdict: 'locale-marker' },
      },
    ],
  },
  {
    id: 'html.title',
    ecosystem: 'web',
    title: 'Document title',
    docs: 'https://developer.mozilla.org/en-US/docs/Web/HTML/Element/title',
    when: { kind: 'attr', file: ['**/*.html', '**/*.htm'], element: /^title$/, attr: /^text$/ },
    emit: { surface: 'meta.head', verdict: 'translate', flags: ['seo'] },
  },

  // ------------------------------------------------------------------ i18n
  {
    id: 'i18n.message-bundles',
    ecosystem: 'i18n',
    title: 'Locale message bundle',
    docs: 'https://www.i18next.com/misc/json-format',
    when: {
      kind: 'file',
      file: [
        '**/locales/**/*.json', '**/locale/**/*.json', '**/messages/*.json',
        '**/i18n/**/*.json', '**/lang/**/*.json', '**/translations/**/*.json',
        '**/locales/**/*.yml', '**/locales/**/*.yaml', '**/*.arb', '**/*.ftl',
        ...NOT_VENDORED,
      ],
    },
    emit: { surface: 'i18n.message', verdict: 'translate' },
    notes:
      'A bundle already IN the target locale is correct as it stands; the locale is read from its path, and gate G4 must not fire on it.',
  },

  // ----------------------------------------------------------- other manifests
  {
    id: 'cargo.package.description',
    ecosystem: 'rust',
    title: 'Cargo package description',
    docs: 'https://doc.rust-lang.org/cargo/reference/manifest.html#the-description-field',
    when: { kind: 'pointer', file: ['**/Cargo.toml', ...NOT_VENDORED], pointer: ['/package/description', '/package/keywords/*', '/package/categories/*'] },
    emit: { surface: 'meta.package.description', verdict: 'translate', flags: ['registry-visible'] },
  },
  {
    id: 'python.pyproject.description',
    ecosystem: 'python',
    title: 'pyproject project description',
    docs: 'https://packaging.python.org/en/latest/specifications/pyproject-toml/#description',
    when: { kind: 'pointer', file: ['**/pyproject.toml', ...NOT_VENDORED], pointer: ['/project/description', '/project/keywords/*'] },
    emit: { surface: 'meta.package.description', verdict: 'translate', flags: ['registry-visible'] },
  },
  {
    id: 'php.composer.description',
    ecosystem: 'php',
    title: 'Composer package description',
    docs: 'https://getcomposer.org/doc/04-schema.md#description',
    when: { kind: 'pointer', file: ['**/composer.json', ...NOT_VENDORED], pointer: ['/description', '/keywords/*'] },
    emit: { surface: 'meta.package.description', verdict: 'translate', flags: ['registry-visible'] },
  },
  {
    id: 'dart.pubspec.description',
    ecosystem: 'flutter',
    title: 'pubspec description',
    docs: 'https://dart.dev/tools/pub/pubspec#description',
    when: { kind: 'pointer', file: ['**/pubspec.yaml', ...NOT_VENDORED], pointer: ['/description'] },
    emit: { surface: 'meta.package.description', verdict: 'translate', flags: ['registry-visible'] },
  },
  {
    id: 'android.strings-xml',
    ecosystem: 'android',
    title: 'Android string resources',
    docs: 'https://developer.android.com/guide/topics/resources/string-resource',
    when: { kind: 'file', file: ['**/res/values*/strings.xml', '**/res/values*/plurals.xml', '**/res/values*/arrays.xml'] },
    emit: { surface: 'i18n.message', verdict: 'translate' },
    notes:
      'translatable="false" is a platform-native, machine-readable exception and must win over any heuristic.',
  },
  {
    id: 'docker.label',
    ecosystem: 'docker',
    title: 'OCI image description label',
    docs: 'https://github.com/opencontainers/image-spec/blob/main/annotations.md',
    when: { kind: 'keyName', file: ['**/Dockerfile', '**/Dockerfile.*', '**/*.dockerfile'], key: /^org\.opencontainers\.image\.(description|title)$/ },
    emit: { surface: 'meta.oci-label', verdict: 'translate' },
  },

  // ------------------------------------------------------------------ legal
  {
    id: 'legal.vendored-verbatim',
    ecosystem: 'legal',
    title: 'Vendored legal text',
    when: {
      kind: 'file',
      file: [
        'LICENSE*', 'LICENCE*', 'COPYING*', 'NOTICE*', 'CODE_OF_CONDUCT.md',
        '**/third_party/**', '**/licenses/**', '**/*.LICENSE.txt',
      ],
    },
    emit: {
      surface: 'legal.verbatim',
      verdict: 'do-not-translate',
      reason: 'vendored-legal',
      hard: true,
    },
    notes:
      'Altering LICENSE breaks GitHub licence detection and the repository displays "Other". The Contributor Covenant has official translations: swap the whole file, never hand-translate it.',
  },
]

/** Rules keyed by id, for citation lookups. */
export const RULES_BY_ID = new Map(RULES.map((r) => [r.id, r]))
