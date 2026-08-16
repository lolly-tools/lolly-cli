#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0
/**
 * lolly CLI - the entry point.
 *
 * The usage text below is the REAL one: USAGE is printed by `lolly --help`, exit codes
 * and all (they used to live only in docs/cli.md, where a script author never sees them).
 *
 * Architectural note: this CLI is URL mode under a different transport. --foo=bar argv
 * pairs become the same input values the web shell would parse from ?foo=bar in the URL
 * hash. The engine doesn't know which path delivered them.
 *
 * TWO RULES this file exists to enforce (plans/73-cli-ga-contract.md §0):
 *   • stdout carries the payload and nothing else; every diagnostic goes to stderr.
 *   • NOTHING here calls process.exit() after writing to stdout. An exit() right after
 *     a pipe write discards the unflushed remainder - a 638 KB PNG arrived as 65536
 *     bytes that way. The exit code is set on process.exitCode and the process ends
 *     when the event loop drains, which is what flushes the pipe.
 */

import { argv } from 'node:process';
import { readFile } from 'node:fs/promises';
import { parseToolUrl, normalizeLang } from '@lolly/engine';
import { runToolCli, listToolsCli, showToolInputsCli, listAssetsCli, readStdin } from '../src/run.ts';
import { parseArgs, globalFlags, isOn, textMode, resolvePassword, RESERVED_SUBCOMMANDS } from '../src/args.ts';
import { EXIT, exitCodeFor, usageError } from '../src/exit-codes.ts';
import { configureOutput, strictExitCode, note, writeOut, keepConsoleOffStdout } from '../src/output.ts';
import { beginCommand, emitError, jsonRequested, envelopeEmitted } from '../src/envelope.ts';

const USAGE = `lolly — constraint-first asset generation from the terminal.

Usage:
  lolly                                    list tools
  lolly list                               list tools (explicit spelling)
  lolly describe <tool-id>                 show a tool's inputs, defaults and formats
  lolly run <tool-id> [--flags]            render
  lolly <tool-id> [--flags]                sugar for run (or describe, with no flags)
  lolly <https://lolly.tools/#/tool/…>     run a pasted link; later --flags override it

Subcommands:
  lolly assets [query] [--type=raster]     list catalog asset ids usable as asset inputs
  lolly batch <rows.csv> [--out-dir=./out] render one file per CSV row (--keep-going)
  lolly preflight <tool-id|url> [--json]   count and check an export without rendering it
                           add --rate-card=<f.json> to cost the counts against your
                           printer's own rates (--run-length=N feeds perUnit lines;
                           --use-expired-rates opts in past the card's validUntil)
                        [--strict]         (exit 4 when a check says no; 2 if it could
                                            not run. Report goes to stdout — redirect it)
  lolly smoke [--only=a,b] [--format=svg]  render every catalog tool at defaults (CI gate)
  lolly validate <file…> [--json] [--deep] check Content Credentials (--deep adds the
                                           neural pixel-watermark scan; needs a browser)
                        [--metadata]       …and report what else is in the file: embedded
                                           metadata, PDF structure, and text present in
                                           the file but not visible on the page
                        [--trust-anchor=<root.pem>]   pin a CA root (repeatable)
                        [--no-default-anchors]        …and trust ONLY what you pinned:
                                           drops the Lolly CA root and the vendored
                                           C2PA list. With nothing pinned, nothing is
                                           trusted — the bare-trust check
  lolly install-browser [--with-deps]      one-time Chromium download for the full render
                                           tier (also needs \`npm run build:web\`)

Global flags (valid on every command):
  --json                   one JSON envelope on stdout instead of human text, on list,
                           describe, assets, validate, smoke, batch and preflight. NOT
                           on a render: there, stdout carries the exported bytes.
  --quiet                  suppress non-error stderr (progress, notes, warnings)
  --verbose                diagnostics + stack traces (DEBUG=1 is an alias)
  --strict                 promote warnings to failures (exit 2 usage, 4 gate)
  -h, --help  ·  -v, --version

Export options:
  --output=<path>          write here (\`-\` = stdout; the extension can pick the format)
  --export=<fmt>           format: svg, png, jpg, webp, pdf, emf, eps, dxf, json, csv, …
                           (jpg and jpeg are one format; either spelling works on any
                           tool, whichever one its manifest happens to declare)
  --filename=<name>        name the output file in the working directory (no --output)
  --width= --height=       size, in --unit= (px default, or mm/cm/in/pt) at --dpi= (300)
  --text=outline|live      vector text as paths (default) or editable <text>
  --input.<id>=<value>     set a tool input whose name collides with a reserved flag
  --html-fallback          OPT IN: if the requested format cannot be produced here, write
                           HTML under a .html name instead of failing. Off by default —
                           without it a format that cannot be produced is an error, never
                           a different file under the name you asked for.
  --bleed=3mm --marks=crop,reg,bars        print prep (routes through the full render tier)
  --press-profile=fogra39  CMYK press condition for pdf-cmyk / cmyk-tiff. \`--profile=\`
                           is its alias, matching URL mode's reserved \`profile\` param.
  --user-profile=<f.json>  pre-fill bindToProfile inputs from a user-profile JSON file
  --rate-card=<f.json>     load + validate a printer's rate card and confirm it (a bad
                           card warns and continues; no prices are computed)
  --c2pa[=7|30|90|365]     stamp Content Credentials. ON BY DEFAULT, like the app
                           (--c2pa=off opts out; =N sets the certificate lifetime)
  --imprint                embed the Lolly pixel watermark (raster). ON BY DEFAULT
                           for the formats that can carry it (--imprint=0 opts out)
  --no-provenance          one word for a bare render: no credential, no imprint,
                           no durable mark. THE deterministic-bytes switch — both
                           marks embed a fresh timestamp, so a default render is
                           not byte-identical run to run
  --sign-key=<key.pem>     sign the credential with an enrolled identity instead of an
  --sign-cert=<chain.pem>  anonymous on-device key: a P-256 PKCS#8 key file plus its
                           certificate chain, LEAF FIRST. Both are PATHS - no flag ever
                           takes key material, because argv is visible in \`ps\`. An
                           encrypted key takes its passphrase from
                           $LOLLY_SIGN_KEY_PASSWORD, or a prompt on a terminal.
                           ($LOLLY_SIGN_KEY/$LOLLY_SIGN_CERT are the same two paths;
                           $LOLLY_SIGN_KEY_PEM/$LOLLY_SIGN_CERT_PEM carry the PEM text
                           itself, for CI secret stores with no filesystem.)
                           See /info/cli-signing.html
  --durable=1              embed the durable Content Credential (neural TrustMark).
                           Off by default (a neural encode, and a model download)
  --password=<pw>          PDF open-password (visible in \`ps\`; see --password-stdin)
  --password-stdin         read the password from stdin instead of argv
  --depth=8|16|float       requested bits per channel; --hdr=1 for the float view transform
  --lang=<xx>              use a tool's manifest translation sidecar
  --designv=<slug|latest>  the design-system version to render against: a published
                           version's slug, or \`latest\` for the edit head. Beats a
                           tool's own pin; a slug this catalog does not ship falls
                           through to the pin, then the head, and says so either way
  --verify                 for a file utility: print a per-file line when no check failed

Link options:
  --z=<token>              a packed share link's state
  --zx=<token>             a PASSWORD-PROTECTED share link's state; needs
  --link-password=<pw>     …this. A missing or wrong password is an error, never a
                           silent render of the tool's defaults.
  --share / --link         print a shareable lolly.tools link instead of rendering

Exit codes:
  0  OK                the requested thing was produced
  1  FAILED            it was possible, it ran, it failed
  2  USAGE             wrong invocation: unknown tool/format/flag, unreadable path
  3  UNAVAILABLE_HERE  impossible in THIS installation (no browser, no capability) —
                       the retry-on-another-runner code
  4  REFUSED           a protective check said no (--verify, format mismatch, forged
                       credential)
  5  NOT_FOUND         a legitimate negative answer (validate: no credential present)
  6  AUTH              missing or wrong password
  70 INTERNAL          unclassified exception: a bug in Lolly

Examples:
  lolly qr-code --url=https://suse.com --output=qr.svg
  lolly run qr-code --url=https://suse.com --export=png > qr.png
  lolly redact --source=./f.pdf --bars=1,40,60,200,24 --output=./out.pdf --verify
`;

const args = argv.slice(2);
// Rule 1 of §5.3, enforced before any command runs: stdout is the payload. A tool hook
// calling console.log would otherwise write into the middle of an exported PNG.
keepConsoleOffStdout();
// A downstream reader that closes early (`lolly list | head -1`) makes the next write to
// stdout raise EPIPE. Nothing subscribed to the stream's 'error' event, so that surfaced
// as Node's raw "Unhandled 'error' event" stack trace and exit 1 - which under
// `set -o pipefail` fails the whole pipeline for an ordinary `| head`. A closed pipe is
// not a failure of this run: it ends quietly, keeping whatever exit code the work had.
// Swallowed rather than exited on, because §0/B3 forbids process.exit() around stdout - 
// the event loop drains and the process ends with the code the work already set. Every
// other stdout error still reaches the caller through writeOut's rejected promise.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err?.code !== 'EPIPE') throw err;
});
// §5.2 says a `--json` run puts a complete envelope on stdout on EVERY path. The parse
// below can itself throw (a bare value-flag is exit 2), and `beginCommand` had not run
// yet, so `lolly validate f.png --json --require > r.json` left a zero-byte file and an
// agent reading stdout got EOF - the exact failure the envelope was written to remove.
// A raw argv scan is enough: `--json` has one spelling and no bare-value trap. The
// command name is re-set accurately by main() once the parse succeeds; this pre-set is
// only the fallback for a failure that happens before that.
const RAW_VERBS = new Set(['list', 'describe', 'run', 'validate', 'preflight', 'install-browser', 'assets', 'batch', 'smoke']);
const rawFirst = args.find(a => !a.startsWith('-'));
beginCommand(
  RAW_VERBS.has(rawFirst ?? '') ? rawFirst! : 'lolly',
  args.some(a => a === '--json' || /^--json=(?!0$|false$|off$|no$)/i.test(a)),
);
// The stderr writer the error printer uses, captured BEFORE --quiet can replace it: a
// quiet run still prints errors, and it must not print them into a sink.
const writeErr = process.stderr.write.bind(process.stderr);

try {
  // --help / -h / --version / -v are recognised ANYWHERE in argv, before anything treats
  // the token as a tool id (`lolly --help` used to print "Tool not found: --help").
  if (args.some(a => a === '--help' || a === '-h' || a === 'help')) {
    await writeOut(USAGE);
  } else if (args.some(a => a === '--version' || a === '-v')) {
    const { ENGINE_VERSION } = await import('@lolly/engine');
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    await writeOut(`lolly ${pkg.version} (engine ${ENGINE_VERSION})\n`);
  } else {
    await main();
  }
  // --strict turns this run's warnings into a failure AFTER the work is reported, so the
  // operator still sees what was wrong rather than a bare exit code.
  const promoted = strictExitCode();
  if (promoted && !process.exitCode) process.exitCode = promoted;
} catch (e) {
  const err = e as { message?: string; validationErrors?: Array<{ path: string; message: string }>; stack?: string };
  writeErr(`Error: ${err.message}\n`);
  if (err.validationErrors?.length) {
    for (const ve of err.validationErrors) writeErr(`  ${ve.path}: ${ve.message}\n`);
  }
  if (process.env.DEBUG) writeErr((err.stack as string) + '\n');
  process.exitCode = exitCodeFor(e);
  // --json covers the FAILURE path (contract §5.2). Without this, `lolly validate
  // /nope.png --json > r.json` left a zero-byte file and an agent reading stdout got
  // EOF; now stdout carries a complete envelope on every path. `envelopeEmitted` guards
  // the case where the command already wrote its own document and then threw.
  if (jsonRequested() && !envelopeEmitted()) {
    try { await emitError(e); } catch { /* the exit code still tells the truth */ }
  }
}

async function main(): Promise<void> {
  if (args.length === 0) {
    beginCommand('list', false);
    await listToolsCli();
    return;
  }

  // ONE parse for the whole command line: `--` ends option parsing, value-taking flags
  // reject their bare form, and --trust-anchor accumulates.
  const { flags, repeated, positionals } = parseArgs(args);
  const g = globalFlags(flags);
  configureOutput({ quiet: g.quiet, strict: g.strict });
  if (g.verbose) process.env.DEBUG ??= '1';
  // --quiet means everything except errors stops writing to stderr. Enforced at the
  // stream, not per call site, because the render tiers this shell drives (raster.ts,
  // webshell-render.ts, the tools' own console) all write there too.
  if (g.quiet) process.stderr.write = (() => true) as typeof process.stderr.write;

  const cmd = positionals[0];
  // Which command this is, and whether stdout must carry the §5.2 envelope. Recorded
  // before any work, so the top-level catch can name the command in a failure envelope
  // even when the throw happened before the command function was reached. A bare tool
  // id reports as `describe`/`run` - the verb it is sugar for - not as its own name.
  const VERBS = new Set(['list', 'describe', 'run', 'validate', 'preflight', 'install-browser', 'assets', 'batch', 'smoke']);
  beginCommand(VERBS.has(cmd ?? '') ? cmd! : 'run', g.json);

  // ── explicit verbs ────────────────────────────────────────────────────────
  // `list` / `describe` / `run` exist because the first positional is an open namespace
  // shared with tool ids: a brand pack shipping a tool called `batch` would otherwise be
  // permanently unreachable. The verbs can never be shadowed.
  if (cmd === 'list') {
    await listToolsCli({ json: g.json });
    return;
  }

  if (cmd === 'describe') {
    const toolId = positionals[1];
    if (!toolId) throw usageError('usage: lolly describe <tool-id>', 'MISSING_ARGUMENT');
    await showToolInputsCli(toolId, { lang: normalizeLang(flags.lang) ?? undefined, json: g.json });
    return;
  }

  if (cmd === 'run') {
    const toolId = positionals[1];
    if (!toolId) throw usageError('usage: lolly run <tool-id> [--flags]', 'MISSING_ARGUMENT');
    await render(toolId, flags, undefined, repeated);
    return;
  }

  // ── validate ──────────────────────────────────────────────────────────────
  // N files, one record each, exit = the worst file's code (contract B9): taking the
  // first non-flag and silently ignoring the rest was wrong-answer shaped.
  if (cmd === 'validate') {
    const files = positionals.slice(1);
    if (!files.length) {
      throw usageError('usage: lolly validate <file…> [--json] [--metadata] [--deep] [--require=credential|none] [--trust-anchor=<root.pem>] [--no-default-anchors]', 'MISSING_ARGUMENT');
    }
    const { validateFilesCli } = await import('../src/validate.ts');
    process.exitCode = await validateFilesCli(files, {
      json: isOn(flags.json),
      deep: isOn(flags.deep),
      require: flags.require,
      metadata: isOn(flags.metadata),
      strict: g.strict,
      trustAnchors: repeated['trust-anchor'],
      // --no-default-anchors: pinned roots only (contract §12 O1). Absent = the
      // default set (Lolly CA root + the vendored C2PA list).
      defaultAnchors: !isOn(flags['no-default-anchors']),
    });
    return;
  }

  // `preflight` is a reserved subcommand: count and check the export you were about to
  // run, WITHOUT rendering it. It takes the same render flags a real run takes (and the
  // same pasted-URL form), because preflighting settings other than the ones a render
  // would use is worthless. The engine owns the rules; this shell only collects the
  // facts. Counts and findings only - there is no rate, price or currency in it.
  if (cmd === 'preflight') {
    const rest = args.slice(args.indexOf('preflight') + 1);
    const { preflightCli } = await import('../src/preflight.ts');
    process.exitCode = await preflightCli(rest, flags);
    return;
  }

  // `install-browser`: download Chromium for the Tier-B render path (HTML-layout raster,
  // jpg/webp, pdf, video). The DOM-free formats (svg/emf/eps + data) and PNG for
  // SVG-native tools never need it. `--with-deps`/`--force` pass through.
  if (cmd === 'install-browser') {
    const { installBrowserCli } = await import('../src/install-browser.ts');
    process.exitCode = await installBrowserCli(args.slice(args.indexOf('install-browser') + 1));
    return;
  }

  // `assets`: list catalog asset ids so they can be passed to any `asset`-type input
  // (the engine already resolves an id → the embedded asset).
  if (cmd === 'assets') {
    await listAssetsCli(positionals[1], { type: flags.type, json: g.json });
    return;
  }

  // `batch`: render many rows from a CSV/TSV, one output file per row into a DIRECTORY.
  // `--template=tool,tool` prints a starter grid instead.
  if (cmd === 'batch') {
    if (flags.output !== undefined) {
      // It used to accept --output, write `<out-dir>/01-….svg` anyway, and say nothing
      // (contract B13). A batch has many outputs; one path cannot name them.
      throw usageError('batch writes one file per row into a directory — use --out-dir=<dir>, not --output.', 'CONFLICTING_FLAGS');
    }
    if (flags.template !== undefined) {
      const { batchTemplateCli } = await import('../src/batch.ts');
      await batchTemplateCli((flags.template === '1' ? '' : flags.template).split(','), { json: g.json });
      return;
    }
    const csv = positionals[1];
    if (!csv) throw usageError('usage: lolly batch <rows.csv> [--out-dir=./out] [--keep-going]   (or --template=tool,tool)', 'MISSING_ARGUMENT');
    const { runBatchCli } = await import('../src/batch.ts');
    process.exitCode = await runBatchCli(csv, { outDir: flags['out-dir'] || './out', keepGoing: isOn(flags['keep-going']), json: g.json });
    return;
  }

  // `smoke`: render EVERY catalog tool at manifest defaults to its first Node-native
  // format, ✓/✗ per tool - the catalog-wide gate CI runs so a hooks.js regression can
  // never ship a tool that renders blank.
  if (cmd === 'smoke') {
    const { smokeCli } = await import('../src/smoke.ts');
    process.exitCode = await smokeCli({ only: flags.only, format: flags.format, json: g.json });
    return;
  }

  // ── a pasted lolly.tools link ─────────────────────────────────────────────
  // A fully-configured tool URL: parse it into a toolId + query and run it as if the
  // query were --flags (the URL-mode-as-CLI principle). Any --flag=val after the URL
  // overrides the URL's params - "the URL as settings, then edit".
  if (/^https?:\/\//i.test(cmd ?? '')) {
    const ref = parseToolUrl(cmd!);
    if (!ref) throw usageError(`Not a recognised Lolly tool URL: ${cmd}`, 'BAD_URL');
    const urlParams = Object.fromEntries(new URLSearchParams(ref.query));
    // No `profile` remap any more: url-mode's `profile` IS the press condition and so is
    // the CLI's `--profile` (contract B1). The user-profile FILE has its own name,
    // `--user-profile`, so a share link and a flag can no longer mean different things.
    const merged: Record<string, string> = { ...urlParams, ...flags };
    note(`→ ${ref.toolId}${ref.format ? ` (${ref.format})` : ''} from URL`);
    // In URL mode `export` is a bare PRESENCE flag ("auto-download on open") - the web
    // Share dialog's default link emits `…&format=png&export`, so URLSearchParams gives
    // export=''. That empty string is NOT a format: coalesce it to undefined so the URL's
    // own `format=` param (kept in the params, read by runToolCli) or the path-segment
    // format wins. An explicit CLI `--export=svg` is non-empty and still overrides.
    await render(ref.toolId, merged, ref.format ?? undefined, repeated);
    return;
  }

  // ── the bare-tool-id sugar ────────────────────────────────────────────────
  const toolId = cmd!;
  // No flags (or only --lang) → show the tool's input schema. `lang` is reserved (see
  // engine/src/url-mode.ts), never a tool input, so it doesn't count as "a flag was
  // given" for the describe-vs-render branch. `lolly run <id>` renders at defaults.
  // Global flags are not "a flag was given" either: `lolly qr-code --quiet` still means
  // "tell me about this tool", and `--json` on a bare tool id is the machine-readable
  // spelling of `describe`, not a render request.
  const GLOBAL = new Set(['lang', 'quiet', 'verbose', 'strict', 'json']);
  const flagKeys = Object.keys(flags).filter(k => !GLOBAL.has(k));
  if (flagKeys.length === 0) {
    beginCommand('describe', g.json);
    await showToolInputsCli(toolId, { lang: normalizeLang(flags.lang) ?? undefined, json: g.json });
    return;
  }
  await render(toolId, flags, undefined, repeated);
}

/** The one render call site: every path (verb, sugar, URL) funnels through it, so the
 *  flag→argument mapping cannot drift between them. */
async function render(toolId: string, flags: Record<string, string>, urlFormat?: string, repeated: Record<string, string[]> = {}): Promise<void> {
  if (isOn(flags.json)) {
    // `--json` on a render is deliberately absent at GA (contract §3): run's stdout IS
    // the artefact. Accepting and ignoring the flag is the silent class this shell has
    // spent its whole life removing.
    throw usageError(
      '--json is not available on a render: stdout carries the exported bytes. It is supported on list, describe, assets, validate, smoke and batch.',
      'UNSUPPORTED_FLAG',
    );
  }
  const {
    output, export: fmt, share, link, verify, 'html-fallback': htmlFallback,
    json: _json, quiet: _quiet, verbose: _verbose, strict: _strict,
    ...params
  } = flags;
  // --password-stdin (contract B15) keeps the password out of argv, where `ps` can read
  // it. It replaces the value the rest of the pipeline reads, so nothing downstream
  // needs to know which way it arrived.
  const password = await resolvePassword(flags, readStdin);
  if (password !== undefined) params.password = password;
  delete params['password-stdin'];

  await runToolCli({
    toolId,
    params,
    repeated,
    outputPath: output,
    format: (fmt || undefined) ?? urlFormat,
    share: share !== undefined || link !== undefined,
    verify: verify !== undefined,
    htmlFallback: isOn(htmlFallback),
    text: textMode(flags.text),
  });
}

// Re-exported so scripts/validate-catalog.ts can refuse a tool id that would shadow a
// subcommand, and so the contract's frozen word list has exactly one home.
export { RESERVED_SUBCOMMANDS, EXIT };
