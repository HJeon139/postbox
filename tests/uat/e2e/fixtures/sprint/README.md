# Titles

A small library that turns a title into the forms a site needs: its words, a URL slug, title case, a shortened form, a file name, and a command that prints them. Nothing is built yet. The acceptance tests in `acceptance/` say what each part has to do, and `node --test` runs them all.

| Part       | Module               | Builds on                   |
| ---------- | -------------------- | --------------------------- |
| Words      | `src/words.mjs`      |                             |
| Slug       | `src/slug.mjs`       | words                       |
| Title case | `src/title-case.mjs` | words                       |
| Truncate   | `src/truncate.mjs`   | words                       |
| File name  | `src/filename.mjs`   | slug, truncate              |
| Command    | `cli.mjs`            | slug, title case, file name |

The sprint board is `node board.mjs help`.
