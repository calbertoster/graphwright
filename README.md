# Graphwright

Human-facing views for [codegraph](https://github.com/colbymchenry/codegraph) indexes: render any symbol's neighborhood as an SVG, or generate a browsable markdown wiki of your codebase — from the index codegraph already built, in any repo, with zero runtime dependencies.

> **Status: pre-v1 — unbuilt.** The committed design lives in [SPEC.md](SPEC.md); build progress is tracked in its §9 checklist.

Planned usage (see SPEC §4–§5 for the authoritative flag set):

```bash
graphwright view UserInviteService --depth 2 -o invite.svg   # neighborhood graph
graphwright wiki --out docs/codegraph-wiki                   # generated wiki
```

Requires Node ≥ 22.5 and a project indexed with `codegraph init`. Graphviz (`dot`) is optional — without it, `view` emits DOT/Mermaid text instead of SVG.
