import { renderForceGraph } from './forcegraph.mjs';

const GROUP_DEPTH = 2; // matches api.mjs's DEFAULT_GROUP_DEPTH

function groupForPath(filePath, depth) {
  const parts = filePath.split('/');
  parts.pop();
  const truncated = parts.slice(0, Math.max(0, depth));
  return truncated.length === 0 ? '.' : truncated.join('/');
}

function flattenFiles(node, out) {
  if (node.path) {
    out.push(node);
    return out;
  }
  for (const child of node.children || []) flattenFiles(child, out);
  return out;
}

function mount(rootEl, toolbarEl, ctx) {
  let destroyed = false;
  let controller = null;
  const local = { group: ctx.state.group, file: ctx.state.file, kinds: new Set(['calls', 'references']) };
  let statusEl;
  let groupSelect;
  let fileSelect;

  function showEmpty(message) {
    rootEl.innerHTML = '<div class="gw-empty">' + message + '</div>';
  }

  async function refreshFileOptions() {
    fileSelect.innerHTML = '';
    const anyOpt = document.createElement('option');
    anyOpt.value = '';
    anyOpt.textContent = '(whole group)';
    fileSelect.appendChild(anyOpt);
    if (!local.group) return;
    try {
      const tree = await ctx.api.files();
      const files = flattenFiles(tree, []).filter((f) => groupForPath(f.path, GROUP_DEPTH) === local.group);
      files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      for (const f of files) {
        const opt = document.createElement('option');
        opt.value = f.path;
        opt.textContent = f.path;
        fileSelect.appendChild(opt);
      }
      fileSelect.value = local.file && files.some((f) => f.path === local.file) ? local.file : '';
    } catch {
      // ignore — file list is a nice-to-have, group scoping still works
    }
  }

  async function buildToolbar() {
    toolbarEl.innerHTML = '';

    const groupLabel = document.createElement('label');
    groupLabel.textContent = 'group';
    groupSelect = document.createElement('select');
    groupLabel.appendChild(groupSelect);
    toolbarEl.appendChild(groupLabel);

    const fileLabel = document.createElement('label');
    fileLabel.textContent = 'file';
    fileSelect = document.createElement('select');
    fileLabel.appendChild(fileSelect);
    toolbarEl.appendChild(fileLabel);
    fileSelect.addEventListener('change', () => {
      local.file = fileSelect.value || null;
      ctx.state.file = local.file;
      load();
    });

    for (const kind of ['calls', 'references']) {
      const wrap = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = local.kinds.has(kind);
      cb.addEventListener('change', () => {
        if (cb.checked) local.kinds.add(kind);
        else local.kinds.delete(kind);
        load();
      });
      wrap.appendChild(cb);
      wrap.appendChild(document.createTextNode(kind));
      toolbarEl.appendChild(wrap);
    }

    statusEl = document.createElement('span');
    statusEl.className = 'status';
    toolbarEl.appendChild(statusEl);

    try {
      const { groups } = await ctx.api.groups();
      for (const g of groups) {
        const opt = document.createElement('option');
        opt.value = g.group;
        opt.textContent = g.group + ' (' + g.symbolCount + ' symbols)';
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
    await refreshFileOptions();
    groupSelect.addEventListener('change', async () => {
      local.group = groupSelect.value;
      local.file = null;
      ctx.state.group = local.group;
      ctx.state.file = null;
      await refreshFileOptions();
      load();
    });
  }

  async function load() {
    if (!local.group) {
      showEmpty('No groups in this index.');
      return;
    }
    if (local.kinds.size === 0) {
      showEmpty('Enable at least one edge kind above.');
      return;
    }
    if (controller) controller.destroy();
    let data;
    try {
      data = await ctx.api.edges(
        local.file
          ? { file: local.file, kinds: [...local.kinds].join(',') }
          : { group: local.group, kinds: [...local.kinds].join(',') }
      );
    } catch (err) {
      showEmpty('Error: ' + err.message);
      return;
    }
    if (destroyed) return;
    statusEl.textContent = data.nodes.length + ' symbols · ' + data.edges.length + ' edges';
    controller = renderForceGraph(
      rootEl,
      { nodes: data.nodes, edges: data.edges },
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

export default { id: 'calls', label: 'Calls', mount };
