# fixture-i18n

A small English workspace app that has already been internationalised, used to exercise plural
families. It is deliberately separate from `evals/fixture`, which is a fully French repository whose
source language is inferred from the whole tree — dropping Russian and Japanese bundles into it
would change what that eval measures.

Every plural shape appears exactly once, and each one carries a known defect or a known clean
result:

<!-- ul:human key=proves -->

Why each row is in the fixture. This column is yours: it is the one thing a
machine cannot derive, and it survives every regeneration byte for byte.

| anchor | what it is there to prove |
|---|---|
| `config/locales/en.yml#/en/tasks/count` | Rails, and the arrangement where the category is a CHILD key rather than a suffix |
| `res/values/strings.xml#plurals[task_count]` | Android, whose forms live in markup and are therefore written by a code edit, never by inserting a sibling |
| `src/Cart.tsx#Cart/label` | a rule baked into a ternary, declared in place with an `ultrai18n:plural` comment because no catalog can read one |
| `src/locales/en/common.json#/cars` | vue-i18n positional forms, which are not CLDR and are never gated on it |
| `src/locales/en/common.json#/cart/item` | key-suffix, complete for English — the control the broken ones are read against |
| `src/locales/en/common.json#/inbox` | ICU, which the pipeline could not ship at all before the grammar landed |
| `src/locales/en/common.json#/invite` | an ordinal key-suffix family, parsed and preserved and never measured against cardinal rules |
| `src/locales/en/common.json#/notice` | an EXTRA form: a key English will never select, which is waste rather than breakage |
| `src/locales/en/common.json#/place` | an ICU ordinal, where English has four forms and its cardinals have two |
| `src/locales/ja/common.json#/cart/item` | one form is COMPLETE for Japanese, and reporting it as short would be inventing a failure |
| `src/locales/ru/common.json#/cart/item` | the live rendering bug: a Russian catalog with only `one` and `other` renders the wrong string for 2, 3 and 4 today |
| `src/locales/ru/common.json#/inbox` | the same defect inside an ICU message, so the check cannot be a key-shape heuristic |

<!-- /ul:human key=proves -->

<!-- ul:gen key=shapes -->

_Generated from the fixture itself. Edit the `proves` region below, never this table._

| where | shape | target needs | state | what it is there to prove |
|---|---|---|---|---|
| `config/locales/en.yml` `/en/tasks/count` | sibling-object | one, few, many, other | complete | Rails, and the arrangement where the category is a CHILD key rather than a suffix |
| `res/values/strings.xml` `plurals[task_count]` | attr-quantity | one, few, many, other | complete | Android, whose forms live in markup and are therefore written by a code edit, never by inserting a sibling |
| `src/Cart.tsx` `Cart/label` | annotation | one, few, many, other | complete | a rule baked into a ternary, declared in place with an `ultrai18n:plural` comment because no catalog can read one |
| `src/locales/en/common.json` `/cars` | delimited | zero, one, other | complete | vue-i18n positional forms, which are not CLDR and are never gated on it |
| `src/locales/en/common.json` `/cart/item` | key-suffix | one, few, many, other | complete | key-suffix, complete for English — the control the broken ones are read against |
| `src/locales/en/common.json` `/inbox` | inline-select | one, few, many, other | complete | ICU, which the pipeline could not ship at all before the grammar landed |
| `src/locales/en/common.json` `/invite` | key-suffix | other | complete | an ordinal key-suffix family, parsed and preserved and never measured against cardinal rules |
| `src/locales/en/common.json` `/notice` | key-suffix | one, few, many, other | **extra `few`** | an EXTRA form: a key English will never select, which is waste rather than breakage |
| `src/locales/en/common.json` `/place` | inline-select | other | complete | an ICU ordinal, where English has four forms and its cardinals have two |
| `src/locales/ja/common.json` `/cart/item` | key-suffix | one, few, many, other | complete | one form is COMPLETE for Japanese, and reporting it as short would be inventing a failure |
| `src/locales/ru/common.json` `/cart/item` | key-suffix | one, few, many, other | **missing `few` and `many`** | the live rendering bug: a Russian catalog with only `one` and `other` renders the wrong string for 2, 3 and 4 today |
| `src/locales/ru/common.json` `/inbox` | inline-select | one, few, many, other | **missing `few` and `many`** | the same defect inside an ICU message, so the check cannot be a key-shape heuristic |

<!-- /ul:gen key=shapes -->
