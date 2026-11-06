# Book shelf: what to index

- **Idea:** The 84 files are 46 works. 24 of them have more than one copy, up to five, including French translations under other titles, so indexing every file would return the same passage several times. Index one copy per work: 39 works have a clean or good copy, and 7 have only a poor scan or a locked EPUB.
- **For:** Someone about to index their own collection of books for lexical and semantic search, who can’t yet say which to include (designs/intent.md, “Exploring your own data”).
- **Question:** I’m about to index these books for search, and I can’t yet say which ones are worth it. What have I got?
- **Facts** (from the run’s `books.csv`: 84 files, each with its source, pages, text quality, and `edition_of`, the id of the first copy of the same work):
  - 46 works. 22 have one copy, 14 have two, 7 have three, and 3 have four or five.
  - 38 files are further copies of a work already on the shelf. Nine are French translations, which have other titles and match their work only by `edition_of`.
  - 39 works have at least one copy with clean (Project Gutenberg, an EPUB with text) or good (a library scan) text.
  - 7 works have only poor scans or EPUBs with no extractable text.
- **Shape:** A network: works with their copies, each copy marked by its text quality.
- **Must show:** each work with its copies around it; which copy is the one to index; the works with no good copy.
- **Traps:** a bar chart of books per source, which counts files, not works; a table of 84 rows; a dashboard of every column with no one idea.
- **An explorer is welcome:** a way to pick the copy to index for each work, from the picture, fits the person’s next step.
