# Viewer translations

Each file in this folder translates the HTML viewer (`node rescue.js view`) into one language.
The file name is the language code: an ISO 639-1 code (`en.json`, `de.json`, `fr.json`), optionally with a
region (`de-DE.json`, `pt-BR.json`). Every file found here is offered in the viewer's language menu after the
next export. English (`en.json`) is the default language and the fallback for missing keys.

## Adding a language

1. Copy `en.json` to `<code>.json`.
2. Set `_meta.name` to the language's own name (e.g. `"Français"`) and `_meta.intl` to the locale used for dates
   and numbers (e.g. `"fr-CH"`, `"fr-FR"`).
3. Translate the values, never the keys.
4. Run `node rescue.js view` again (or `npm run demo`) and pick the language at the top right of the viewer.

## Format

- `{name}` is a placeholder and must stay as is, e.g. `"Searching folder {current} of {total} …"`.
  Numbers are formatted for the selected locale.
- Values that depend on a number are objects with plural forms, chosen by `{count}` via
  [`Intl.PluralRules`](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Intl/PluralRules):
  `"one"`, `"other"` and, where the language needs them, `"zero"`, `"two"`, `"few"`, `"many"`.
  ```json
  "list.count": { "one": "{count} item", "other": "{count} items" }
  ```
- Keys missing in a translation fall back to English.
