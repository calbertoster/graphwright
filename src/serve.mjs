import { createServer as createHttpServer } from 'node:http';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { join, extname, resolve as resolvePath, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { resolveIndexPath, openIndex, getMaxUpdatedAt } from './db.mjs';
import * as api from './api.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolvePath(__dirname, '..');
const PUBLIC_ROOT = resolvePath(PKG_ROOT, 'public');
const VENDOR_ROOT = resolvePath(PKG_ROOT, 'vendor');

const POLL_MS = 1000;
const DEFAULT_EDITOR_URL = 'vscode://file/{path}:{line}';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

/** Resolve `relPath` (starting with "/") under `root`, refusing to escape it. */
function safeStaticPath(root, relPath) {
  const full = resolvePath(root, '.' + relPath);
  if (full !== root && !full.startsWith(root + sep)) return null;
  return full;
}

function serveStatic(root, relPath, res) {
  const full = relPath ? safeStaticPath(root, relPath) : null;
  if (!full || !existsSync(full) || !statSync(full).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  const type = CONTENT_TYPES[extname(full)] ?? 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type });
  res.end(readFileSync(full));
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function fingerprintOf(db, dbPath) {
  let mtime = null;
  try {
    mtime = statSync(dbPath).mtimeMs;
  } catch {
    mtime = null;
  }
  let maxUpdated = null;
  try {
    maxUpdated = getMaxUpdatedAt(db);
  } catch {
    maxUpdated = null;
  }
  return `${mtime}:${maxUpdated}`;
}

/**
 * Build the http.Server for `graphwright serve` (SPEC §10.3). Not yet
 * listening — caller calls `.listen(port)`. Exposes `.gwClose()` to stop
 * the change-poll timer and close the db handle (beyond the base
 * `.close()`, which only stops accepting new connections).
 */
export function createApp({ dbPath, editorUrlTemplate = DEFAULT_EDITOR_URL }) {
  const { db, warning } = openIndex(dbPath);

  const sseClients = new Set();
  let lastFingerprint = fingerprintOf(db, dbPath);

  const pollTimer = setInterval(() => {
    const fp = fingerprintOf(db, dbPath);
    if (fp !== lastFingerprint) {
      lastFingerprint = fp;
      for (const client of sseClients) client.write('event: index-changed\ndata: {}\n\n');
    }
  }, POLL_MS);
  pollTimer.unref?.();

  function handleApi(req, res, url) {
    const { pathname, searchParams } = url;
    try {
      if (pathname === '/api/meta' && req.method === 'GET') {
        return sendJson(res, 200, api.buildMeta(db, { editorUrlTemplate }));
      }
      if (pathname === '/api/search' && req.method === 'GET') {
        return sendJson(res, 200, api.buildSearch(db, { q: searchParams.get('q'), limit: searchParams.get('limit') }));
      }
      if (pathname === '/api/files' && req.method === 'GET') {
        return sendJson(res, 200, api.buildFiles(db, { depth: searchParams.get('depth') }));
      }
      if (pathname === '/api/groups' && req.method === 'GET') {
        return sendJson(res, 200, api.buildGroups(db, { depth: searchParams.get('depth') }));
      }
      if (pathname === '/api/edges' && req.method === 'GET') {
        return sendJson(
          res,
          200,
          api.buildEdges(db, {
            kinds: searchParams.get('kinds'),
            group: searchParams.get('group'),
            file: searchParams.get('file'),
            depth: searchParams.get('depth'),
          })
        );
      }
      if (pathname.startsWith('/api/node/') && req.method === 'GET') {
        const id = decodeURIComponent(pathname.slice('/api/node/'.length));
        return sendJson(res, 200, api.buildNode(db, id));
      }
      if (pathname.startsWith('/api/neighborhood/') && req.method === 'GET') {
        const id = decodeURIComponent(pathname.slice('/api/neighborhood/'.length));
        return sendJson(res, 200, api.buildNeighborhood(db, id, {
          depth: searchParams.get('depth'),
          kinds: searchParams.get('kinds'),
          direction: searchParams.get('direction'),
          cap: searchParams.get('cap'),
        }));
      }
      if (pathname === '/api/events' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(': connected\n\n');
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }
      return sendJson(res, 404, { error: `No such API route: ${pathname}` });
    } catch (err) {
      if (err instanceof api.ApiError) return sendJson(res, err.status, { error: err.message });
      return sendJson(res, 500, { error: err.message });
    }
  }

  function requestListener(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Method not allowed');
    }
    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
    if (url.pathname.startsWith('/vendor/')) {
      return serveStatic(VENDOR_ROOT, url.pathname.slice('/vendor'.length), res);
    }
    if (url.pathname === '/') return serveStatic(PUBLIC_ROOT, '/index.html', res);
    return serveStatic(PUBLIC_ROOT, url.pathname, res);
  }

  const server = createHttpServer(requestListener);
  server.gwClose = () => {
    clearInterval(pollTimer);
    for (const client of sseClients) client.end();
    try {
      db.close();
    } catch {
      // already closed
    }
  };
  server.on('close', server.gwClose);
  return { server, db, warning };
}

function tryOpenBrowser(url) {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    // A missing opener (headless boxes, containers, minimal images) fails
    // ASYNCHRONOUSLY: spawn returns, then emits 'error'. An unhandled 'error'
    // on a ChildProcess throws and would kill the server we just started —
    // so this listener is load-bearing, not defensive. try/catch cannot
    // reach it. Serving is the job; opening a browser is a convenience.
    child.on('error', () => {
      process.stderr.write(`(could not launch a browser — open ${url} yourself)\n`);
    });
    child.unref();
  } catch {
    // best-effort only
  }
}

/**
 * Run `graphwright serve`. Unlike `view`/`wiki`, success means the server is
 * now listening and the process should keep running — returns `null` in
 * that case (the caller must NOT process.exit). Returns a numeric exit code
 * only when startup failed (bad index, port unavailable, etc.).
 */
export function runServe({ port, project, editorUrl, open }, { cwd, stdout, stderr }) {
  const resolved = resolveIndexPath({ cwd, project });
  if (resolved.error) {
    stderr.write(resolved.error + '\n');
    return Promise.resolve(resolved.code);
  }

  let app;
  try {
    app = createApp({ dbPath: resolved.path, editorUrlTemplate: editorUrl || DEFAULT_EDITOR_URL });
  } catch (err) {
    stderr.write(err.message + '\n');
    return Promise.resolve(err.code ?? 1);
  }
  if (app.warning) stderr.write(`warning: ${app.warning}\n`);

  return new Promise((resolvePromise) => {
    app.server.once('error', (err) => {
      stderr.write(`Failed to start server: ${err.message}\n`);
      app.server.gwClose();
      resolvePromise(1);
    });
    app.server.listen(port, () => {
      const url = `http://localhost:${app.server.address().port}`;
      stdout.write(`graphwright serve — ${url} (project: ${resolved.path})\n`);
      if (open) tryOpenBrowser(url);
      resolvePromise(null);
    });
  });
}
