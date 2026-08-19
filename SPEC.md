# Graphwright — v1 Specification

> Status: **v1 built, all acceptance tests passing** (2026-08-19). §9 is the build checklist — update it at the end of every working session; it is this repo's working memory.
> Origin: designed in the SRVS-One project (2026-08-19). **Every claim marked "verified" below was verified by execution** against codegraph 1.5.0 and a real 362-file index (5,709 nodes / 12,649 edges); nothing in §2 is guessed.

Graphwright is a portable, human-facing visualization companion for [colbymchenry/codegraph](https://github.com/colbymchenry/codegraph) indexes: `graphwright view` renders a filtered neighborhood of any symbol as SVG/DOT/Mermaid, and `graphwright wiki` generates a browsable markdown wiki of the codebase from the index. It works in **any** repo that has run `codegraph init` — no coupling to any particular project.

## 1. Design constraints (non-negotiable)

- **Zero runtime dependencies.** SQLite reads via Node's built-in `node:sqlite`; graphviz via `spawnSync('dot')` when present. devDependencies allowed for tests only.
- **Node `>=22.5`** (`node:sqlite` requirement), ESM throughout.
- **Deterministic output** — identical inputs produce byte-identical outputs (sort everything; no timestamps except via explicit template placeholder). This makes generated wikis git-diffable.
- **Read-only** against the index. Never write to `.codegraph/`.

## 2. Verified facts about codegraph 1.5.0 (the evidence basis)

- Index location: `<project>/.codegraph/codegraph.db` (SQLite, WAL). `node:sqlite`'s `DatabaseSync` opens it with `{readOnly: true}`; Node emits an `ExperimentalWarning` — tolerate or suppress it.
- **Tables** (introspected): `nodes`, `edges`, `files`, `schema_versions`, `project_metadata`, `unresolved_refs`, `nodes_fts` (+ FTS5 internals), `name_segment_vocab`.
- **`nodes` columns**: `id` TEXT (e.g. `file:apps/...`), `kind`, `name`, `qualified_name`, `file_path`, `language`, `start_line`, `end_line`, `start_column`, `end_column`, `docstring`, `signature`, `visibility`, `is_exported`, `is_async`, `is_static`, `is_abstract`, `decorators`, `type_parameters`, `return_type`, `updated_at`.
- **`nodes.kind` values observed**: `import`, `property`, `type_alias`, `constant`, `method`, `file`, `function`, `interface`, `route`, `class`, `component`, `enum_member`, `enum`, `variable`. (`route` = framework-extracted API entry points, e.g. NestJS GraphQL `@Query`.)
- **`edges` columns**: `id`, `source`, `target`, `kind`, `metadata`, `line`, `col`, `provenance`.
- **`edges.kind` values observed**: `contains`, `imports`, `references`, `calls`, `decorates`, `implements`.
- **`schema_versions`**: rows observed `{version: 1}` and `{version: 8, description: "Initial schema includes all migrations"}`. Guard: read `MAX(version)`; if ≠ 8, print a one-line stderr warning and attempt anyway (schema drift must degrade, not crash).
- **Clusters and execution flows are NOT stored in the DB** — codegraph computes them at query time. The wiki's grouping is therefore graphwright's own (§5), by design.
- CLI: `codegraph explore -j/--json` verified; sibling commands (`node`, `callers`, `callees`, `impact`, `query`) show the same flag pattern but were not individually verified — check before relying on them. Symbol arguments are plain names (`getInviteDetails`), not dotted `Class.method` (dotted form can miss).
- **Scale reality**: a mid-size monorepo yields ~5,700 nodes / ~12,600 edges. A whole-graph render is an unusable hairball — filtered subgraphs are mandatory, hence the caps in §4/§5.
- `dot` (graphviz) availability varies by machine — degrade to emitting `.dot` text with a notice when absent.
- **(verified 2026-08-19, build session, 3-file and 6-file TS fixtures)** `edges.kind` also includes `instantiates` (emitted for `new X()` expressions) — add to the observed list alongside `contains, imports, references, calls, decorates, implements`.
- **(verified 2026-08-19)** `node:sqlite` `DatabaseSync(path, {readOnly: true})`: opens fine against a WAL-mode DB with live `-shm`/`-wal` sidecar files; a write attempt throws `Error: attempt to write a readonly database`; opening a nonexistent path throws `Error: unable to open database file`. No special handling needed beyond a try/catch with a clean message.
- **(verified 2026-08-19)** `files` columns: `path, content_hash, language, size, modified_at, indexed_at, node_count, errors`. `unresolved_refs` columns: `id, from_node_id, reference_name, reference_kind, line, col, candidates, file_path, language, status, name_tail`. `name_segment_vocab` columns: `segment, name`. `nodes_fts` (FTS5) indexes `id, name, qualified_name, docstring, signature` (content table `nodes`).
- **(verified 2026-08-19)** `nodes.name` is not unique even within one small fixture (e.g. two `constructor` methods on different classes) — confirms §4's resolution-by-kind/path disambiguation is necessary, not just defensive.
- **(verified 2026-08-19)** `codegraph init <path>` run twice is a no-op (exit 0, prints "Already initialized", does not rebuild) — safe for an idempotent test-fixture setup step.
- **(design decision 2026-08-19)** Graphwright's `view`/`wiki` commands never shell out to the `codegraph` binary — all data comes from direct read-only SQL against `codegraph.db` per §3's suggested layout. The "optionally a codegraph binary on PATH" portability seam (§6.1) is therefore inert for v1; only `dot` is ever spawned. Revisit if a future version needs live (non-indexed) data.
- **(design decision 2026-08-19)** `--out` (wiki) and `--project`/`-o` (view) paths resolve relative to `process.cwd()`, not to the detected project root, matching ordinary CLI path conventions.
- **(design decision 2026-08-19)** Wiki's default banner template contains only `{cmd}`, never `{date}` — required to keep the *default* determinism test (§7 test 3) byte-identical across runs. `{date}` is available only for host repos that opt in via `--banner`, which knowingly trades determinism for a timestamp.
- **(design decision 2026-08-19)** Wiki's cross-group dependency counts use the same edge-kind set as the intra-group diagram (`imports`, `calls`) for consistency, rather than all non-`contains` kinds.
- **(verified + design decision 2026-08-19)** With `contains` excluded from the default traversal kinds (as §4 requires), a **class-kind** node has no outgoing default-kind edges reachable from itself — `calls`/`references`/`imports` only ever touch a class node from *outside* (an inbound `imports` from a file, or an inbound `references`/`instantiates` from another symbol); the class's own methods are reachable only via the excluded `contains` edge. So starting `view` on a bare class node can never surface a same-class method's cross-file `calls` edge within any depth, by design (not a bug). §7 acceptance test 1 ("`view` on a fixture class at depth 2 emits DOT containing the known cross-file call edge") is therefore satisfied by targeting a **method belonging to one of the fixture's classes** (`sayHello` on `GreetingService`, which calls `greet` on `EnglishGreeter` in another file) rather than the class node itself — the smallest reasonable reading that's actually reachable under the documented default-kinds behavior.
- **(verified 2026-08-19)** Node's built-in test runner, invoked with a bare directory (`node --test test/`) or with no args, recursively auto-discovers and tries to *execute as tests* every file under any directory literally named `test` — including our `test/fixture/src/*.ts` fixture sources, which aren't test files and don't even parse (legacy decorator syntax isn't valid in Node's default/experimental TS handling). Fix: `package.json`'s `test` script and CI must point `node --test` at the explicit acceptance file (`node --test test/acceptance.test.js`), never at the bare `test/` directory.

## 3. Package shape

- npm name `graphwright` (verified available 2026-08-19). Single bin: `graphwright` with `view` and `wiki` subcommands plus `-h`/`-V`.
- Index resolution: walk up from cwd to the nearest `.codegraph/codegraph.db`; `--project <path>` overrides. No index found → exit 2 with a message suggesting `codegraph init`.
- Suggested layout: `bin/graphwright.mjs` (arg parsing only) → `src/db.mjs` (open + guard + queries) → `src/view.mjs`, `src/wiki.mjs`, `src/render.mjs` (dot/mermaid/svg emitters).

## 4. `graphwright view` (neighborhood viewer)

```
graphwright view <symbol> [--depth 2] [--direction both|callers|callees]
                 [--kinds calls,references,imports] [--format svg|dot|mermaid]
                 [-o out.svg] [--pick N] [--force] [--project <path>]
```

- **Symbol resolution**: exact `nodes.name` match, preferring non-`import` kinds. Multiple hits → list candidates (`kind`, `file_path:start_line`) and exit 3, unless `--pick N` selects one. No hit → suggest near-matches (via `nodes_fts` or `LIKE`) and exit 3.
- **Traversal**: BFS over `edges` restricted to `--kinds` (default `calls,references,imports`; `contains` excluded — it swamps everything) to `--depth`, both directions unless `--direction` narrows it.
- **Size guard**: > 300 nodes → error advising a smaller depth or `--force` (which raises the cap to 1500). Never render unbounded.
- **DOT output**: node label `name\nfile_path:start_line`; shape by kind (class/interface = box, function/method = ellipse, route = diamond, file = folder); subgraph clusters by top-level directory; edge color by kind. `svg` pipes through `dot -Tsvg` (fall back to writing `.dot` + notice if dot is missing). `mermaid` emits `flowchart LR`, capped at ~150 edges.

## 5. `graphwright wiki` (generated wiki)

```
graphwright wiki [--out docs/codegraph-wiki] [--group-depth 2]
                 [--banner "<template>"] [--max-diagram-edges 150] [--project <path>]
```

- **Grouping**: by `file_path` prefix truncated to `--group-depth` segments (clusters aren't in the DB — §2). Deterministic and meaningful; semantic clustering is a non-goal (§8).
- **Pages**: `index.md` — group table (group, file count, symbol count, top exported symbols) — plus one page per group:
  - exported symbols table: `name`, `kind`, `file_path:start_line`, first line of `docstring` if present;
  - intra-group Mermaid diagram of `imports` + `calls` collapsed to file level, capped at `--max-diagram-edges` (over cap: split by subfolder, or fall back to a plain edge list);
  - cross-group dependencies: `this group → other group (edge count)`.
- **Banner**: every page begins with the banner template; default `> Generated by graphwright wiki — do not hand-edit. Regenerate: \`{cmd}\``. Placeholders `{cmd}` and `{date}`. Host repos inject their own convention via `--banner` (the origin repo will).
- **Idempotent**: rewrites the out dir fully; removes pages for groups that no longer exist; second run with unchanged index produces byte-identical output.

## 6. Portability seams (do not break these)

1. Inputs are only: the SQLite file, and optionally a `codegraph` binary on PATH. Never `import` from the codegraph package at runtime.
2. Schema drift warns and degrades (§2 guard); all SQL is read-only.
3. No host-repo conventions hardcoded — anything repo-specific (banners, out dirs, group depth) is a flag with a generic default.
4. Absence of graphviz is a supported configuration, not an error.

## 7. Testing

- `test/fixture/`: a tiny TS project (~6 files: two classes, an interface, cross-file imports and calls, one decorated method) committed to the repo. Its `.codegraph/` is **gitignored** — tests build it live via `npx @colbymchenry/codegraph@1.5.0 init` (pin exactly 1.5.0 in devDependencies; network required, fine in CI).
- Runner: `node:test`, no framework deps. Acceptance:
  1. `view` on a fixture class at depth 2 emits DOT containing the known cross-file call edge; exit 0.
  2. `view` on an unknown symbol → exit 3 with suggestions.
  3. `wiki` run twice → byte-identical output (determinism).
  4. Copied DB with a tampered `schema_versions` max → stderr warning, run still attempts.
  5. `dot` absent from PATH → `.dot` fallback + notice, exit 0.

## 8. Non-goals (v1)

Web server / live UI · file watching · semantic clustering · embeddings · sources other than codegraph · writing to the index.

## 9. Build checklist (update at session end — this is the repo's working memory)

- [x] Package skeleton (package.json, bin wiring, engines, ESM)
- [x] `src/db.mjs` — resolution walk-up, readOnly open, schema guard, core queries
- [x] `view`: resolution + BFS + caps
- [x] `view`: DOT/SVG/Mermaid emitters
- [x] `wiki`: grouping + index page
- [x] `wiki`: group pages (tables, diagrams, cross-group)
- [x] Banner templating + determinism pass
- [x] Fixture project + the 5 acceptance tests
- [x] README usage docs (sync with actual flags)

**v1 complete (2026-08-19).** All 5 §7 acceptance tests pass (`npm test` → `node --test test/acceptance.test.js`). Zero runtime dependencies (only `@colbymchenry/codegraph` as a pinned devDependency for building the test fixture). See §2 for facts/decisions recorded during this build session, dated 2026-08-19.
