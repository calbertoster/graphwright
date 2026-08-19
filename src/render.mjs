const SHAPE_BY_KIND = {
  class: 'box',
  interface: 'box',
  route: 'diamond',
  file: 'folder',
};
const DEFAULT_SHAPE = 'ellipse';

const COLOR_BY_KIND = {
  calls: '#1f77b4',
  imports: '#7f7f7f',
  references: '#000000',
  implements: '#2ca02c',
  decorates: '#9467bd',
  instantiates: '#ff7f0e',
  contains: '#cccccc',
};
const DEFAULT_EDGE_COLOR = '#000000';

export function shapeForKind(kind) {
  return SHAPE_BY_KIND[kind] ?? DEFAULT_SHAPE;
}

export function colorForEdgeKind(kind) {
  return COLOR_BY_KIND[kind] ?? DEFAULT_EDGE_COLOR;
}

export function escapeDotString(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function topLevelDir(filePath) {
  if (!filePath) return '.';
  const idx = filePath.indexOf('/');
  return idx === -1 ? '.' : filePath.slice(0, idx);
}

/**
 * Render a neighborhood as DOT. `nodes` and `edges` must already be sorted
 * deterministically by the caller (db.mjs queries do this).
 */
export function renderDot(nodes, edges, { graphName = 'graphwright' } = {}) {
  const lines = [];
  lines.push(`digraph ${graphName} {`);
  lines.push('  rankdir=LR;');
  lines.push('  node [fontname="Helvetica"];');
  lines.push('  edge [fontname="Helvetica"];');

  const byDir = new Map();
  for (const n of nodes) {
    const dir = topLevelDir(n.file_path);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(n);
  }
  const dirs = [...byDir.keys()].sort();

  for (const dir of dirs) {
    const clusterId = `cluster_${escapeDotString(dir).replace(/[^A-Za-z0-9_]/g, '_')}`;
    lines.push(`  subgraph ${clusterId} {`);
    lines.push(`    label="${escapeDotString(dir)}";`);
    lines.push('    color="#dddddd";');
    for (const n of byDir.get(dir)) {
      const label = `${escapeDotString(n.name)}\\n${escapeDotString(n.file_path)}:${n.start_line}`;
      lines.push(`    "${escapeDotString(n.id)}" [label="${label}", shape=${shapeForKind(n.kind)}];`);
    }
    lines.push('  }');
  }

  for (const e of edges) {
    const color = colorForEdgeKind(e.kind);
    lines.push(
      `  "${escapeDotString(e.source)}" -> "${escapeDotString(e.target)}" [color="${color}", label="${escapeDotString(e.kind)}"];`
    );
  }

  lines.push('}');
  return lines.join('\n') + '\n';
}

function sanitizeMermaidId(id, used) {
  let base = String(id).replace(/[^A-Za-z0-9_]/g, '_');
  if (/^[0-9]/.test(base)) base = `n_${base}`;
  if (base === '') base = 'n';
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function sanitizeMermaidLabel(label) {
  return String(label).replace(/["'`\r\n]/g, ' ').trim();
}

/**
 * Render a flowchart LR mermaid diagram. `nodes`: [{id, label}], `edges`:
 * [{source, target, label}] (label optional). Both must be pre-sorted by
 * the caller. Truncates deterministically to `cap` edges.
 */
export function renderMermaidFlowchart(nodes, edges, { cap = 150 } = {}) {
  const used = new Set();
  const idMap = new Map();
  for (const n of nodes) {
    idMap.set(n.id, sanitizeMermaidId(n.id, used));
  }

  const truncated = edges.length > cap;
  const usedEdges = truncated ? edges.slice(0, cap) : edges;

  const referencedNodeIds = new Set();
  for (const e of usedEdges) {
    referencedNodeIds.add(e.source);
    referencedNodeIds.add(e.target);
  }

  const lines = ['flowchart LR'];
  for (const n of nodes) {
    if (!referencedNodeIds.has(n.id)) continue;
    lines.push(`  ${idMap.get(n.id)}["${sanitizeMermaidLabel(n.label)}"]`);
  }
  for (const e of usedEdges) {
    const from = idMap.get(e.source);
    const to = idMap.get(e.target);
    if (!from || !to) continue;
    if (e.label) {
      lines.push(`  ${from} -->|${sanitizeMermaidLabel(e.label)}| ${to}`);
    } else {
      lines.push(`  ${from} --> ${to}`);
    }
  }
  if (truncated) {
    lines.push(`  %% truncated: showing ${cap} of ${edges.length} edges`);
  }

  return { text: lines.join('\n') + '\n', truncated };
}
