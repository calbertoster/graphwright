import { renderForceGraph } from './forcegraph.mjs';

const ALL_KINDS = ['calls', 'references', 'imports', 'contains', 'implements', 'decorates', 'instantiates'];
const DEFAULT_KINDS = new Set(['calls', 'references', 'imports']);
const CAP_STEP = 300;
const MAX_CAP = 1500;

function mount(rootEl, toolbarEl, ctx) {
  let destroyed = false;
  let controller = null;
  const local = { depth: 2, direction: 'both', kinds: new Set(DEFAULT_KINDS), cap: CAP_STEP };
  let statusEl;

  function buildToolbar() {
    toolbarEl.innerHTML = '';

    const depthLabel = document.createElement('label');
    depthLabel.textContent = 'depth';
    const depthInput = document.createElement('input');
    depthInput.type = 'number';
    depthInput.min = '1';
    depthInput.max = '10';
    depthInput.value = String(local.depth);
    depthInput.style.width = '3.5em';
    depthInput.addEventListener('change', () => {
      local.depth = Math.max(1, Math.min(10, Number(depthInput.value) || 2));
      load();
    });
    depthLabel.appendChild(depthInput);
    toolbarEl.appendChild(depthLabel);

    const dirLabel = document.createElement('label');
    dirLabel.textContent = 'direction';
    const dirSelect = document.createElement('select');
    for (const opt of ['both', 'callers', 'callees']) {
      const o = document.createElement('option');
      o.value = opt;
      o.textContent = opt;
      dirSelect.appendChild(o);
    }
    dirSelect.value = local.direction;
    dirSelect.addEventListener('change', () => {
      local.direction = dirSelect.value;
      load();
    });
    dirLabel.appendChild(dirSelect);
    toolbarEl.appendChild(dirLabel);

    const kindsLabel = document.createElement('label');
    kindsLabel.textContent = 'kinds';
    for (const k of ALL_KINDS) {
      const id = `kind-${k}`;
      const wrap = document.createElement('label');
      wrap.style.marginRight = '4px';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.id = id;
      cb.checked = local.kinds.has(k);
      cb.addEventListener('change', () => {
        if (cb.checked) local.kinds.add(k);
        else local.kinds.delete(k);
        load();
      });
      wrap.appendChild(cb);
      wrap.appendChild(document.createTextNode(k));
      kindsLabel.appendChild(wrap);
    }
    toolbarEl.appendChild(kindsLabel);

    const loadMoreBtn = document.createElement('button');
    loadMoreBtn.textContent = 'Load more';
    loadMoreBtn.addEventListener('click', () => {
      local.cap = Math.min(MAX_CAP, local.cap + CAP_STEP);
      load();
    });
    toolbarEl.appendChild(loadMoreBtn);

    statusEl = document.createElement('span');
    statusEl.className = 'status';
    toolbarEl.appendChild(statusEl);
  }

  function showEmpty(message) {
    rootEl.innerHTML = `<div class="gw-empty">${message}</div>`;
  }

  function setOrigin(node) {
    ctx.state.selection = node;
    load();
  }

  async function load() {
    const origin = ctx.state.selection;
    if (!origin) {
      showEmpty('Search for a symbol above to explore its neighborhood.');
      if (statusEl) statusEl.textContent = '';
      return;
    }
    if (controller) controller.destroy();
    let data;
    try {
      data = await ctx.api.neighborhood(origin.id, {
        depth: local.depth,
        direction: local.direction,
        kinds: [...local.kinds].join(','),
        cap: local.cap,
      });
    } catch (err) {
      showEmpty(`Error: ${err.message}`);
      return;
    }
    if (destroyed) return;
    statusEl.textContent = `${data.nodes.length} nodes · ${data.edges.length} edges${data.overflow ? ' (capped — Load more for the rest)' : ''}`;
    controller = renderForceGraph(
      rootEl,
      { nodes: data.nodes, edges: data.edges },
      {
        positions: ctx.state.positions,
        highlightId: origin.id,
        onNodeClick: (n) => setOrigin(n),
        onNodeDblClick: (n) => ctx.openInEditor(n),
      }
    );
  }

  buildToolbar();
  load();
  const unsubscribe = ctx.onIndexChanged(() => load());

  return {
    destroy() {
      destroyed = true;
      unsubscribe();
      if (controller) controller.destroy();
    },
  };
}

export default { id: 'explore', label: 'Explore', mount };
