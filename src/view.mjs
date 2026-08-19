import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import {
  resolveIndexPath,
  openIndex,
  findNodesByExactName,
  suggestNearMatches,
  bfsNeighborhood,
  getEdgesAmong,
  getNodesByIds,
} from './db.mjs';
import { renderDot, renderMermaidFlowchart } from './render.mjs';

const DEFAULT_CAP = 300;
const FORCED_CAP = 1500;
const MERMAID_EDGE_CAP = 150;

function formatCandidate(index, node) {
  return `  ${index}) ${node.kind}  ${node.file_path}:${node.start_line}  ${node.name}`;
}

function withExtension(path, ext) {
  const slashIdx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const dotIdx = path.lastIndexOf('.');
  if (dotIdx > slashIdx) return path.slice(0, dotIdx) + ext;
  return path + ext;
}

function writeOutput(text, output, stdout) {
  if (output) {
    writeFileSync(output, text, 'utf8');
  } else {
    stdout.write(text);
  }
}

/**
 * Run `graphwright view`. Options are already validated/typed by the CLI
 * layer. Returns a process exit code; never throws.
 */
export function runView(
  { symbol, depth, direction, kinds, format, output, pick, force, project },
  { cwd, stdout, stderr }
) {
  const resolved = resolveIndexPath({ cwd, project });
  if (resolved.error) {
    stderr.write(resolved.error + '\n');
    return resolved.code;
  }

  let db;
  let warning;
  try {
    ({ db, warning } = openIndex(resolved.path));
  } catch (err) {
    stderr.write(err.message + '\n');
    return err.code ?? 1;
  }
  if (warning) stderr.write(`warning: ${warning}\n`);

  const candidates = findNodesByExactName(db, symbol);

  if (candidates.length === 0) {
    const suggestions = suggestNearMatches(db, symbol);
    stderr.write(`No symbol named "${symbol}" found in the index.\n`);
    if (suggestions.length > 0) {
      stderr.write('Did you mean:\n');
      suggestions.forEach((n, i) => stderr.write(formatCandidate(i + 1, n) + '\n'));
    }
    return 3;
  }

  let chosen;
  if (candidates.length === 1) {
    chosen = candidates[0];
  } else if (pick != null) {
    if (pick < 1 || pick > candidates.length) {
      stderr.write(`--pick ${pick} is out of range (1..${candidates.length}) for "${symbol}":\n`);
      candidates.forEach((n, i) => stderr.write(formatCandidate(i + 1, n) + '\n'));
      return 3;
    }
    chosen = candidates[pick - 1];
  } else {
    stderr.write(`"${symbol}" is ambiguous — ${candidates.length} matches. Use --pick N to select one:\n`);
    candidates.forEach((n, i) => stderr.write(formatCandidate(i + 1, n) + '\n'));
    return 3;
  }

  const cap = force ? FORCED_CAP : DEFAULT_CAP;
  const { nodeIds, overflow } = bfsNeighborhood(db, chosen.id, { depth, direction, kinds, cap });
  if (overflow) {
    stderr.write(
      `Neighborhood of "${symbol}" has at least ${cap} nodes, exceeding the cap of ${cap}.\n` +
        (force
          ? 'Try a smaller --depth or narrower --kinds.\n'
          : 'Try a smaller --depth, narrower --kinds, or pass --force to raise the cap to 1500.\n')
    );
    return 1;
  }

  const nodes = getNodesByIds(db, nodeIds);
  const edges = getEdgesAmong(db, nodeIds, kinds);

  if (format === 'dot') {
    writeOutput(renderDot(nodes, edges, { graphName: 'neighborhood' }), output, stdout);
    return 0;
  }

  if (format === 'mermaid') {
    const { text, truncated } = renderMermaidFlowchart(
      nodes.map((n) => ({ id: n.id, label: `${n.name} (${n.file_path}:${n.start_line})` })),
      edges.map((e) => ({ source: e.source, target: e.target, label: e.kind })),
      { cap: MERMAID_EDGE_CAP }
    );
    if (truncated) stderr.write(`Mermaid diagram truncated to ${MERMAID_EDGE_CAP} edges.\n`);
    writeOutput(text, output, stdout);
    return 0;
  }

  // format === 'svg'
  const dotText = renderDot(nodes, edges, { graphName: 'neighborhood' });
  const result = spawnSync('dot', ['-Tsvg'], { input: dotText, encoding: 'utf8' });
  const dotUnavailable = result.error != null || result.status !== 0;
  if (dotUnavailable) {
    const reason = result.error ? result.error.message : (result.stderr || `dot exited with status ${result.status}`);
    stderr.write(`graphviz "dot" is unavailable (${reason}) — writing DOT text instead.\n`);
    const fallbackOutput = output ? withExtension(output, '.dot') : null;
    writeOutput(dotText, fallbackOutput, stdout);
    return 0;
  }
  writeOutput(result.stdout, output, stdout);
  return 0;
}
