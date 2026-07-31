// SPDX-License-Identifier: MPL-2.0
/**
 * `lolly preflight <tool-id|url> [--flags…]` — count and check an export
 * without rendering it.
 *
 * ## What this is
 *
 * The engine owns the RULES (`engine/src/preflight.ts`); each shell collects the
 * FACTS from its own platform. This file is the CLI's fact collector plus its two
 * renderers (human and `--json`). It is the same split `print-marks.ts` uses, and
 * it is why `lolly preflight <url>` and opening that URL in the web shell must
 * report the same findings: there is one implementation of every rule and two
 * collectors feeding it.
 *
 * ## It takes the RENDER flags, not its own
 *
 * Preflighting settings other than the ones a render would use is worthless, so
 * everything downstream of `parseUrlState` is the same code path `runToolCli`
 * walks: the same `zx=` decrypt, the same `z=` expansion, the same reserved-param
 * parse, the same format resolution. Its own flags are three (`--json`,
 * `--strict`, `--out=`), and two more are RECOGNISED SO THEY CAN BE REFUSED
 * (`--rate-card`, `--batch`) rather than silently dropped by the flag parser.
 *
 * ## What it does NOT do
 *
 * It never renders and never exports. It loads the tool and builds the input
 * model (which runs `onInit`, the same as `--share` does) so the checks see the
 * values a render would see; nothing is rasterised, no browser is launched, no
 * file is written unless `--out=` asked for one.
 *
 * There is no currency, no rate, no price and no monetary concept in this file,
 * and none may be added. Preflight counts; it does not cost.
 * See `plans/preflight-and-cost.md` §6 and §8.
 *
 * ## Streams and exit codes
 *
 *   stdout — the report, and ONLY the report. In `--json`, exactly one JSON
 *            document ON EVERY PATH — the shared envelope (§5.2), with the
 *            report as `result` — so `lolly preflight qr-code --json | jq
 *            .result.findings` works unconditionally. The exit-2 path emits the
 *            same envelope with `ok:false` and an `error` rather than nothing:
 *            a CI step doing `lolly preflight X --json > r.json` must get a
 *            machine-readable refusal, not a parse error, because a refusal is
 *            precisely what exit 2 exists to make legible.
 *   stderr — usage errors, refused flags, load failures, warnings. NEVER a
 *            finding: a finding is data and belongs in the artifact.
 *
 *   0 — preflight ran; no `error` findings.
 *   1 — preflight ran; at least one `error` (or, with `--strict`, a `warn`).
 *   2 — preflight COULD NOT RUN (unknown tool, unloadable manifest, a `zx=` link
 *       with no password, a refused flag). Exiting 0 when the check never
 *       happened is the one failure mode that makes a CI gate worthless.
 *
 * A count that cannot be TAKEN is never non-zero: "needs the artwork mounted",
 * "no brand palette resolved", "no physical page size" are `info` findings with a
 * machine-readable `needs`, and they exit 0 permanently.
 */

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  createRuntime, buildInputModel, expandQuery, hasEncryptedState,
  isUnit, normalizeLang, parseDimension, parseToolUrl, parseUrlState, preflight,
} from '@lolly/engine';
import type {
  Fact, Finding, PreflightInput, PreflightJob, PreflightReport, PreflightSize,
  PreflightSwatch, Severity,
} from '@lolly/engine';
import { matchedExportFormat } from '@lolly-tools/node-shell/raster';
import {
  decryptLinkQuery, formatFromOutput, loadToolOrThrow, quietVirtualConsole,
  readProfile, readToolFile, unknownFlags,
} from './run.ts';
import { createCliBridge } from './bridge.ts';
import { isOn } from './args.ts';
import { useColor } from './output.ts';

const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', BOLD = '\x1b[1m', YELLOW = '\x1b[33m', RESET = '\x1b[0m';
// NO_COLOR is honoured alongside the isTTY check, same as validate.ts (contract §1.5).
const tty = useColor(process.stdout);
const paint = (code: string, s: string): string => (tty ? code + s + RESET : s);

/**
 * Strip control characters before printing.
 *
 * The threat surface here is WIDER than `validate.ts`'s, not narrower. A spot
 * ink's `name`, and `FinishKind` (an OPEN union — an arbitrary printable string),
 * come from a brand tokens JSON the user dropped through brand ingest, and both
 * land in a finding message. The tool id arrives from argv or from a pasted URL;
 * tool titles, input labels and echoed input values are tool-pack or user data.
 *
 * Scrubbed AT THE PRINT BOUNDARY only, never in the data model: `--json` emits
 * the raw values through `JSON.stringify` (which escapes control characters by
 * construction), so scrubbing the model would make the two reports disagree about
 * the data — worse than the ANSI risk it removes. Colour is only ever emitted by
 * `paint()` over our own literals.
 */
const clean = (v: unknown): string => String(v).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');

/** This subcommand's own flags. Removed from the params before they are read as
 *  URL state, so they are never mistaken for tool inputs. */
const OWN_FLAGS = ['json', 'strict', 'out'] as const;

/**
 * Flags that are RECOGNISED so they can be refused.
 *
 * `parseArgs` drops unknown flags on the floor. A silently-ignored
 * `--batch=rows.csv` would print a confident single-job report that the reader
 * takes for a 50-row answer — exactly the class of quiet-wrong-number this
 * subcommand exists to prevent. Refusing costs two lines.
 */
const REFUSED: Record<string, string> = {
  'rate-card': '--rate-card is not implemented (preflight counts only; there are no rates and no money).',
  rates: '--rates is not implemented (preflight counts only; there are no rates and no money).',
  batch: 'batch preflight is not implemented yet. Run `lolly preflight <tool-id>` for a single job.',
};

class UsageError extends Error {}

/**
 * @param rest  argv after the `preflight` subcommand token
 * @param flags the same argv already run through the entry point's flag parser
 */
export async function preflightCli(rest: string[], flags: Record<string, string>): Promise<number> {
  try {
    return await run(rest, flags);
  } catch (e) {
    // Everything that reaches here means preflight COULD NOT RUN. Exit 2, not 1:
    // a script must be able to tell "the job has problems" from "the check never
    // happened".
    const err = e as { message?: string; stack?: string };
    process.stderr.write(`Error: ${clean(err.message ?? e)}\n`);
    if (process.env.DEBUG && err.stack) process.stderr.write(err.stack + '\n');
    if (!(e instanceof UsageError)) {
      process.stderr.write('Nothing was checked. This is not a clean preflight.\n');
    }
    // stdout still gets exactly one JSON document — now the shared envelope, whose
    // `ok:false` + `error` say "this did not run" in the same shape every other
    // command uses. `error.kind` is the stable handle, so an error that ALREADY carries
    // one keeps it: an unknown tool reports `UNKNOWN_TOOL` here exactly as it does from
    // `describe` and `smoke`, rather than a subcommand-private `PREFLIGHT_LOAD_FAILED`
    // that an agent would have to learn separately. The exit code stays 2 either way —
    // "the check never happened" is the fact this subcommand exists to state.
    if (isOn(flags.json)) {
      const { emitError } = await import('./envelope.ts');
      const { errorKind } = await import('./exit-codes.ts');
      const kind = e instanceof UsageError ? 'USAGE'
        : (e && typeof e === 'object' && typeof (e as { kind?: unknown }).kind === 'string')
          ? errorKind(e)
          : 'PREFLIGHT_LOAD_FAILED';
      await emitError(Object.assign(new Error(clean(err.message ?? e)), { exit: 2, kind }));
    }
    return 2;
  }
}

async function run(rest: string[], flags: Record<string, string>): Promise<number> {
  for (const [flag, why] of Object.entries(REFUSED)) {
    if (flag in flags) throw new UsageError(why);
  }

  const positional = rest.find(a => !a.startsWith('--'));
  if (!positional) {
    throw new UsageError('usage: lolly preflight <tool-id|url> [--export=fmt] [--json] [--strict] [--out=file]');
  }
  if (/\.(csv|tsv)$/i.test(positional)) {
    throw new UsageError('batch preflight is not implemented yet. Run `lolly preflight <tool-id>` for a single job.');
  }

  // `isOn`, not `'json' in flags`: one rule for boolean flags across the whole shell, so
  // `--json=0` turns it off here exactly as it does everywhere else. The `in` test made
  // `--strict=false` a strict run.
  const json = isOn(flags.json);
  const strict = isOn(flags.strict);
  const outPath = flags.out;

  // A pasted lolly.tools link is a fully-configured job: parse it into a toolId +
  // query and preflight it as if the query were --flags. Any --flag after the URL
  // overrides the URL's param, exactly as `runToolCli`'s URL branch does. No
  // `profile` remap any more: url-mode's `profile` IS the press condition, and so is
  // the CLI's `--profile` (plans/cli-ga-contract.md B1). The user-profile FILE has its
  // own flag, `--user-profile`.
  let toolId = positional;
  let params: Record<string, string> = { ...flags };
  if (/^https?:\/\//i.test(positional)) {
    const ref = parseToolUrl(positional);
    if (!ref) throw new UsageError(`Not a recognised Lolly tool URL: ${clean(positional)}`);
    const urlParams = Object.fromEntries(new URLSearchParams(ref.query));
    params = { ...urlParams, ...flags };
    // URL mode's bare `export` is a PRESENCE flag ("auto-download on open"), not a
    // format — the same coalescing the run path applies.
    if (params.export === '') delete params.export;
    if (ref.format && params.format === undefined && params.export === undefined) params.format = ref.format;
    toolId = ref.toolId;
  }
  for (const f of OWN_FLAGS) delete params[f];

  // jsdom: `createRuntime` runs the tool's `onInit`, which may touch `document`.
  // Nothing is rendered into it — this is the same setup the `--share` path uses.
  const jsdom = await import('jsdom');
  const dom = new jsdom.JSDOM('<!DOCTYPE html><html><body><div id="canvas"></div></body></html>', {
    virtualConsole: quietVirtualConsole(jsdom),
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.Element = dom.window.Element;

  const tool = await loadToolOrThrow(toolId, readToolFile, { lang: normalizeLang(params.lang) ?? undefined });
  const profile = await readProfile(params['user-profile']);
  const host = await createCliBridge({ dom, profile, networkAllowlist: tool.manifest.network?.allowlist });

  // Collector-side caveats. They go BOTH to stderr (so an interactive reader sees
  // them beside the report) and into the artifact as `info` findings, because
  // `--out=report.json` discards stderr entirely and a caveat that lives only in a
  // stream is a caveat that does not travel with the copy it qualifies.
  const caveats: Finding[] = [];

  const unknown = unknownFlags(params, tool.manifest);
  if (unknown.length) {
    const list = unknown.map(k => `--${k}`).join(', ');
    process.stderr.write(
      `Warning: ${unknown.map(k => `--${clean(k)}`).join(', ')} ${unknown.length === 1 ? 'is not an input' : 'are not inputs'} of "${clean(tool.manifest.id)}" and ${unknown.length === 1 ? 'was' : 'were'} not preflighted.\n`,
    );
    caveats.push({
      id: 'collect.flags-not-preflighted',
      severity: 'info',
      needs: 'not-carried',
      message: `${list} ${unknown.length === 1 ? 'is not an input' : 'are not inputs'} of this tool, so ${unknown.length === 1 ? 'it was' : 'they were'} dropped and not preflighted.`,
      evidence: { flags: list, count: unknown.length },
    });
  }

  // The same query pipeline as a render: decrypt an encrypted link, expand a
  // packed one, then parse the reserved params.
  let rawQuery = new URLSearchParams(params).toString();
  if (hasEncryptedState(rawQuery)) {
    const explicit = params['link-password'];
    rawQuery = await decryptLinkQuery(rawQuery, explicit ?? params.password, explicit === undefined);
  }
  const query = await expandQuery(rawQuery);
  const state = parseUrlState(query, tool.manifest);
  const { values, width, height, unit, dpi, password, c2pa, bleed, imprint, durable, cuts, hdr } = state;

  // ── The model. `createRuntime` runs onInit, so this is the POST-INIT model and a
  // paginate count is exact rather than a ceiling. If onInit cannot run headlessly
  // the DECLARED model is used instead and the phase says so, which downgrades the
  // affected counts to ceilings rather than quietly asserting them.
  let model: readonly PreflightInput[];
  let modelPhase: 'declared' | 'post-init' = 'post-init';
  let runtimeModel: Array<{ id: string; value: unknown }> = [];
  try {
    const runtime = await createRuntime(tool, host, values);
    runtimeModel = runtime.getModel() as Array<{ id: string; value: unknown }>;
    model = runtime.getModel() as unknown as readonly PreflightInput[];
  } catch (e) {
    process.stderr.write(`Note: this tool's onInit could not run here (${clean((e as Error).message)}). Checking the declared inputs instead.\n`);
    const declared = buildInputModel(tool.manifest, { profile: profile as never, initial: values });
    runtimeModel = declared as unknown as Array<{ id: string; value: unknown }>;
    model = declared as unknown as readonly PreflightInput[];
    modelPhase = 'declared';
    caveats.push({
      id: 'collect.on-init-not-run',
      severity: 'info',
      needs: 'not-resolved',
      message: `This tool's onInit could not run here (${(e as Error).message}), so the checks saw the declared inputs rather than the ones a render would use. Counts a hook could have changed are bounds, not facts.`,
      evidence: { reason: (e as Error).message },
    });
  }

  // ── The format, resolved exactly as the render path resolves it.
  const format =
    (flags.export || undefined) ?? state.format ??
    (flags.output ? formatFromOutput(flags.output, tool.manifest.render.formats) : null) ??
    matchedExportFormat(tool.manifest, runtimeModel) ??
    tool.manifest.render.formats[0] ?? '';

  // ── The palette. `host.tokens.colors()` is called DIRECTLY: a throw and an empty
  // list both map to `not-resolved`, because a count taken from a fallback palette
  // would be measuring swatches that are not the user's brand.
  const palette = await collectPalette(host);

  const job: PreflightJob = {
    source: 'cli',
    manifest: tool.manifest as unknown as PreflightJob['manifest'],
    model,
    modelPhase,
    rawInitial: values as Readonly<Record<string, unknown>>,
    settings: {
      format,
      size: sizeFacts(width, height, unit, dpi, tool.manifest.render),
      // Absent on the command line means the export applies none — an explicit
      // zero, not an unknown. (A batch row, which CARRIES none, is the case that
      // must report `{ known:false, why:'not-carried' }`; that is Phase 2's path.)
      bleed: { known: true, value: bleed ? parseDimension(bleed) : null },
      marks: { known: true, value: state.marks },
      // `--press-profile` is the explicit spelling; `--profile` is its frozen alias
      // and is what a shared print link carries (contract B1).
      pressProfile: { known: true, value: params['press-profile'] ?? params.profile ?? null },
      cuts,
      password: Boolean(password),
      c2pa: c2pa == null ? { known: false, why: 'not-set' } : { known: true, value: c2pa.on },
      imprint: imprint == null ? { known: false, why: 'not-set' } : { known: true, value: imprint },
      durable,
      hdr: Boolean(hdr),
      ...(flags.output ? { filename: flags.output } : {}),
    },
    palette,
    // The CLI has no mounted artwork. Saying so is a NAMED GAP in the report, not
    // an omission from it.
    stage: { known: false, why: 'needs-mount' },
  };

  const base = preflight(job);
  // Appended, never injected into the engine: these are facts about the
  // COLLECTION, not rules over the job, and the engine must stay unable to know
  // them. Info-severity, so they land after every engine finding in the existing
  // severity order and no re-sort is needed.
  const report: PreflightReport = caveats.length
    ? { ...base, findings: [...base.findings, ...caveats], gaps: [...base.gaps, ...caveats] }
    : base;

  const errors = report.findings.filter(f => f.severity === 'error').length;
  const warns = report.findings.filter(f => f.severity === 'warn').length;
  const exit = errors > 0 || (strict && warns > 0) ? 1 : 0;

  // One envelope, every command (contract §5.2). preflight used to emit its own
  // `$format: lolly-preflight-*` document, which made it the second machine shape in a
  // CLI whose whole machine promise is that there is one. The report itself is
  // unchanged — it is now `result` inside the envelope.
  if (json) {
    const { envelope, emitResult } = await import('./envelope.ts');
    if (outPath) {
      await writeFile(resolve(process.cwd(), outPath), JSON.stringify(await envelope(report, exit === 0), null, 2) + '\n');
    } else {
      await emitResult(report, exit);
    }
    return exit;
  }
  const text = humanReport(report, job, tool.manifest);
  if (outPath) await writeFile(resolve(process.cwd(), outPath), text);
  else process.stdout.write(text);
  return exit;
}

/**
 * The brand palette, or a named refusal.
 *
 * Both failure modes collapse to `not-resolved` on purpose: `host.tokens.colors()`
 * returning nothing is indistinguishable from it throwing, and neither is "this
 * brand has no colours".
 */
async function collectPalette(host: { tokens?: { colors(): Promise<unknown> } }): Promise<Fact<readonly PreflightSwatch[]>> {
  if (!host.tokens) return { known: false, why: 'not-resolved' };
  try {
    const colors = await host.tokens.colors();
    if (!Array.isArray(colors) || colors.length === 0) return { known: false, why: 'not-resolved' };
    return { known: true, value: colors as readonly PreflightSwatch[] };
  } catch {
    return { known: false, why: 'not-resolved' };
  }
}

/**
 * The output size as the export path would resolve it.
 *
 * `unitDeclared` is true only when the command line SPELLED a unit out
 * (`parseUrlState` returns null for an absent `unit`), so preflight refuses to
 * derive a print area from a number nobody qualified. A manifest size is bare
 * pixels by construction and can never be a physical trim.
 *
 * A HALF-DECLARED size (`--width=210 --unit=mm`, no `--height`) leaves the other
 * dimension at 0, because `PreflightSize` has no absent shape and the real export
 * path resolves it from the artwork's aspect, which is not readable headlessly.
 * That 0 is never converted into geometry: `physicalTrim` requires both
 * dimensions to be positive, and the engine emits
 * `print.trim-partially-declared` instead. It used to sail through and produce
 * three `bound: 'exact'` counts of 0 m2.
 */
function sizeFacts(
  width: number | null, height: number | null, unit: string | null, dpi: number | null,
  render: { width?: number; height?: number },
): PreflightSize {
  const u = unit && isUnit(unit) ? unit : 'px';
  const declared = width != null || height != null;
  const w = width ?? (declared ? 0 : render.width ?? 0);
  const h = height ?? (declared ? 0 : render.height ?? 0);
  return {
    width: { value: w, unit: declared ? u : 'px' },
    height: { value: h, unit: declared ? u : 'px' },
    // px is a screen unit: DPI does not scale it, so the default differs by unit
    // exactly as the export path's does (300 for physical, CSS 96 for pixels).
    // A non-positive `?dpi=` is dropped rather than echoed: `parseUrlState` passes
    // `dpi=-5` through, the export path's `dpi || 300` discards it, and printing
    // "at -5 DPI" would report a resolution no render will ever use.
    dpi: dpi != null && dpi > 0 ? dpi : (u === 'px' ? 96 : 300),
    declaredBy: declared ? 'url' : 'manifest',
    unitDeclared: declared && unit != null,
  };
}

// ─── The human report ───────────────────────────────────────────────────────

const MARKS: Record<Severity, string> = { error: '✕', warn: '!', info: 'ℹ' };
const COLOURS: Record<Severity, string> = { error: RED, warn: YELLOW, info: DIM };

/**
 * Same three-part anatomy as `validate.ts`: bold subject line, headline verdict,
 * padded fact block, then one row per finding.
 *
 * Exported as a test seam: the printer is the only place a finding becomes a line,
 * so a harness that wants to assert what a job LOOKS like (a finish ink no brand in
 * the tree declares yet, for instance) can build a job, run `preflight()` and render
 * it here rather than reimplementing the layout.
 *
 * NOTE the one deviation from the surface brief: it described `ok`/`✓` rows for
 * passed checks. `Severity` as implemented is `info | warn | error` with no `ok`
 * member, and the engine emits nothing for a check that found nothing to say — so
 * there are no passed-check rows to print. The evidence that counting happened is
 * the fact block and the counts, which print whether the report is clean or not.
 */
export function humanReport(report: PreflightReport, job: PreflightJob, manifest: { id: string; name?: string }): string {
  const out: string[] = [];
  const errors = report.findings.filter(f => f.severity === 'error').length;
  const warns = report.findings.filter(f => f.severity === 'warn').length;
  const infos = report.findings.filter(f => f.severity === 'info').length;

  out.push(`${paint(BOLD, clean(manifest.id))}${report.job.format ? paint(DIM, `  [${clean(report.job.format)}]`) : ''}`);
  out.push(headline(errors, warns, infos));

  for (const [k, v] of jobFacts(job, report)) {
    if (v == null || v === '') continue;
    out.push(`  ${paint(DIM, k.padEnd(12))} ${clean(v)}`);
  }

  for (const f of report.findings) out.push(findingRow(f));

  if (report.counts.length) {
    out.push('');
    out.push(paint(DIM, `  Counted ${report.counts.length} ${report.counts.length === 1 ? 'quantity' : 'quantities'}:`));
    for (const c of report.counts) {
      const box = c.box ? ` (${c.box})` : '';
      const bound = c.bound === 'ceiling' ? ' at most' : '';
      out.push(`  ${paint(DIM, '·')} ${clean(c.kind)}${box}${bound}: ${clean(fmtNum(c.value))} ${clean(c.unit)} ${paint(DIM, `— ${clean(c.basis)}`)}`);
    }
  }

  out.push('');
  out.push(paint(DIM,
    `${report.findings.length} ${report.findings.length === 1 ? 'finding' : 'findings'} — ` +
    `${errors} to fix, ${warns} to check, ${infos} to know (${report.gaps.length} of them a stated gap). ` +
    `engine ${clean(report.engine)}`));
  return out.join('\n') + '\n';
}

function headline(errors: number, warns: number, infos: number): string {
  if (errors > 0) return paint(RED, `✕ ${errors} to fix`) + paint(DIM, `, ${warns} to check, ${infos} to know`);
  if (warns > 0) return paint(YELLOW, `! ${warns} to check`) + paint(DIM, `, ${infos} to know`);
  if (infos > 0) return paint(GREEN, '✓ Nothing to fix') + paint(DIM, `, ${infos} to know`);
  return paint(GREEN, '✓ Nothing to fix');
}

function findingRow(f: Finding): string {
  const mark = paint(COLOURS[f.severity] ?? DIM, MARKS[f.severity] ?? '·');
  const needs = f.needs ? paint(DIM, `  [needs: ${clean(f.needs)}]`) : '';
  return `  ${mark} ${clean(f.id)} ${paint(DIM, '— ' + clean(f.message))}${needs}`;
}

/**
 * The settings AS RESOLVED. They print whether the report is clean or not: a
 * reader must be able to confirm preflight ran against the settings a render
 * would use, and the counts are the feature.
 */
function jobFacts(job: PreflightJob, report: PreflightReport): Array<[string, string | null]> {
  const s = job.settings;
  const size = s.size;
  const bleed = s.bleed.known ? (s.bleed.value ? `${fmtNum(s.bleed.value.value)} ${s.bleed.value.unit}` : 'none') : `unknown (${s.bleed.why})`;
  const marks = s.marks.known
    ? (s.marks.value ? (Object.entries(s.marks.value).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none') : 'none')
    : `unknown (${s.marks.why})`;
  const press = s.pressProfile.known ? (s.pressProfile.value ?? 'none') : `unknown (${s.pressProfile.why})`;
  const pages = report.counts.find(c => c.kind === 'pages');
  return [
    ['Format', s.format || null],
    // A half-declared size still prints, naming the dimension that is missing.
    // Suppressing the row hid the very input that produced the odd report.
    ['Size', size.width.value > 0 && size.height.value > 0
      ? `${fmtNum(size.width.value)} x ${fmtNum(size.height.value)} ${size.width.unit} at ${fmtNum(size.dpi)} DPI${size.declaredBy === 'manifest' ? ' (from the tool, not set)' : ''}`
      : size.width.value > 0 ? `${fmtNum(size.width.value)} ${size.width.unit} wide, height not set`
      : size.height.value > 0 ? `${fmtNum(size.height.value)} ${size.height.unit} tall, width not set`
      : null],
    ['Bleed', bleed],
    ['Marks', marks],
    ['Press', press],
    ['Palette', job.palette.known ? `${job.palette.value.length} brand swatches` : `unresolved (${job.palette.why})`],
    ['Pages', pages ? `${fmtNum(pages.value)}${pages.bound === 'ceiling' ? ' at most' : ''}` : null],
    ['Artwork', job.stage.known ? 'on screen' : 'not mounted (headless)'],
  ];
}

const fmtNum = (n: number): string => {
  if (!Number.isFinite(n)) return '?';
  const r = Math.round(n * 10000) / 10000;
  return String(r);
};
