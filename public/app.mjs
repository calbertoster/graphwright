import exploreView from './views/explore.mjs';
import importsView from './views/imports.mjs';
import callsView from './views/calls.mjs';
import treemapView from './views/treemap.mjs';

const VIEWS = [exploreView, importsView, callsView, treemapView];
const VIEW_BY_ID = new Map(VIEWS.map((v) => [v.id, v]));

async function apiGet(path) {
  const res = await fetch(path);
  let body;
  try {
    body = await res.json();
  } catch {
    body = { error: `HTTP ${res.status}` };
  }
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

const api = {
  meta: () => apiGet('/api/meta'),
  search: (q, limit) => apiGet(`/api/search?${new URLSearchParams({ q, ...(limit ? { limit } : {}) })}`),
  node: (id) => apiGet(`/api/node/${encodeURIComponent(id)}`),
  neighborhood: (id, params = {}) =>
    apiGet(`/api/neighborhood/${encodeURIComponent(id)}?${new URLSearchParams(clean(params))}`),
  files: () => apiGet('/api/files'),
  groups: (depth) => apiGet(`/api/groups${depth != null ? `?${new URLSearchParams({ depth })}` : ''}`),
  edges: (params = {}) => apiGet(`/api/edges?${new URLSearchParams(clean(params))}`),
};

function clean(params) {
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') out[k] = v;
  }
  return out;
}

// Shared, cross-view state — SPEC §10.4 ("shared search/selection state") and
// §10.3 ("client... preserves layout positions keyed by node id").
const state = {
  editorUrlTemplate: 'vscode://file/{path}:{line}',
  selection: null, // last thing the user searched/picked: {id, kind, name, file_path, start_line}
  positions: new Map(), // nodeId -> {x, y}, shared across views + SSE refreshes
  group: null,
  file: null,
};

function openInEditor(node) {
  if (!node || !node.file_path) return;
  const line = node.start_line ?? 1;
  const url = state.editorUrlTemplate.replaceAll('{path}', node.file_path).replaceAll('{line}', String(line));
  window.location.href = url;
}

const indexChangeListeners = new Set();
function onIndexChanged(cb) {
  indexChangeListeners.add(cb);
  return () => indexChangeListeners.delete(cb);
}

const ctx = {
  api,
  state,
  openInEditor,
  onIndexChanged,
  navigateTo,
};

const els = {
  tabs: document.getElementById('tabs'),
  toolbar: document.getElementById('toolbar'),
  viewRoot: document.getElementById('view-root'),
  metaLine: document.getElementById('meta-line'),
  sseDot: document.getElementById('sse-dot'),
  searchInput: document.getElementById('search-input'),
  searchResults: document.getElementById('search-results'),
};

let currentView = null;
let currentController = null;

function mountView(id) {
  const view = VIEW_BY_ID.get(id) ?? VIEWS[0];
  if (currentController && typeof currentController.destroy === 'function') currentController.destroy();
  els.toolbar.innerHTML = '';
  els.viewRoot.innerHTML = '';
  currentView = view.id;
  [...els.tabs.children].forEach((btn) => btn.classList.toggle('active', btn.dataset.view === view.id));
  currentController = view.mount(els.viewRoot, els.toolbar, ctx) || null;
}

function navigateTo(viewId, selection) {
  if (selection) state.selection = selection;
  mountView(viewId);
}

els.tabs.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-view]');
  if (btn) mountView(btn.dataset.view);
});

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  const map = { 1: 'explore', 2: 'imports', 3: 'calls', 4: 'treemap' };
  if (map[e.key]) mountView(map[e.key]);
});

// --- search -----------------------------------------------------------
let searchAbort = null;
let searchSelIndex = -1;

async function runSearch(q) {
  if (!q.trim()) {
    els.searchResults.classList.remove('open');
    els.searchResults.innerHTML = '';
    return;
  }
  if (searchAbort) searchAbort.aborted = true;
  const token = { aborted: false };
  searchAbort = token;
  let result;
  try {
    result = await api.search(q, 15);
  } catch {
    return;
  }
  if (token.aborted) return;
  searchSelIndex = -1;
  els.searchResults.innerHTML = '';
  for (const c of result.candidates) {
    const row = document.createElement('div');
    row.innerHTML = `<span class="kind">${escapeHtml(c.kind)}</span>${escapeHtml(c.name)}<span class="loc">${escapeHtml(c.qualified_name || '')} — ${escapeHtml(c.file_path)}:${c.start_line}</span>`;
    row.addEventListener('click', () => pickCandidate(c));
    els.searchResults.appendChild(row);
  }
  els.searchResults.classList.toggle('open', result.candidates.length > 0);
}

function pickCandidate(c) {
  state.selection = c;
  els.searchResults.classList.remove('open');
  els.searchInput.value = c.name;
  navigateTo('explore', c);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let searchDebounce = null;
els.searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => runSearch(els.searchInput.value), 150);
});
els.searchInput.addEventListener('keydown', (e) => {
  const rows = [...els.searchResults.children];
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (rows.length === 0) return;
    searchSelIndex = (searchSelIndex + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
    rows.forEach((r, i) => r.classList.toggle('sel', i === searchSelIndex));
    rows[searchSelIndex].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter' && searchSelIndex >= 0 && rows[searchSelIndex]) {
    rows[searchSelIndex].click();
  } else if (e.key === 'Escape') {
    els.searchResults.classList.remove('open');
  }
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-box')) els.searchResults.classList.remove('open');
});

// --- meta + SSE ---------------------------------------------------------
async function loadMeta() {
  try {
    const meta = await api.meta();
    state.editorUrlTemplate = meta.editorUrlTemplate || state.editorUrlTemplate;
    els.metaLine.innerHTML = `<span class="sse-dot" id="sse-dot"></span>${meta.nodeCount} nodes · ${meta.edgeCount} edges · ${meta.fileCount} files · schema v${meta.schemaVersion}`;
    els.sseDot = document.getElementById('sse-dot');
  } catch (err) {
    els.metaLine.textContent = `meta unavailable: ${err.message}`;
  }
}

function connectSSE() {
  const es = new EventSource('/api/events');
  es.addEventListener('open', () => els.sseDot && els.sseDot.classList.add('live'));
  es.addEventListener('error', () => els.sseDot && els.sseDot.classList.remove('live'));
  es.addEventListener('index-changed', () => {
    loadMeta();
    for (const cb of indexChangeListeners) cb();
  });
}

loadMeta();
connectSSE();
mountView('explore');
