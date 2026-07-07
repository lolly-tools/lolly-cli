#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0
/**
 * brand-tool CLI
 *
 * Usage:
 *   brand-tool                                    # list tools
 *   brand-tool <tool-id>                          # show inputs for a tool
 *   brand-tool <tool-id> --foo=bar                # run, write to stdout
 *   brand-tool <tool-id> --foo=bar --output=f.svg # run, write to file
 *   brand-tool <tool-id> --foo=bar --export=svg   # explicit format
 *   brand-tool <tool-id> --foo=bar --c2pa=30      # stamp Content Credentials
 *                                                 # (7|30|90|365-day ephemeral cert; =off forces off)
 *   brand-tool <tool-id> --export=png             # raster: no browser for SVG-native tools
 *   brand-tool install-browser                    # one-time Chromium download for png/jpg/pdf/video
 *                                                 # of HTML-layout tools (Tier B); needs `npm run build:web`
 *   brand-tool validate <file> [--json] [--trust-anchor=<root.pem>]  # check Content Credentials
 *
 * Architectural note: this CLI is URL mode under a different transport.
 * --foo=bar argv pairs become the same input values the web shell would
 * parse from ?foo=bar in the URL hash. The engine doesn't know which path
 * delivered them.
 */

import { argv, exit } from 'node:process';
import { parseToolUrl } from '@lolly/engine';
import { runToolCli, listToolsCli, showToolInputsCli, listAssetsCli } from '../src/run.ts';

const args = argv.slice(2);

try {
  if (args.length === 0) {
    await listToolsCli();
    exit(0);
  }

  // `validate` is a reserved subcommand, not a tool id: on-device Content
  // Credentials verification via the same engine module as the web /valid view.
  if (args[0] === 'validate') {
    const file = args.find((a, i) => i > 0 && !a.startsWith('--'));
    if (!file) throw new Error('usage: brand-tool validate <file> [--json] [--trust-anchor=<root.pem>]');
    const { validateCli } = await import('../src/validate.ts');
    exit(await validateCli(file, { json: 'json' in parseArgs(args.slice(1)) }));
  }

  // `install-browser` is a reserved subcommand: download Chromium for the Tier-B render
  // path (HTML-layout raster, jpg/webp, pdf, video). The DOM-free formats (svg/emf/eps +
  // data) and PNG for SVG-native tools never need it. `--with-deps`/`--force` pass through.
  if (args[0] === 'install-browser') {
    const { installBrowserCli } = await import('../src/install-browser.ts');
    exit(await installBrowserCli(args.slice(1)));
  }

  // `assets` is a reserved subcommand: list catalog asset ids so they can be passed to
  // any `asset`-type input (the engine already resolves an id → the embedded asset).
  // `brand-tool assets [query] [--type=raster]`.
  if (args[0] === 'assets') {
    const flags = parseArgs(args.slice(1));
    const query = args.find((a, i) => i > 0 && !a.startsWith('--'));
    await listAssetsCli(query, { type: flags.type });
    exit(0);
  }

  // `batch` is a reserved subcommand: render many rows from a CSV/TSV, one output file
  // per row into a directory. `--template=tool,tool` prints a starter grid instead.
  // `brand-tool batch <rows.csv> [--out-dir=./out] [--keep-going]`.
  if (args[0] === 'batch') {
    const flags = parseArgs(args.slice(1));
    if (flags.template !== undefined) {
      const { batchTemplateCli } = await import('../src/batch.ts');
      await batchTemplateCli((flags.template === '1' ? '' : flags.template).split(','));
      exit(0);
    }
    const csv = args.find((a, i) => i > 0 && !a.startsWith('--'));
    if (!csv) throw new Error('usage: brand-tool batch <rows.csv> [--out-dir=./out] [--keep-going]   (or --template=tool,tool)');
    const { runBatchCli } = await import('../src/batch.ts');
    exit(await runBatchCli(csv, { outDir: flags['out-dir'] || './out', keepGoing: 'keep-going' in flags }));
  }

  // A pasted lolly.tools link is a fully-configured tool URL: parse it into a toolId +
  // query and run it as if the query were --flags (the URL-mode-as-CLI principle). Any
  // --flag=val after the URL overrides the URL's params — "the URL as settings, then
  // edit". Mirrors the TUI's paste-a-URL flow (parseToolUrl → mountTool(query)).
  if (/^https?:\/\//i.test(args[0]!)) {
    const ref = parseToolUrl(args[0]!);
    if (!ref) throw new Error(`Not a recognised Lolly tool URL: ${args[0]}`);
    const urlParams = Object.fromEntries(new URLSearchParams(ref.query));
    const { output, export: fmt, ...params } = { ...urlParams, ...parseArgs(args.slice(1)) };
    process.stderr.write(`→ ${ref.toolId}${ref.format ? ` (${ref.format})` : ''} from URL\n`);
    await runToolCli({ toolId: ref.toolId, params, outputPath: output, format: fmt ?? ref.format ?? undefined });
    exit(0);
  }

  const toolId = args[0]!;
  const flags = parseArgs(args.slice(1));

  // No flags → show the tool's input schema
  if (Object.keys(flags).length === 0) {
    await showToolInputsCli(toolId);
    exit(0);
  }

  const { output, export: format, ...params } = flags;
  await runToolCli({ toolId, params, outputPath: output, format });
} catch (e) {
  const err = e as { message?: string; validationErrors?: Array<{ path: string; message: string }>; stack?: string };
  process.stderr.write(`Error: ${err.message}\n`);
  if (err.validationErrors?.length) {
    for (const ve of err.validationErrors) {
      process.stderr.write(`  ${ve.path}: ${ve.message}\n`);
    }
  }
  if (process.env.DEBUG) process.stderr.write((err.stack as string) + '\n');
  exit(1);
}

function parseArgs(rest: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of rest) {
    // [\s\S] (not .) so a value may span newlines — multiline longtext inputs
    // are a single argv element and must survive intact, matching URL-mode's %0A.
    const m = /^--([^=]+)(?:=([\s\S]*))?$/.exec(a);
    if (m) out[m[1]!] = m[2] ?? '1';
  }
  return out;
}
