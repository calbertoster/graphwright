#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runView } from '../src/view.mjs';
import { runWiki } from '../src/wiki.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

const HELP = `Usage: graphwright <command> [options]

Commands:
  view <symbol>   Render a filtered neighborhood of a symbol
  wiki            Generate a browsable markdown wiki

Options:
  -h, --help      Show help
  -V, --version   Show version

Run "graphwright view --help" or "graphwright wiki --help" for command-specific options.
`;

const VIEW_HELP = `Usage: graphwright view <symbol> [options]

Options:
  --depth <n>               Traversal depth (default: 2)
  --direction <dir>         both|callers|callees (default: both)
  --kinds <k1,k2,...>       Edge kinds to traverse (default: calls,references,imports)
  --format <fmt>            svg|dot|mermaid (default: svg)
  -o, --output <path>       Write to a file instead of stdout
  --pick <n>                Select candidate N when the symbol is ambiguous
  --force                   Raise the neighborhood size cap to 1500
  --project <path>          Project directory (overrides index auto-discovery)
  -h, --help                 Show this help
`;

const WIKI_HELP = `Usage: graphwright wiki [options]

Options:
  --out <dir>                Output directory (default: docs/codegraph-wiki)
  --group-depth <n>          Directory-prefix segments per group (default: 2)
  --banner <template>        Banner template ({cmd} and {date} placeholders)
  --max-diagram-edges <n>    Diagram edge cap before falling back to a list (default: 150)
  --project <path>           Project directory (overrides index auto-discovery)
  -h, --help                  Show this help
`;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseInt_(value, flagName, { min }) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) {
    fail(`Invalid ${flagName}: "${value}" (must be an integer >= ${min})`);
  }
  return n;
}

const argv = process.argv.slice(2);
const command = argv[0];

if (command === undefined || command === '-h' || command === '--help') {
  process.stdout.write(HELP);
  process.exit(command === undefined ? 1 : 0);
}

if (command === '-V' || command === '--version') {
  process.stdout.write(`${pkg.version}\n`);
  process.exit(0);
}

const rest = argv.slice(1);
const cmdLine = ['graphwright', ...argv].join(' ');

if (command === 'view') {
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: rest,
      options: {
        depth: { type: 'string', default: '2' },
        direction: { type: 'string', default: 'both' },
        kinds: { type: 'string', default: 'calls,references,imports' },
        format: { type: 'string', default: 'svg' },
        output: { type: 'string', short: 'o' },
        pick: { type: 'string' },
        force: { type: 'boolean', default: false },
        project: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: true,
    }));
  } catch (err) {
    fail(err.message);
  }

  if (values.help) {
    process.stdout.write(VIEW_HELP);
    process.exit(0);
  }

  const symbol = positionals[0];
  if (!symbol) fail(`graphwright view: missing <symbol>\n\n${VIEW_HELP}`);

  const depth = parseInt_(values.depth, '--depth', { min: 1 });
  if (!['both', 'callers', 'callees'].includes(values.direction)) {
    fail(`Invalid --direction: "${values.direction}" (must be both|callers|callees)`);
  }
  if (!['svg', 'dot', 'mermaid'].includes(values.format)) {
    fail(`Invalid --format: "${values.format}" (must be svg|dot|mermaid)`);
  }
  const kinds = values.kinds
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  if (kinds.length === 0) fail('--kinds must list at least one edge kind');
  let pick = null;
  if (values.pick != null) {
    pick = parseInt_(values.pick, '--pick', { min: 1 });
  }

  const exitCode = runView(
    {
      symbol,
      depth,
      direction: values.direction,
      kinds,
      format: values.format,
      output: values.output,
      pick,
      force: values.force,
      project: values.project,
    },
    { cwd: process.cwd(), stdout: process.stdout, stderr: process.stderr }
  );
  process.exit(exitCode);
} else if (command === 'wiki') {
  let values;
  try {
    ({ values } = parseArgs({
      args: rest,
      options: {
        out: { type: 'string', default: 'docs/codegraph-wiki' },
        'group-depth': { type: 'string', default: '2' },
        banner: { type: 'string' },
        'max-diagram-edges': { type: 'string', default: '150' },
        project: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: false,
    }));
  } catch (err) {
    fail(err.message);
  }

  if (values.help) {
    process.stdout.write(WIKI_HELP);
    process.exit(0);
  }

  const groupDepth = parseInt_(values['group-depth'], '--group-depth', { min: 0 });
  const maxDiagramEdges = parseInt_(values['max-diagram-edges'], '--max-diagram-edges', { min: 0 });

  const exitCode = runWiki(
    {
      out: values.out,
      groupDepth,
      banner: values.banner,
      maxDiagramEdges,
      project: values.project,
      cmd: cmdLine,
    },
    { cwd: process.cwd(), stdout: process.stdout, stderr: process.stderr }
  );
  process.exit(exitCode);
} else {
  fail(`Unknown command: "${command}"\n\n${HELP}`);
}
