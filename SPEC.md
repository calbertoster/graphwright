# Graphwright — v1 Specification

> Status: **v1 and v2 built, all 10 acceptance tests passing (`npm test`) — see §10 for the `serve` design and §11 for its build checklist.** §9/§11 are the build checklists — update them at the end of every working session; they are this repo's working memory.
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
- **(verified 2026-08-20, v2 build session, same fixture)** `nodes_fts` (FTS5) rows join back to `nodes` via `nodes.rowid = nodes_fts.rowid` (its `content_rowid='rowid'`) — `SELECT nodes.* FROM nodes_fts JOIN nodes ON nodes.rowid = nodes_fts.rowid WHERE nodes_fts MATCH ? ORDER BY bm25(nodes_fts) ...` returns full node columns ranked by relevance. An unescaped user query containing `"` or bare FTS5 operators (`OR`, `-`, `*`) throws `fts5: syntax error` or silently changes query semantics; graphwright's `sanitizeFtsQuery` (src/db.mjs) neutralizes this by splitting on whitespace and wrapping each term as a quoted-string prefix term (`"term"*`), verified to turn `a"b* OR 1=1` into an inert query rather than a syntax error or an injected `OR`.
- **(verified 2026-08-20)** `files.node_count` is already computed by codegraph (not something graphwright needs to derive by joining `nodes`) — confirmed non-zero and per-file-accurate on the fixture (e.g. `src/greeting-service.ts` → 7).
- **(verified 2026-08-20)** SSE change detection: a writer's `DatabaseSync` (non-readonly) connection checkpoints and removes its `-wal`/`-shm` sidecar files on `close()`, and the main `.db` file's mtime updates at that point — confirmed on the fixture db. So polling the main db file's mtime alone (no need to also stat `-wal`) reliably fires after a `codegraph init`/rebuild, which opens, writes, and closes its connection. graphwright's serve poll additionally checks `MAX(nodes.updated_at)` as a second signal per §10.3, but mtime alone was sufficient in testing.

- **(verified 2026-08-21, this devcontainer)** A missing browser opener fails **asynchronously**: `spawn('xdg-open')` returns a ChildProcess and *then* emits `'error'` (ENOENT), which `try/catch` cannot reach — an unhandled `'error'` event throws and **killed the server that had just started listening**. `serve --open` must attach a `child.on('error')` handler and degrade to printing the URL. Headless boxes, containers, and minimal images have no `xdg-open`; per §6.4 this is a supported configuration, not an error. Fixed 2026-08-21.

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

> Superseded in part, 2026-08-19: **"web server / live UI" moves into scope as v2** — see §10. The other non-goals stand.

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

## 10. v2 — `graphwright serve`, the interactive viewer (spec committed 2026-08-19, unbuilt)

A local web viewer over `codegraph.db`: multiple linked views of the graph in the browser, live against the index, with editor jump-to-source. Retires §8's "web server / live UI" non-goal on the record.

### 10.1 Prior art & attribution policy

The view taxonomy and interaction model consciously borrow from [brn-mwai/codegraph](https://github.com/brn-mwai/codegraph) (MIT; Python; single-author and possibly dormant — created 2026-07-25, quiet since 2026-07-30): several views over one graph switched on number keys, live re-render on index change with **stable node positions**, and double-click opening the file in the editor. **Attribution rules:**
- Idea-level borrowing → credit here and in README acknowledgements (this section is that credit).
- Verbatim or adapted **code** (e.g. its frontend view implementations) → keep its MIT copyright header in the vendored/adapted file and add an entry to `THIRD_PARTY_NOTICES.md` (create it on first use).
- Its Python indexer, ontology/rules engine, and MCP server are **not** used — graphwright reads `codegraph.db` (§2) only. Notably, its name-based call resolution is exactly what §10.2 forbids.

### 10.2 The collision constraint (verified 2026-08-19, reference index)

On the 362-file reference index: 3,447 symbols (excluding `file`/`import` kinds); **464 bare names are shared by 2+ symbols, covering 1,885 symbols — 55%**. Cross-file method duplicates include `constructor` ×83, `handleError` ×11, `transformDrizzleToRaw` ×9, `update` ×8, `create` ×8. Therefore, everywhere in v2: **node identity is `nodes.id`; display disambiguates with `qualified_name` and `file_path:start_line`; bare names are search input only — never merge keys.**

### 10.3 Architecture

- `graphwright serve [--port 4173] [--project <path>] [--editor-url <template>] [--open]` — a `node:http` server, zero runtime deps, all reads through the existing `src/db.mjs`.
- Serves: (a) one **self-contained** HTML app (no CDN references — must work firewalled/air-gapped); (b) a read-only JSON API; (c) an SSE stream.
- Frontend: single-page, vendored d3 v7 (ISC) committed under `vendor/` with license header; plain ES modules, **no build step**.
- **API** (all deterministic ordering): `/api/meta` (counts, schema version, groups) · `/api/search?q=` (FTS via `nodes_fts`; returns candidates with kind, `qualified_name`, location) · `/api/node/:id` (symbol + its edges) · `/api/neighborhood/:id?depth&kinds&direction` (the v1 BFS) · `/api/files` (tree with `node_count`) · `/api/groups` (§5 grouping) · `/api/edges?kinds&group` (scoped edge lists — never unscoped whole-graph).
- **Live updates**: the server never indexes — codegraph's watcher owns the db. Poll cheaply (db file mtime + `MAX(nodes.updated_at)`, ~2s); on change emit SSE `index-changed`; the client refetches its current view and preserves layout positions keyed by node id.
- **Editor jump**: double-click → `vscode://file/{path}:{line}` by default; `--editor-url` templates other editors.
- **Known tradeoff (2026-08-20, post-audit)**: `/api/edges`, `/api/groups`, and `/api/search` each re-read the full `nodes`/`edges` tables and recompute `computeGroups()` from scratch on *every* request, rather than caching or querying just the requested scope — a group/file toggle in the Calls or Imports view costs an O(all nodes + all edges) scan every time, not a targeted lookup. Deliberately left as-is: it mirrors what `wiki` already does once per process, and at the scale §2's reference index describes (~5,700 nodes / ~12,600 edges) it's cheap in practice. Revisit with real profiling data before adding caching/invalidation complexity — don't optimize this speculatively.

### 10.4 Views (v2 ships four; number keys; shared search/selection state)

1. **Explore** (default) — search → pick candidate → force-directed neighborhood with depth/kinds/direction controls mirroring `view`'s flags; click-to-expand; explicit "load more" past the size cap.
2. **Imports** — file-level import graph, collapsible by directory (§5 grouping), cycles highlighted.
3. **Calls** — symbol-level `calls`/`references` subgraph scoped to a selected group or file (never whole-graph; §2 scale facts).
4. **Treemap** — directory treemap sized by `files.node_count`, colored by language; click-through into Explore.

Deferred to v3 (recorded, not promised): flow/trace, layers/contracts (dependency-cruiser owns rules in host repos), matrix, radial.

### 10.5 Acceptance (extends §7; same fixture)

6. `serve` starts; `GET /` returns HTML containing **no** external `http(s)` resource references (self-containment check).
7. `/api/search` on a fixture symbol returns the known candidates with qualified names; `/api/neighborhood` on §7-test-1's method returns the known cross-file call edge.
8. Rebuilding the fixture index while the server runs yields an SSE `index-changed` event within 5s.
9. Identical API queries return byte-identical responses (ordering discipline).
10. The server cannot write: a write attempt through its db handle throws (read-only assertion).

Manual UI checklist (README, not automated): four views render on a real index; double-click opens the editor; positions stay stable across an SSE refresh.

### 10.6 v2 non-goals

Own indexer/watcher (codegraph owns the db) · an MCP server (host repos already designate their agent layer) · auth/multi-user (localhost tool) · UI-state persistence beyond the URL hash · browser-automation tests in CI (manual checklist instead).

## 11. v2 build checklist (working memory — update at session end)

- [x] `serve` command skeleton: node:http, static app, --port/--project/--open
- [x] JSON API endpoints over src/db.mjs (deterministic ordering) — `src/api.mjs`
- [x] SSE index-change detection (mtime + MAX(updated_at) poll)
- [x] Vendored d3 + THIRD_PARTY_NOTICES.md
- [x] View 1: Explore (search → candidates → force layout, expand, caps)
- [x] View 2: Imports (directory-collapsible, cycle highlight)
- [x] View 3: Calls (group/file-scoped)
- [x] View 4: Treemap
- [x] Editor-jump wiring (+ --editor-url template)
- [x] Acceptance tests 6–10 + manual UI checklist in README
- [x] README: serve section, screenshots optional (skipped — text-only)

**v2 complete (2026-08-20).** All 10 §7/§10.5 acceptance tests pass (`npm test`). Zero runtime dependencies held throughout: d3 is vendored under `vendor/`, never an npm dependency. Build-session notes:
- `src/api.mjs` holds pure JSON-builder functions (meta/search/node/neighborhood/files/groups/edges) over `src/db.mjs`, reused by `src/serve.mjs`'s HTTP routing — kept separate so the API shape is unit-testable without spinning up a server.
- `wiki.mjs`'s grouping logic was factored out into an exported `computeGroups()` so `/api/groups` and `graphwright wiki` share one implementation rather than two.
- `/api/edges` requires exactly one of `group`/`file` (400 otherwise) — the "never an unscoped whole-graph dump" rule from §10.3 is enforced server-side, not left to frontend discipline.
- The four views share one force-directed renderer (`public/views/forcegraph.mjs`) between Explore and Calls; Imports collapses symbol-level `imports` edges to file level client-side (same technique `wiki.mjs` already used) and flags cycle edges via Tarjan SCC.
- Frontend has no build step: `public/app.mjs` and `public/views/*.mjs` are plain ES modules; `vendor/d3.js` is the unminified UMD bundle loaded via a one-line ESM side-effect import (`vendor/d3.mjs`) that reads `globalThis.d3` back out — verified working under Node's ESM loader and, by the same mechanism, `<script type="module">` in a browser.
- Test 8 (SSE within 5s) copies the whole fixture project (source + `.codegraph/`) to a tmp dir per run and drives it with `codegraph sync`, never touching the git-tracked fixture — `codegraph init` on an already-initialized project is a no-op (§2), so `sync` (not `init`) is the correct rebuild verb for this test.

**Post-build audit (2026-08-20), three rounds against the running server, not just static reading:**
- Round 1: an unguarded out-of-order async response could let a stale fetch overwrite a newer selection's rendered graph (all views); `calls.mjs` hardcoded a group-depth constant that could silently drift from the server's; `app.mjs` escaped every search-result field except `kind`; `openIndex`/`getSchemaVersion` duplicated the same schema-version query; `imports.mjs`'s Tarjan SCC used plain recursion (verified it stack-overflows on a 200k-node chain via a runnable repro — fixed with an iterative work-stack version, output-equivalence checked against the recursive one).
- Round 2: the round-1 escaping fix only covered `app.mjs`'s search row — `showEmpty()` in every view plus the Treemap language legend still interpolated unescaped text into `innerHTML` (added a shared `public/util.mjs#escapeHtml`); unchecking every edge-kind checkbox in Explore silently fell back to the server's default kinds instead of showing nothing (the empty `kinds` param was stripped by `clean()` before reaching the server); `buildMeta()` ran a full `computeGroups()` over every node just to read a count; `calls.mjs` still hand-duplicated `groupForPath` for its file dropdown (fixed by having `/api/files?depth=` stamp each leaf with its own group).
- Round 3, verified by actually running the built CLI (not just reading code): `runServe`'s listen-error handler called `app.gwClose()`, but `gwClose` lives on `app.server` — every startup failure (e.g. `EADDRINUSE` from running `serve` twice on one port) threw a second uncaught `TypeError` on top of the real error, confirmed by starting two instances on the same port; `--port` had no upper bound, so `--port 99999` passed CLI validation and crashed with an uncaught `RangeError` from `server.listen()`, confirmed the same way; `treemap.mjs`'s `load()` was missing the request-token guard the other three views got in round 2.
- One finding was surfaced and deliberately left unfixed rather than "resolved" for appearances: the full-table-scan tradeoff now recorded above in §10.3.
