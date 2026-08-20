import {
  getCounts,
  getSchemaVersion,
  searchNodes,
  getNodeById,
  getAllOutgoingEdgesForNode,
  getAllIncomingEdgesForNode,
  getAllFiles,
  getAllNodes,
  getAllEdges,
  bfsNeighborhood,
  getEdgesAmong,
  getNodesByIds,
} from './db.mjs';
import { computeGroups } from './wiki.mjs';

const DEFAULT_NEIGHBORHOOD_CAP = 300;
const MAX_NEIGHBORHOOD_CAP = 1500;
const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 100;
const DEFAULT_GROUP_DEPTH = 2;
const DEFAULT_EDGE_KINDS = ['calls', 'references'];

/**
 * Thrown by builders on a request-shape problem; serve.mjs maps `.status`
 * to the HTTP response code.
 */
export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function clampInt(value, { min, max, fallback }) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function parseKinds(value, fallback) {
  if (value == null || value === '') return fallback;
  const kinds = String(value)
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  return kinds.length > 0 ? kinds : fallback;
}

function nodeSummary(n) {
  return {
    id: n.id,
    kind: n.kind,
    name: n.name,
    qualified_name: n.qualified_name,
    file_path: n.file_path,
    start_line: n.start_line,
  };
}

/**
 * GET /api/meta
 */
export function buildMeta(db, { editorUrlTemplate }) {
  const counts = getCounts(db);
  const schemaVersion = getSchemaVersion(db);
  const { groupNames } = computeGroups(getAllNodes(db), DEFAULT_GROUP_DEPTH);
  return {
    schemaVersion,
    nodeCount: counts.nodeCount,
    edgeCount: counts.edgeCount,
    fileCount: counts.fileCount,
    groupCount: groupNames.length,
    editorUrlTemplate,
  };
}

/**
 * GET /api/search?q=&limit=
 */
export function buildSearch(db, { q, limit }) {
  const query = String(q ?? '').trim();
  if (query === '') throw new ApiError(400, 'q is required');
  const n = clampInt(limit, { min: 1, max: MAX_SEARCH_LIMIT, fallback: DEFAULT_SEARCH_LIMIT });
  const rows = searchNodes(db, query, n);
  return { query, candidates: rows.map(nodeSummary) };
}

/**
 * GET /api/node/:id
 */
export function buildNode(db, id) {
  const node = getNodeById(db, id);
  if (!node) throw new ApiError(404, `No node with id "${id}"`);
  return {
    node,
    outgoing: getAllOutgoingEdgesForNode(db, id),
    incoming: getAllIncomingEdgesForNode(db, id),
  };
}

/**
 * GET /api/neighborhood/:id?depth&kinds&direction&cap
 */
export function buildNeighborhood(db, id, { depth, kinds, direction, cap }) {
  const origin = getNodeById(db, id);
  if (!origin) throw new ApiError(404, `No node with id "${id}"`);

  const depthN = clampInt(depth, { min: 1, max: 20, fallback: 2 });
  const dir = ['both', 'callers', 'callees'].includes(direction) ? direction : 'both';
  const kindsList = parseKinds(kinds, ['calls', 'references', 'imports']);
  const capN = clampInt(cap, { min: 1, max: MAX_NEIGHBORHOOD_CAP, fallback: DEFAULT_NEIGHBORHOOD_CAP });

  const { nodeIds, overflow } = bfsNeighborhood(db, id, { depth: depthN, direction: dir, kinds: kindsList, cap: capN });
  const nodes = getNodesByIds(db, nodeIds);
  const edges = getEdgesAmong(db, nodeIds, kindsList);

  return {
    origin: nodeSummary(origin),
    depth: depthN,
    direction: dir,
    kinds: kindsList,
    cap: capN,
    overflow,
    nodes,
    edges,
  };
}

/**
 * GET /api/files — a directory tree with `files.node_count` per leaf.
 */
export function buildFiles(db) {
  const files = getAllFiles(db); // already sorted by path (db.mjs)
  const root = { name: '.', children: new Map() };
  for (const f of files) {
    const parts = f.path.split('/').filter(Boolean);
    let node = root;
    parts.forEach((part, i) => {
      const isLeaf = i === parts.length - 1;
      if (!node.children.has(part)) {
        node.children.set(
          part,
          isLeaf
            ? { name: part, path: f.path, language: f.language, size: f.size, node_count: f.node_count }
            : { name: part, children: new Map() }
        );
      }
      node = node.children.get(part);
    });
  }
  return toSortedTree(root);
}

function toSortedTree(node) {
  if (!node.children) return node;
  const children = [...node.children.values()]
    .map(toSortedTree)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { name: node.name, children };
}

/**
 * GET /api/groups?depth=
 */
export function buildGroups(db, { depth }) {
  const depthN = clampInt(depth, { min: 0, max: 20, fallback: DEFAULT_GROUP_DEPTH });
  const { groupNames, groupStats } = computeGroups(getAllNodes(db), depthN);
  return {
    depth: depthN,
    groups: groupNames.map((g) => ({ group: g, ...groupStats.get(g) })),
  };
}

/**
 * GET /api/edges?kinds=&group=|&file=&depth=
 * Always scoped — SPEC §10.3 forbids an unscoped whole-graph edge dump.
 */
export function buildEdges(db, { kinds, group, file, depth }) {
  const hasGroup = group != null && group !== '';
  const hasFile = file != null && file !== '';
  if (hasGroup === hasFile) {
    throw new ApiError(400, 'exactly one of "group" or "file" is required');
  }

  const kindsList = parseKinds(kinds, DEFAULT_EDGE_KINDS);
  const allNodes = getAllNodes(db);
  const nodesById = new Map(allNodes.map((n) => [n.id, n]));
  const allEdges = getAllEdges(db, kindsList);

  let scopeOf;
  let scopeLabel;
  if (hasFile) {
    scopeOf = (n) => n.file_path;
    scopeLabel = file;
  } else {
    const depthN = clampInt(depth, { min: 0, max: 20, fallback: DEFAULT_GROUP_DEPTH });
    const { nodeGroup } = computeGroups(allNodes, depthN);
    scopeOf = (n) => nodeGroup.get(n.id);
    scopeLabel = group;
  }

  const scopedNodeIds = new Set();
  for (const n of allNodes) {
    if (scopeOf(n) === scopeLabel) scopedNodeIds.add(n.id);
  }

  const edges = allEdges.filter((e) => scopedNodeIds.has(e.source) && scopedNodeIds.has(e.target));
  const touchedIds = new Set();
  for (const e of edges) {
    touchedIds.add(e.source);
    touchedIds.add(e.target);
  }
  const nodes = [...touchedIds]
    .map((id) => nodesById.get(id))
    .filter(Boolean)
    .sort((a, b) => (a.file_path < b.file_path ? -1 : a.file_path > b.file_path ? 1 : a.start_line - b.start_line))
    .map(nodeSummary);

  return { scope: hasFile ? { file } : { group }, kinds: kindsList, nodes, edges };
}
