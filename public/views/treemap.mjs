import d3 from '/vendor/d3.mjs';

const W = 1000;
const H = 700;
const color = d3.scaleOrdinal(d3.schemeTableau10);

function annotateWithSizeAndLanguage(node) {
  if (node.path) {
    node.value = Math.max(1, node.node_count || 1);
    return node.language || 'unknown';
  }
  const langs = new Set();
  for (const child of node.children || []) langs.add(annotateWithSizeAndLanguage(child));
  node._languages = langs;
  return langs.size === 1 ? [...langs][0] : 'mixed';
}

function mount(rootEl, toolbarEl, ctx) {
  let destroyed = false;
  let statusEl;

  toolbarEl.innerHTML = '';
  statusEl = document.createElement('span');
  statusEl.className = 'status';
  statusEl.textContent = 'sized by node count · colored by language · click a file to explore it';
  toolbarEl.appendChild(statusEl);

  function showEmpty(message) {
    rootEl.innerHTML = '<div class="gw-empty">' + message + '</div>';
  }

  async function load() {
    let tree;
    try {
      tree = await ctx.api.files();
    } catch (err) {
      showEmpty('Error: ' + err.message);
      return;
    }
    if (destroyed) return;
    if (!tree.children || tree.children.length === 0) {
      showEmpty('No files in this index.');
      return;
    }
    annotateWithSizeAndLanguage(tree);

    rootEl.innerHTML = '';
    const svg = d3.select(rootEl).append('svg').attr('viewBox', '0 0 ' + W + ' ' + H);

    const root = d3
      .hierarchy(tree)
      .sum((d) => (d.path ? d.value : 0))
      .sort((a, b) => b.value - a.value);
    d3.treemap().tile(d3.treemapSquarify).size([W, H]).paddingInner(2).paddingOuter(2)(root);

    const leaves = root.leaves();
    const cell = svg
      .selectAll('g')
      .data(leaves)
      .join('g')
      .attr('transform', (d) => 'translate(' + d.x0 + ',' + d.y0 + ')');

    cell
      .append('rect')
      .attr('width', (d) => Math.max(0, d.x1 - d.x0))
      .attr('height', (d) => Math.max(0, d.y1 - d.y0))
      .attr('fill', (d) => color(d.data.language || 'unknown'))
      .attr('stroke', '#fff')
      .style('cursor', 'pointer')
      .on('click', (event, d) => {
        ctx.navigateTo('explore', {
          id: 'file:' + d.data.path,
          kind: 'file',
          name: d.data.name,
          qualified_name: d.data.path,
          file_path: d.data.path,
          start_line: 1,
        });
      })
      .on('dblclick', (event, d) => ctx.openInEditor({ file_path: d.data.path, start_line: 1 }))
      .append('title')
      .text((d) => d.data.path + ' — ' + d.data.node_count + ' symbols (' + (d.data.language || 'unknown') + ')');

    cell
      .append('text')
      .attr('x', 4)
      .attr('y', 13)
      .style('font-size', '10px')
      .style('fill', '#fff')
      .style('pointer-events', 'none')
      .text((d) => ((d.x1 - d.x0 > 40 && d.y1 - d.y0 > 16) ? d.data.name : ''));

    const langs = [...new Set(leaves.map((d) => d.data.language || 'unknown'))].sort();
    const legend = document.createElement('div');
    legend.className = 'legend';
    legend.innerHTML = langs
      .map((l) => '<div><span class="swatch" style="background:' + color(l) + '"></span>' + l + '</div>')
      .join('');
    rootEl.appendChild(legend);

    statusEl.textContent = leaves.length + ' files · sized by node count · colored by language';
  }

  load();
  const unsubscribe = ctx.onIndexChanged(() => load());

  return {
    destroy() {
      destroyed = true;
      unsubscribe();
    },
  };
}

export default { id: 'treemap', label: 'Treemap', mount };
