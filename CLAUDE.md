# CLAUDE.md

Graphwright is a portable visualization companion for codegraph indexes. **Read `SPEC.md` before any work** — it is the authoritative design, its §2 facts are execution-verified (don't re-derive them, and don't contradict them without re-verifying), and its **§9 checklist is the repo's working memory**: update it at the end of every session that changes build state.

Standing rules:

1. **Zero runtime dependencies** — `node:sqlite` + spawned `dot` only. Anything needing a runtime dep needs a SPEC change first, not a `package.json` change.
2. **Determinism is a feature** — generated output must be byte-identical for identical inputs (sort everything, no ambient timestamps). There is an acceptance test for this; keep it passing.
3. **Portability seams in SPEC §6 are load-bearing** — no host-repo conventions hardcoded, schema drift warns-and-degrades, graphviz absence is a supported configuration.
4. **Evidence discipline** — when you verify a new fact about codegraph's schema or CLI by execution, add it to SPEC §2 with the date; never state behavior as fact from memory.
5. **README stays honest** — usage examples must match the actually-implemented flags; update them in the same change.
6. Pin `@colbymchenry/codegraph` **exactly** (1.5.0) in devDependencies; version bumps are a deliberate change with a §2 re-verification pass, not a routine update.
