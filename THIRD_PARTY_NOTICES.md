# Third-Party Notices

Graphwright has zero runtime npm dependencies (CLAUDE.md rule 1). The following
third-party code is vendored (committed directly into this repository) rather
than installed, for `graphwright serve`'s self-contained frontend.

## d3 v7.9.0

- **Source**: https://d3js.org (npm package `d3`, version `7.9.0`)
- **License**: ISC
- **Vendored at**: `vendor/d3.js` (unminified UMD bundle, verbatim), `vendor/d3.mjs` (graphwright's own thin ESM shim over it)
- **Why vendored, not installed**: `graphwright serve`'s frontend must be self-contained and work air-gapped/firewalled (SPEC.md §10.3) — no CDN references, and no runtime dependency (CLAUDE.md rule 1) means it can't be an npm `dependency` either.

```
ISC License — Copyright 2010-2023 Mike Bostock

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

## Idea-level attribution (not vendored code)

`graphwright serve`'s view taxonomy and interaction model (multiple views over
one graph switched by number keys, live re-render on index change with stable
node positions, double-click-to-editor) are consciously borrowed from
[brn-mwai/codegraph](https://github.com/brn-mwai/codegraph) (MIT). No code from
that project is vendored or adapted — graphwright's implementation reads
`codegraph.db` directly and was written independently — so this is credit only,
per SPEC.md §10.1's attribution policy. See also README.md's Acknowledgements
section.
