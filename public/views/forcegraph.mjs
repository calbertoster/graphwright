import d3 from '/vendor/d3.mjs';

const W = 1000;
const H = 700;

const NODE_COLOR = {
  class: '#4e79a7',
  interface: '#4e79a7',
  component: '#4e79a7',
  route: '#e15759',
  file: '#9c755f',
  function: '#59a14f',
  method: '#59a14f',
  property: '#af7aa1',
  variable: '#af7aa1',
  constant: '#edc949',
  enum: '#76b7b2',
  enum_member: '#76b7b2',
  type_alias: '#76b7b2',
  import: '#bab0ab',
};
const DEFAULT_NODE_COLOR = '#888';

const NODE_RADIUS = { file: 9, class: 8, interface: 8, component: 8, route: 7 };
const DEFAULT_RADIUS = 5;

const EDGE_COLOR = {
  calls: '#1f77b4',
  imports: '#7f7f7f',
  references: '#333',
  implements: '#2ca02c',
  decorates: '#9467bd',
  instantiates: '#ff7f0e',
  contains: '#cccccc',
};
const DEFAULT_EDGE_COLOR = '#555';

function nodeColor(kind) {
  return NODE_COLOR[kind] ?? DEFAULT_NODE_COLOR;
}
function nodeRadius(kind) {
  return NODE_RADIUS[kind] ?? DEFAULT_RADIUS;
}
function edgeColor(kind) {
  return EDGE_COLOR[kind] ?? DEFAULT_EDGE_COLOR;
}

/**
 * A reusable force-directed graph renderer shared by the Explore and Calls
 * views (SPEC §10.4). `container` is emptied and filled with a zoomable,
 * pannable <svg>. `positions` (Map<nodeId,{x,y}>) is read for initial
 * placement and written on every tick, so callers can carry it across
 * re-renders (SSE refresh, control changes) for stable layout per SPEC §10.3.
 */
export function renderForceGraph(container, { nodes, edges }, opts = {}) {
  const { positions = new Map(), onNodeClick, onNodeDblClick, highlightId } = opts;

  container.innerHTML = '';
  if (nodes.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'gw-empty';
    empty.textContent = 'No nodes to show.';
    container.appendChild(empty);
    return { destroy() {}, update() {} };
  }

  const svg = d3.select(container).append('svg').attr('viewBox', `0 0 ${W} ${H}`);
  const g = svg.append('g');
  const zoom = d3.zoom().scaleExtent([0.1, 5]).on('zoom', (event) => g.attr('transform', event.transform));
  svg.call(zoom);

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const simNodes = nodes.map((n) => {
    const p = positions.get(n.id);
    return { ...n, x: p?.x ?? W / 2 + (Math.random() - 0.5) * 40, y: p?.y ?? H / 2 + (Math.random() - 0.5) * 40 };
  });
  const simNodeById = new Map(simNodes.map((n) => [n.id, n]));
  const simLinks = edges
    .filter((e) => simNodeById.has(e.source) && simNodeById.has(e.target))
    .map((e) => ({ ...e, source: e.source, target: e.target }));

  const simulation = d3
    .forceSimulation(simNodes)
    .force(
      'link',
      d3
        .forceLink(simLinks)
        .id((d) => d.id)
        .distance(60)
        .strength(0.3)
    )
    .force('charge', d3.forceManyBody().strength(-140))
    .force('center', d3.forceCenter(W / 2, H / 2))
    .force('collide', d3.forceCollide((d) => nodeRadius(d.kind) + 12));

  const linkSel = g
    .append('g')
    .selectAll('line')
    .data(simLinks)
    .join('line')
    .attr('class', (d) => (d.isCycle ? 'gw-edge cycle' : 'gw-edge'))
    .attr('stroke', (d) => edgeColor(d.kind))
    .attr('stroke-width', 1.2);

  const nodeSel = g
    .append('g')
    .selectAll('g.gw-node')
    .data(simNodes)
    .join('g')
    .attr('class', 'gw-node')
    .call(
      d3
        .drag()
        .on('start', (event, d) => {
          if (!event.active) simulation.alphaTarget(0.2).restart();
          d.fx = d.x;
          d.fy = d.y;
        })
        .on('drag', (event, d) => {
          d.fx = event.x;
          d.fy = event.y;
        })
        .on('end', (event, d) => {
          if (!event.active) simulation.alphaTarget(0);
          d.fx = null;
          d.fy = null;
        })
    );

  nodeSel
    .append('circle')
    .attr('r', (d) => nodeRadius(d.kind))
    .attr('fill', (d) => nodeColor(d.kind))
    .attr('stroke', (d) => (highlightId && d.id === highlightId ? '#e15759' : '#fff'))
    .attr('stroke-width', (d) => (highlightId && d.id === highlightId ? 3 : 1));

  nodeSel
    .append('text')
    .attr('x', (d) => nodeRadius(d.kind) + 3)
    .attr('y', 3)
    .text((d) => d.name);

  nodeSel.append('title').text((d) => `${d.kind} ${d.qualified_name || d.name}\n${d.file_path}:${d.start_line}`);

  if (onNodeClick) nodeSel.on('click', (event, d) => onNodeClick(nodeById.get(d.id) ?? d));
  if (onNodeDblClick) nodeSel.on('dblclick', (event, d) => onNodeDblClick(nodeById.get(d.id) ?? d));

  simulation.on('tick', () => {
    linkSel
      .attr('x1', (d) => d.source.x)
      .attr('y1', (d) => d.source.y)
      .attr('x2', (d) => d.target.x)
      .attr('y2', (d) => d.target.y);
    nodeSel.attr('transform', (d) => `translate(${d.x},${d.y})`);
    for (const n of simNodes) positions.set(n.id, { x: n.x, y: n.y });
  });

  return {
    destroy() {
      simulation.stop();
      container.innerHTML = '';
    },
  };
}
