# fixture-i18n

A small English workspace app that has already been internationalised, used to exercise plural
families. It is deliberately separate from `evals/fixture`, which is a fully French repository whose
source language is inferred from the whole tree — dropping Russian and Japanese bundles into it
would change what that eval measures.

Every plural shape appears exactly once, and each one carries a known defect or a known clean
result:

| where | shape | what it is there to prove |
|---|---|---|
| `src/locales/en/common.json` `cart.item_*` | key-suffix | complete for English |
| `src/locales/ru/common.json` `cart.item_*` | key-suffix | **missing `few` and `many`** — a live rendering bug |
| `src/locales/ja/common.json` `cart.item_other` | key-suffix | one form is complete for Japanese, and must not be reported |
| `src/locales/en/common.json` `notice_*` | key-suffix | **an extra `few`** — a key English will never select |
| `src/locales/en/common.json` `inbox` | inline-select | ICU, which the pipeline could not ship at all before |
| `src/locales/en/common.json` `place` | inline-select | an ordinal: parsed, preserved, never gated on cardinal rules |
| `src/locales/en/common.json` `cars` | delimited | vue-i18n positional forms, which are not CLDR and are not gated |
| `config/locales/en.yml` `tasks.count` | sibling-object | Rails |
| `res/values/strings.xml` `task_count` | attr-quantity | Android |
| `src/Cart.tsx` `label` | annotation | a rule baked into a ternary, declared in place |
| `src/Cart.tsx` `selection` | — | the same ternary with no annotation: still refused |
