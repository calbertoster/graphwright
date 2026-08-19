import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

const EXPECTED_SCHEMA_VERSION = 8;

/**
 * Walk up from `startDir` looking for `.codegraph/codegraph.db`.
 * Returns the resolved db path, or null if none was found.
 */
export function findIndexUpwards(startDir) {
  let dir = resolve(startDir);
  while (true) {
    const candidate = join(dir, '.codegraph', 'codegraph.db');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Resolve the codegraph index path given an optional --project override.
 * Returns { path } on success, or { error, code } on failure (never throws).
 */
export function resolveIndexPath({ cwd, project }) {
  if (project) {
    const candidate = join(resolve(cwd, project), '.codegraph', 'codegraph.db');
    if (!existsSync(candidate)) {
      return {
        error: `No codegraph index found under ${resolve(cwd, project)} — run "codegraph init" there first.`,
        code: 2,
      };
    }
    return { path: candidate };
  }
  const found = findIndexUpwards(cwd);
  if (!found) {
    return {
      error: `No codegraph index found in ${cwd} or any parent directory — run "codegraph init" first.`,
      code: 2,
    };
  }
  return { path: found };
}

/**
 * Open the index read-only. Returns { db, warning } on success, or throws.
 * Schema drift (§2 guard) warns rather than crashing.
 */
export function openIndex(path) {
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch (err) {
    const e = new Error(`Failed to open codegraph index at ${path}: ${err.message}`);
    e.code = 1;
    throw e;
  }
  let warning = null;
  try {
    const row = db.prepare('SELECT MAX(version) AS v FROM schema_versions').get();
    if (!row || row.v !== EXPECTED_SCHEMA_VERSION) {
      warning = `codegraph schema version is ${row ? row.v : 'unknown'}, expected ${EXPECTED_SCHEMA_VERSION} — proceeding anyway, results may be inaccurate.`;
    }
  } catch (err) {
    warning = `Could not read schema_versions (${err.message}) — proceeding anyway, results may be inaccurate.`;
  }
  return { db, warning };
}

const IMPORT_KIND = 'import';

/**
 * Find candidate nodes for an exact name match, preferring non-import kinds.
 * Returns a sorted array of node rows (file_path, start_line, kind, name asc).
 */
export function findNodesByExactName(db, name) {
  const rows = db
    .prepare(
      `SELECT * FROM nodes WHERE name = ? ORDER BY file_path ASC, start_line ASC, kind ASC`
    )
    .all(name);
  const preferred = rows.filter((r) => r.kind !== IMPORT_KIND);
  return preferred.length > 0 ? preferred : rows;
}

/**
 * Suggest near-matches for a symbol that had zero exact hits, via LIKE.
 */
export function suggestNearMatches(db, name, limit = 10) {
  const escaped = name.replace(/[%_\\]/g, (c) => `\\${c}`);
  const rows = db
    .prepare(
      `SELECT * FROM nodes WHERE name LIKE ? ESCAPE '\\' AND kind != ?
       ORDER BY LENGTH(name) ASC, file_path ASC, start_line ASC LIMIT ?`
    )
    .all(`%${escaped}%`, IMPORT_KIND, limit);
  return rows;
}

/**
 * Fetch a node row by id.
 */
export function getNodeById(db, id) {
  return db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
}

/**
 * Get outgoing edges (source = nodeId) restricted to `kinds`.
 */
export function getOutgoingEdges(db, nodeId, kinds) {
  if (kinds.length === 0) return [];
  const placeholders = kinds.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT * FROM edges WHERE source = ? AND kind IN (${placeholders}) ORDER BY target ASC, kind ASC`
    )
    .all(nodeId, ...kinds);
}

/**
 * Get incoming edges (target = nodeId) restricted to `kinds`.
 */
export function getIncomingEdges(db, nodeId, kinds) {
  if (kinds.length === 0) return [];
  const placeholders = kinds.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT * FROM edges WHERE target = ? AND kind IN (${placeholders}) ORDER BY source ASC, kind ASC`
    )
    .all(nodeId, ...kinds);
}

/**
 * BFS neighborhood discovery from `originId`, bounded by `depth`, `direction`,
 * `kinds`, and a hard `cap` on total nodes discovered. Returns:
 *   { nodeIds: Set<string>, overflow: boolean }
 * Edge selection for rendering is a separate step (getEdgesAmong) so the
 * rendered edge set is exactly "both endpoints survived the cap", not an
 * artifact of BFS visitation order.
 */
export function bfsNeighborhood(db, originId, { depth, direction, kinds, cap }) {
  const visited = new Set([originId]);
  let frontier = [originId];
  let overflow = false;

  for (let d = 0; d < depth && frontier.length > 0 && !overflow; d++) {
    const nextFrontier = [];
    for (const nodeId of frontier) {
      const neighbors = [];
      if (direction !== 'callers') {
        for (const e of getOutgoingEdges(db, nodeId, kinds)) neighbors.push(e.target);
      }
      if (direction !== 'callees') {
        for (const e of getIncomingEdges(db, nodeId, kinds)) neighbors.push(e.source);
      }
      for (const otherId of neighbors) {
        if (visited.has(otherId)) continue;
        if (visited.size >= cap) {
          overflow = true;
          break;
        }
        visited.add(otherId);
        nextFrontier.push(otherId);
      }
      if (overflow) break;
    }
    frontier = nextFrontier;
  }

  return { nodeIds: visited, overflow };
}

/**
 * All edges of `kinds` where both endpoints are in `nodeIds`, sorted
 * deterministically (source, target, kind).
 */
export function getEdgesAmong(db, nodeIds, kinds) {
  if (kinds.length === 0 || nodeIds.size === 0) return [];
  const placeholders = kinds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT * FROM edges WHERE kind IN (${placeholders}) ORDER BY source ASC, target ASC, kind ASC`
    )
    .all(...kinds);
  return rows.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));
}

/**
 * All node rows for a set of ids, sorted deterministically.
 */
export function getNodesByIds(db, nodeIds) {
  if (nodeIds.size === 0) return [];
  const ids = [...nodeIds];
  const placeholders = ids.map(() => '?').join(',');
  return db
    .prepare(`SELECT * FROM nodes WHERE id IN (${placeholders}) ORDER BY file_path ASC, start_line ASC, name ASC`)
    .all(...ids);
}

/**
 * All nodes in the index, sorted deterministically. Used by `wiki`.
 */
export function getAllNodes(db) {
  return db.prepare('SELECT * FROM nodes ORDER BY file_path ASC, start_line ASC, name ASC').all();
}

/**
 * All edges of the given kinds in the index, sorted deterministically.
 */
export function getAllEdges(db, kinds) {
  if (kinds.length === 0) return [];
  const placeholders = kinds.map(() => '?').join(',');
  return db
    .prepare(`SELECT * FROM edges WHERE kind IN (${placeholders}) ORDER BY source ASC, target ASC, kind ASC`)
    .all(...kinds);
}
