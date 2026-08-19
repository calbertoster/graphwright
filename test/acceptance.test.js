import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, cpSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, 'bin', 'graphwright.mjs');
const FIXTURE_DIR = join(ROOT, 'test', 'fixture');
const FIXTURE_DB = join(FIXTURE_DIR, '.codegraph', 'codegraph.db');
const CODEGRAPH_BIN = join(ROOT, 'node_modules', '.bin', 'codegraph');

function runCli(args, { cwd = ROOT, env = process.env } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8' });
}

function ensureFixtureIndex() {
  if (existsSync(FIXTURE_DB)) return;
  const result = spawnSync(process.execPath, [CODEGRAPH_BIN, 'init', FIXTURE_DIR], { encoding: 'utf8' });
  assert.equal(result.status, 0, `codegraph init failed: ${result.stderr}\n${result.stdout}`);
}

function walkFilesRecursive(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFilesRecursive(full));
    else out.push(full);
  }
  return out.sort();
}

before(() => {
  ensureFixtureIndex();
});

test('view on a fixture class method at depth 2 emits DOT containing the known cross-file call edge; exit 0', () => {
  // sayHello (GreetingService, src/greeting-service.ts) calls greet (EnglishGreeter,
  // src/english-greeter.ts) — see SPEC.md §2 (2026-08-19) for why the origin symbol
  // is a class *method* rather than the class node itself: with `contains` excluded
  // from the default traversal kinds, a bare class node has no path to its own
  // methods, so it could never surface this cross-file edge at any depth.
  const result = runCli(['view', 'sayHello', '--depth', '2', '--format', 'dot', '--project', FIXTURE_DIR]);
  assert.equal(result.status, 0, result.stderr);

  const idLabel = new Map();
  for (const m of result.stdout.matchAll(/"([^"]+)" \[label="([^"]*)", shape=\w+\];/g)) {
    idLabel.set(m[1], m[2]);
  }
  let foundCrossFileCall = false;
  for (const m of result.stdout.matchAll(/"([^"]+)" -> "([^"]+)" \[color="[^"]*", label="calls"\];/g)) {
    const sourceLabel = idLabel.get(m[1]) ?? '';
    const targetLabel = idLabel.get(m[2]) ?? '';
    if (
      sourceLabel.includes('sayHello') &&
      sourceLabel.includes('greeting-service.ts') &&
      targetLabel.includes('greet') &&
      targetLabel.includes('english-greeter.ts')
    ) {
      foundCrossFileCall = true;
    }
  }
  assert.ok(foundCrossFileCall, `expected a "calls" edge sayHello -> greet in:\n${result.stdout}`);
});

test('view on an unknown symbol exits 3 with near-match suggestions', () => {
  // "Greet" matches no node exactly, but is a substring of Greeter, GreetingService,
  // and EnglishGreeter, so the LIKE-based suggestion path has real hits to report.
  const result = runCli(['view', 'Greet', '--project', FIXTURE_DIR]);
  assert.equal(result.status, 3);
  assert.match(result.stderr, /No symbol named "Greet" found/);
  assert.match(result.stderr, /Did you mean:/);
  assert.match(result.stderr, /Greet/);
});

test('wiki run twice produces byte-identical output (determinism)', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'graphwright-wiki-'));
  try {
    const run1 = runCli(['wiki', '--project', FIXTURE_DIR, '--out', outDir]);
    assert.equal(run1.status, 0, run1.stderr);
    const snapshot = mkdtempSync(join(tmpdir(), 'graphwright-wiki-snapshot-'));
    cpSync(outDir, snapshot, { recursive: true });

    const run2 = runCli(['wiki', '--project', FIXTURE_DIR, '--out', outDir]);
    assert.equal(run2.status, 0, run2.stderr);

    const filesBefore = walkFilesRecursive(snapshot);
    const filesAfter = walkFilesRecursive(outDir);
    assert.deepEqual(
      filesAfter.map((f) => f.slice(outDir.length)),
      filesBefore.map((f) => f.slice(snapshot.length))
    );
    for (let i = 0; i < filesBefore.length; i++) {
      const before = readFileSync(filesBefore[i]);
      const after = readFileSync(filesAfter[i]);
      assert.ok(before.equals(after), `byte mismatch in ${filesAfter[i].slice(outDir.length)}`);
    }
    rmSync(snapshot, { recursive: true, force: true });
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('a copied DB with a tampered schema_versions max warns on stderr but still attempts', () => {
  const tmpProject = mkdtempSync(join(tmpdir(), 'graphwright-tampered-'));
  try {
    cpSync(join(FIXTURE_DIR, '.codegraph'), join(tmpProject, '.codegraph'), { recursive: true });
    const dbPath = join(tmpProject, '.codegraph', 'codegraph.db');
    const db = new DatabaseSync(dbPath);
    db.exec('DELETE FROM schema_versions');
    db.prepare('INSERT INTO schema_versions (version, applied_at, description) VALUES (?, ?, ?)').run(
      99,
      0,
      'tampered-for-test'
    );
    db.close();

    const result = runCli(['view', 'sayHello', '--format', 'dot', '--project', tmpProject]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /warning:.*schema version is 99/);
  } finally {
    rmSync(tmpProject, { recursive: true, force: true });
  }
});

test('dot absent from PATH falls back to .dot output with a notice; exit 0', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'graphwright-nodot-'));
  try {
    const outSvg = join(outDir, 'out.svg');
    const nodeDir = dirname(process.execPath);
    const result = runCli(['view', 'sayHello', '--project', FIXTURE_DIR, '-o', outSvg], {
      env: { ...process.env, PATH: nodeDir },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /graphviz "dot" is unavailable/);
    const outDot = join(outDir, 'out.dot');
    assert.ok(existsSync(outDot), 'expected .dot fallback file to exist');
    assert.ok(!existsSync(outSvg), 'expected no .svg file to be written');
    const dotText = readFileSync(outDot, 'utf8');
    assert.match(dotText, /^digraph neighborhood \{/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
