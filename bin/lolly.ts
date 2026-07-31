#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0
/**
 * lolly CLI
 *
 * The usage text below is the REAL one: USAGE is printed by `lolly --help`. It used to
 * be a comment nobody could see from a terminal, and `--help` / `--version` were
 * unrecognised (they fell through to "Tool not found: --help").
 *
 * Architectural note: this CLI is URL mode under a different transport.
 * --foo=bar argv pairs become the same input values the web shell would
 * parse from ?foo=bar in the URL hash. The engine doesn't know which path
 * delivered them.
 */

import { argv, exit } from 'node:process';
import { readFile } from 'node:fs/promises';
import { parseToolUrl, normalizeLang } from '@lolly/engine';
import { runToolCli, listToolsCli, showToolInputsCli, listAssetsCli } from '../src/run.ts';

const USAGE = `lolly — constraint-first asset generation from the terminal.

Usage:
  lolly                                    list tools
  lolly <tool-id>                          show a tool's inputs
  lolly <tool-id> --foo=bar                run, write to stdout
  lolly <tool-id> --foo=bar --output=f.svg run, write to a file
  lolly <tool-id> --foo=bar --export=svg   explicit format
  lolly <tool-id> --foo=bar --share        print a shareable lolly.tools link (no render)
  lolly <https://lolly.tools/#/tool/…>     run a pasted link; later --flags override it

Subcommands:
  lolly assets [query] [--type=raster]     list catalog asset ids usable as asset inputs
  lolly batch <rows.csv> [--out-dir=./out] render one file per CSV row (--keep-going)
  lolly smoke [--only=a,b] [--format=svg]  render every catalog tool at defaults (CI gate)
  lolly validate <file> [--json] [--deep]  check Content Credentials (--deep adds the
                                           neural pixel-watermark scan; needs a browser)
  lolly install-browser [--with-deps]      one-time Chromium download for the full render
                                           tier (also needs \`npm run build:web\`)

Export options:
  --output=<path>          write here (the extension can pick the format)
  --export=<fmt>           format: svg, png, jpg, webp, pdf, emf, eps, dxf, json, csv, …
  --width= --height=       size, in --unit= (px default, or mm/cm/in/pt) at --dpi= (300)
  --html-fallback          OPT IN: if the requested format cannot be produced here, write
                           HTML under a .html name instead of failing. Off by default —
                           without it a format that cannot be produced is an error, never
                           a different file under the name you asked for.
  --bleed=3mm --marks=crop,reg,bars        print prep (routes through the full render tier)
  --press-profile=fogra39                  CMYK press condition for pdf-cmyk / cmyk-tiff
                           (NB: --profile is the user-profile JSON FILE, not the press
                           condition — they are different flags on purpose)
  --imprint                embed the durable Lolly pixel watermark (raster)
  --durable=1              embed the durable Content Credential (neural TrustMark)
  --c2pa[=7|30|90|365]     stamp Content Credentials (=off forces off)
  --password=<pw>          PDF open-password
  --depth=8|16|float       requested bits per channel; --hdr=1 for the float view transform

Link options:
  --z=<token>              a packed share link's state
  --zx=<token>             a PASSWORD-PROTECTED share link's state; needs
  --link-password=<pw>     …this. A missing or wrong password is an error, never a
                           silent render of the tool's defaults.

Other:
  --profile=<file.json>    pre-fill bindToProfile inputs from a user-profile JSON file
  --lang=<xx>              use a tool's manifest translation sidecar
  --verify                 for a file utility: print a per-file line when no check failed
  -h, --help               this text
  -v, --version            print the CLI + engine version

Examples:
  lolly qr-code --url=https://suse.com --output=qr.svg
  lolly qr-code --url=https://suse.com --export=png > qr.png
  lolly redact --source=./f.pdf --bars=1,40,60,200,24 --output=./out.pdf --verify
`;

const args = argv.slice(2);

try {
  if (args.length === 0) {
    await listToolsCli();
    exit(0);
  }

  // --help / -h / --version / -v, before anything treats the token as a tool id (which is
  // what used to happen: `lolly --help` printed "Tool not found: --help").
  if (args.some(a => a === '--help' || a === '-h' || a === 'help')) {
    process.stdout.write(USAGE);
    exit(0);
  }
  if (args.some(a => a === '--version' || a === '-v')) {
    const { ENGINE_VERSION } = await import('@lolly/engine');
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    process.stdout.write(`lolly ${pkg.version} (engine ${ENGINE_VERSION})\n`);
    exit(0);
  }

  // `validate` is a reserved subcommand, not a tool id: on-device Content
  // Credentials verification via the same engine module as the web /valid view.
  if (args[0] === 'validate') {
    const file = args.find((a, i) => i > 0 && !a.startsWith('--'));
    if (!file) throw new Error('usage: lolly validate <file> [--json] [--deep] [--trust-anchor=<root.pem>]');
    const { validateCli } = await import('../src/validate.ts');
    const flags = parseArgs(args.slice(1));
    exit(await validateCli(file, { json: 'json' in flags, deep: 'deep' in flags }));
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

  // `smoke` is a reserved subcommand: render EVERY catalog tool at manifest defaults to
  // its first Node-native format (browser-free; html as the layout fallback), ✓/✗ per
  // tool, non-zero exit on any failure — the catalog-wide gate CI runs so a hooks.js
  // regression can never ship a tool that renders blank.
  // `lolly smoke [--only=id,id] [--format=svg]`.
  if (args[0] === 'smoke') {
    const flags = parseArgs(args.slice(1));
    const { smokeCli } = await import('../src/smoke.ts');
    exit(await smokeCli({ only: flags.only, format: flags.format }));
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
    const { output, export: fmt, share: urlShare, link: urlLink, verify: urlVerify, 'html-fallback': urlHtmlFallback, ...params } = merged;
    process.stderr.write(`→ ${ref.toolId}${ref.format ? ` (${ref.format})` : ''} from URL\n`);
    // In URL mode `export` is a bare PRESENCE flag ("auto-download on open") — the web
    // Share dialog's default link emits `…&format=png&export`, so URLSearchParams gives
    // export=''. That empty string is NOT a format: coalesce it to undefined so the URL's
    // own `format=` param (kept in `params`, read by runToolCli) or the path-segment
    // format wins. An explicit CLI `--export=svg` is non-empty and still overrides.
    await runToolCli({ toolId: ref.toolId, params, outputPath: output, format: (fmt || undefined) ?? ref.format ?? undefined, share: urlShare !== undefined || urlLink !== undefined, verify: urlVerify !== undefined, htmlFallback: isOn(urlHtmlFallback) });
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

  const { output, export: format, share, link, verify, 'html-fallback': htmlFallback, ...params } = flags;
  await runToolCli({ toolId, params, outputPath: output, format, share: share !== undefined || link !== undefined, verify: verify !== undefined, htmlFallback: isOn(htmlFallback) });
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

/** A bare `--flag` parses to '1'; `--flag=false|0|off` turns it back off. */
function isOn(v: string | undefined): boolean {
  return v !== undefined && !/^(0|false|off|no)$/i.test(v);
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
