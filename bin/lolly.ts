#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0
/**
 * lolly CLI
 *
 * Usage:
 *   lolly                                    # list tools
 *   lolly <tool-id>                          # show inputs for a tool
 *   lolly <tool-id> --foo=bar                # run, write to stdout
 *   lolly <tool-id> --foo=bar --output=f.svg # run, write to file
 *   lolly <tool-id> --foo=bar --share        # print a shareable lolly.tools link (no render)
 *   lolly <tool-id> --foo=bar --export=svg   # explicit format
 *   lolly <tool-id> --foo=bar --c2pa=30      # stamp Content Credentials
 *                                                 # (7|30|90|365-day ephemeral cert; =off forces off)
 *   lolly <tool-id> --export=pdf --bleed=3mm --marks=crop,reg,bars  # print prep (pdf/pdf-cmyk/cmyk-tiff)
 *   lolly <tool-id> --export=png --imprint   # embed the durable Lolly pixel watermark (raster)
 *   lolly <tool-id> --export=pdf-cmyk --press-profile=fogra39       # CMYK press condition
 *                                                 # (NB: --profile is the user-profile FILE, not the press condition)
 *   lolly <tool-id> --export=png             # raster: no browser for SVG-native tools
 *   lolly install-browser                    # one-time Chromium download for png/jpg/pdf/video
 *                                                 # of HTML-layout tools (Tier B); needs `npm run build:web`
 *   lolly validate <file> [--json] [--trust-anchor=<root.pem>]  # check Content Credentials
 *
 * Architectural note: this CLI is URL mode under a different transport.
 * --foo=bar argv pairs become the same input values the web shell would
 * parse from ?foo=bar in the URL hash. The engine doesn't know which path
 * delivered them.
 */

import { argv, exit } from 'node:process';
import { parseToolUrl, normalizeLang } from '@lolly/engine';
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
    if (!file) throw new Error('usage: lolly validate <file> [--json] [--trust-anchor=<root.pem>]');
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
  // `lolly assets [query] [--type=raster]`.
  if (args[0] === 'assets') {
    const flags = parseArgs(args.slice(1));
    const query = args.find((a, i) => i > 0 && !a.startsWith('--'));
    await listAssetsCli(query, { type: flags.type });
    exit(0);
  }

  // `batch` is a reserved subcommand: render many rows from a CSV/TSV, one output file
  // per row into a directory. `--template=tool,tool` prints a starter grid instead.
  // `lolly batch <rows.csv> [--out-dir=./out] [--keep-going]`.
  if (args[0] === 'batch') {
    const flags = parseArgs(args.slice(1));
    if (flags.template !== undefined) {
      const { batchTemplateCli } = await import('../src/batch.ts');
      await batchTemplateCli((flags.template === '1' ? '' : flags.template).split(','));
      exit(0);
    }
    const csv = args.find((a, i) => i > 0 && !a.startsWith('--'));
    if (!csv) throw new Error('usage: lolly batch <rows.csv> [--out-dir=./out] [--keep-going]   (or --template=tool,tool)');
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
    const cliFlags = parseArgs(args.slice(1));
    const merged: Record<string, string> = { ...urlParams, ...cliFlags };
    // url-mode `profile` = the CMYK press condition; the CLI's --profile = the user-profile
    // JSON file. A share link carries the former, so map it onto --press-profile — unless
    // the user explicitly passed --profile on the command line (then that file wins).
    if (merged.profile !== undefined && cliFlags.profile === undefined) {
      merged['press-profile'] ??= merged.profile;
      delete merged.profile;
    }
    const { output, export: fmt, share: urlShare, link: urlLink, ...params } = merged;
    process.stderr.write(`→ ${ref.toolId}${ref.format ? ` (${ref.format})` : ''} from URL\n`);
    // In URL mode `export` is a bare PRESENCE flag ("auto-download on open") — the web
    // Share dialog's default link emits `…&format=png&export`, so URLSearchParams gives
    // export=''. That empty string is NOT a format: coalesce it to undefined so the URL's
    // own `format=` param (kept in `params`, read by runToolCli) or the path-segment
    // format wins. An explicit CLI `--export=svg` is non-empty and still overrides.
    await runToolCli({ toolId: ref.toolId, params, outputPath: output, format: (fmt || undefined) ?? ref.format ?? undefined, share: urlShare !== undefined || urlLink !== undefined });
    exit(0);
  }

  const toolId = args[0]!;
  const flags = parseArgs(args.slice(1));

  // No flags (or only --lang) → show the tool's input schema. `lang` is
  // reserved (see engine/src/url-mode.ts), never a tool input, so it doesn't
  // count as "a flag was given" for the show-inputs-vs-render branch.
  const flagKeys = Object.keys(flags).filter(k => k !== 'lang');
  if (flagKeys.length === 0) {
    await showToolInputsCli(toolId, { lang: normalizeLang(flags.lang as string | undefined) ?? undefined });
    exit(0);
  }

  const { output, export: format, share, link, ...params } = flags;
  await runToolCli({ toolId, params, outputPath: output, format, share: share !== undefined || link !== undefined });
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
