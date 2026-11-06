# Book shelf: what search will miss

- **Idea:** Before indexing, the risk is in the library scans: a quarter of the books but 43% of the pages, and 40% of their pages have poor OCR. Eight EPUBs have no extractable text at all. Project Gutenberg’s half of the pages is clean.
- **For:** Someone about to index their own collection of books for lexical and semantic search, who can’t yet say which to include (designs/intent.md, “Exploring your own data”).
- **Question:** I’m about to index these books for search, and I can’t yet say which ones are worth it. What have I got?
- **Facts** (from the run’s `books.csv`, 84 books, 36,069 pages):
  - Project Gutenberg: 50 books, 17,379 pages (48%), all clean text.
  - Library scans: 22 books, 15,379 pages (43%), published 1820 to 1925. Of their pages, 3,699 have good OCR, 5,564 fair and 6,116 poor (17% of all pages).
  - Own EPUBs: 12 books, 3,311 pages (9%), published 1995 to 2024. Eight of them, 2,080 pages, have no extractable text.
  - 77 books are in English, four in German and three in French.
- **Shape:** Comparison with parts: sources, sized by pages, split by text quality.
- **Must show:** each source’s share of the pages; within it, how much text search can use; where the poor and missing text is.
- **Traps:** counting books instead of pages, which hides that scans are long; a table of 84 rows; a dashboard of every column (years, languages, authors) with no one idea.
- **An explorer is welcome:** a way to pick the books to index, from the picture, fits the person’s next step. It doesn’t replace the picture.
