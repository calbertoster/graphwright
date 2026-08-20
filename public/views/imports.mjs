import { renderForceGraph } from './forcegraph.mjs';
import { escapeHtml } from '../util.mjs';

const SEP = '|';

/**
 * Tarjan's SCC algorithm, iterative (explicit work stack standing in for the
 * call stack) rather than recursive — a recursive version blows V8's stack
 * on a long deterministic import chain (hundreds of files in a barrel/
 * re-export chain), which is well within range for real monorepos.
 */
function stronglyConnectedComponents(nodeIds, adj) {
  let index = 0;
  const indices = new Map();
  const low = new Map();
  const onStack = new Map();
  const stack = [];
  const comps = [];

  for (const start of nodeIds) {
    if (indices.has(start)) continue;
    indices.set(start, index);
    low.set(start, index);
    index++;
    stack.push(start);
    onStack.set(start, true);
    const callStack = [{ v: start, neighbors: adj.get(start) || [], i: 0 }];

    while (callStack.length > 0) {
      const frame = callStack[callStack.length - 1];
      if (frame.i < frame.neighbors.length) {
        const w = frame.neighbors[frame.i++];
        if (!indices.has(w)) {
          indices.set(w, index);
          low.set(w, index);
          index++;
          stack.push(w);
          onStack.set(w, true);
          callStack.push({ v: w, neighbors: adj.get(w) || [], i: 0 });
        } else if (onStack.get(w)) {
          low.set(frame.v, Math.min(low.get(frame.v), indices.get(w)));
        }
      } else {
        callStack.pop();
        if (callStack.length > 0) {
          const parent = callStack[callStack.length - 1];
          low.set(parent.v, Math.min(low.get(parent.v), low.get(frame.v)));
        }
        if (low.get(frame.v) === indices.get(frame.v)) {
          const comp = [];
          let w;
          do {
            w = stack.pop();
            onStack.set(w, false);
            comp.push(w);
          } while (w !== frame.v);
          comps.push(comp);
        }
      }
    }
  }

  return comps;
}

function collapseToFileGraph(nodes, edges) {
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const counts = new Map();
  for (const e of edges) {
    const sf = nodesById.get(e.source)?.file_path;
    const tf = nodesById.get(e.target)?.file_path;
    if (!sf || !tf || sf === tf) continue;
    const key = sf + SEP + tf;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const fileIds = new Set();
  const adj = new Map();
  for (const key of counts.keys()) {
    const [sf, tf] = key.split(SEP);
    fileIds.add(sf);
    fileIds.add(tf);
    if (!adj.has(sf)) adj.set(sf, []);
    adj.get(sf).push(tf);
  }

  const comps = stronglyConnectedComponents(fileIds, adj);
  const cyclicFiles = new Set();
  for (const comp of comps) if (comp.length > 1) for (const f of comp) cyclicFiles.add(f);

  const fileNodes = [...fileIds].sort().map((f) => ({
    id: 'file:' + f,
    kind: 'file',
    name: f.split('/').pop(),
    qualified_name: f,
    file_path: f,
    start_line: 1,
  }));

  const fileEdges = [...counts.entries()]
    .map(([key, count]) => {
      const [sf, tf] = key.split(SEP);
      return { source: 'file:' + sf, target: 'file:' + tf, kind: 'imports', count, isCycle: cyclicFiles.has(sf) && cyclicFiles.has(tf) };
    })
    .sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : a.target < b.target ? -1 : a.target > b.target ? 1 : 0));

  return { fileNodes, fileEdges, cycleCount: comps.filter((c) => c.length > 1).length };
}

function mount(rootEl, toolbarEl, ctx) {
  let destroyed = false;
  let controller = null;
  let requestToken = 0;
  const local = { group: ctx.state.group };
  let statusEl;
  let groupSelect;

  async function buildToolbar() {
    toolbarEl.innerHTML = '';
    const label = document.createElement('label');
    label.textContent = 'group';
    groupSelect = document.createElement('select');
    label.appendChild(groupSelect);
    toolbarEl.appendChild(label);

    statusEl = document.createElement('span');
    statusEl.className = 'status';
    toolbarEl.appendChild(statusEl);

    try {
      const { groups } = await ctx.api.groups();
      for (const g of groups) {
        const opt = document.createElement('option');
        opt.value = g.group;
        opt.textContent = g.group + ' (' + g.fileCount + ' files)';
        groupSelect.appendChild(opt);
      }
      if (groups.length > 0) {
        local.group = local.group && groups.some((g) => g.group === local.group) ? local.group : groups[0].group;
        groupSelect.value = local.group;
      }
    } catch (err) {
      statusEl.textContent = 'Error loading groups: ' + err.message;
      return;
    }
    groupSelect.addEventListener('change', () => {
      local.group = groupSelect.value;
      ctx.state.group = local.group;
      load();
    });
  }

  function showEmpty(message) {
    rootEl.innerHTML = '<div class="gw-empty">' + escapeHtml(message) + '</div>';
  }

  async function load() {
    if (!local.group) {
      showEmpty('No groups in this index.');
      return;
    }
    const token = ++requestToken;
    let data;
    try {
      data = await ctx.api.edges({ group: local.group, kinds: 'imports' });
    } catch (err) {
      if (destroyed || token !== requestToken) return;
      showEmpty('Error: ' + err.message);
      return;
    }
    if (destroyed || token !== requestToken) return;
    if (controller) controller.destroy();
    const { fileNodes, fileEdges, cycleCount } = collapseToFileGraph(data.nodes, data.edges);
    statusEl.textContent = fileNodes.length + ' files · ' + fileEdges.length + ' import edges' + (cycleCount > 0 ? ' · ' + cycleCount + ' import cycle(s) highlighted' : '');
    controller = renderForceGraph(
      rootEl,
      { nodes: fileNodes, edges: fileEdges },
      {
        positions: ctx.state.positions,
        onNodeDblClick: (n) => ctx.openInEditor(n),
        onNodeClick: (n) => ctx.navigateTo('explore', n),
      }
    );
  }

  buildToolbar().then(load);
  const unsubscribe = ctx.onIndexChanged(() => load());

  return {
    destroy() {
      destroyed = true;
      unsubscribe();
      if (controller) controller.destroy();
    },
  };
}

export default { id: 'imports', label: 'Imports', mount };
