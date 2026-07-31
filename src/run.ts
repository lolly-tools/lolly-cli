// SPDX-License-Identifier: MPL-2.0
/**
 * CLI runner — the working implementation.
 *
 * Loads a tool from disk, runs the engine against a jsdom DOM, and writes the
 * exported file. This is the SAME engine path the web shell uses; only the
 * host bridge implementation differs. That's the URL-mode-as-CLI principle —
 * CLI is just a different transport, not a different render engine.
 */

import { readFile, writeFile, stat } from 'node:fs/promises';
import { join, resolve, basename, extname } from 'node:path';

import { loadTool, createRuntime, parseUrlState, serializeUrlState, expandQuery, embedC2pa, C2PA_FORMATS, normalizeLang, parseDataRows, parseTableText, hasEncryptedState, unpackEncrypted, ENC_PARAM, RESERVED } from '@lolly/engine';
import type { Lang } from '@lolly/engine';
// NODE_FORMATS: the DOM-free/raster format split, shared with the TUI. Everything not
// in it — raster, pdf, video — is produced by raster.ts (resvg fast path, else the
// scoped Chromium).
import { NODE_FORMATS, DEEP_FORMATS, pxDims, matchedExportFormat } from '@lolly-tools/node-shell/raster';
import { buildExportC2paOpts } from '@lolly-tools/node-shell/c2pa-opts';
import { repoRoot } from '@lolly-tools/node-shell/repo-root';
// Fail loud: never write a degenerate file + exit 0 when the render silently failed.
import { assertRenderOk } from '@lolly-tools/node-shell/render-integrity';
// Fail loud, part two: refuse bytes that are demonstrably not the requested container
// (headless Chromium has no AV1 encoder, so an --export=avif used to write PNG).
import { assertFormatBytes } from '@lolly-tools/node-shell/format-sniff';
// url-shot: capture a live page via the scoped Chromium (shared with the TUI).
import { captureUrl, captureParamsFrom } from '@lolly-tools/node-shell/url-capture';
import { createCliBridge, applyBrandVars } from './bridge.ts';
import type { Profile, ExportOpts } from '@lolly-tools/core/host-v1';

const REPO_ROOT = repoRoot();

interface RunToolCliArgs {
  toolId: string;
  params: Record<string, string>;
  outputPath?: string;
  format?: string;
  /** --share/--link: print a shareable lolly.tools URL for the inputs instead of rendering. */
  share?: boolean;
  /** --verify: for a transform tool, print a per-file line saying the tool's own
   *  export checks ran and none failed. A failed check throws (exit 1) either way. */
  verify?: boolean;
  /** --html-fallback: OPT IN to receiving an HTML artifact when the requested format
   *  cannot be produced here. Off by default — silently substituting the format was
   *  the single worst defect in this shell (see the export section below). */
  htmlFallback?: boolean;
}

/**
 * Does this failure mean "the Node host can't do this, a real browser can"?
 *
 * TWO signals, in order of reliability:
 *
 *   1. A TYPED SENTINEL on the error — `err.code === 'NEEDS_BROWSER'`, or a truthy
 *      `err.needsBrowser`. This is the supported way for a tool hook to say it, and
 *      the only one that isn't coupled to prose. Tool hooks ship as DATA from a
 *      different repository, so wording there and control flow here must not be the
 *      same thing: `convert-image` fails hard today purely because its hook says
 *      "isn't available in this app" where the old regex expected "not available".
 *   2. The prose regex, kept as a compatibility fallback for every already-shipped
 *      tool. Broadened to accept the "isn't"/"is not" split that caused that bug.
 *
 * A verification failure reads like neither, so a failed export gate still fails loudly.
 *
 * Accepts an Error or a bare message string (the string form is what the older tests
 * and the MCP twin call it with).
 */
export function needsBrowserTier(err: unknown): boolean {
  if (err && typeof err === 'object') {
    const e = err as { code?: unknown; needsBrowser?: unknown };
    if (e.code === 'NEEDS_BROWSER' || e.needsBrowser === true) return true;
  }
  const message = typeof err === 'string' ? err : (err as { message?: unknown } | null)?.message;
  if (typeof message !== 'string') return false;
  //  "needs a browser canvas" · "is not / isn't / isn’t available in this app" · "needs a browser"
  return /browser canvas|n(?:['’]|o)t available in this app|needs a browser|requires a browser/i.test(message);
}

/** ExportOpts plus the two CLI-local extensions run.ts threads to the bridge:
 *  the PDF open-password and the `hdr=` dials (the canonical HostV1 ExportOpts
 *  carries neither — the web shell extends it the same way). */
type CliExportOpts = ExportOpts & {
  password?: string;
  hdr?: { targets?: readonly string[]; peakNits?: number; reach?: number; lift?: number; richness?: number };
};

/** Brand semantic slots offered to the HDR view transform as boost targets. The
 *  bright, saturated end of the brand — a brand's `surface`/`text`/`muted` are the
 *  page, not the thing that should glow. Mirrors what the web export panel sends as
 *  `palette` (its brand primaries), not the full var set applyBrandVars writes. */
const BRAND_HDR_SLOTS = ['primary', 'secondary'] as const;

export async function runToolCli({ toolId, params, outputPath, format, share, verify, htmlFallback }: RunToolCliArgs): Promise<void> {
  // Lazy import — jsdom is heavy and we only need it when actually rendering.
  const jsdom = await import('jsdom');
  const dom = new jsdom.JSDOM('<!DOCTYPE html><html><body><div id="canvas"></div></body></html>');
  // Expose enough globals for the engine + Handlebars to work happily.
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.Element = dom.window.Element;

  const fetchFile = async (path: string): Promise<string> => {
    const full = join(REPO_ROOT, 'tools', path);
    return readFile(full, 'utf8');
  };

  // --lang=xx selects the tool's manifest translation sidecar, if it ships one
  // (engine/src/loader.ts's applyManifestI18n) — the CLI is URL mode under a
  // different transport, so this is the same `lang` reserved param, read
  // directly rather than through parseUrlState (which treats it as reserved
  // and never surfaces it in `values`).
  const tool = await loadToolOrThrow(toolId, fetchFile, { lang: normalizeLang(params.lang) ?? undefined });

  // --profile=path.json pre-fills bindToProfile inputs from the user's profile
  // (the bridge serves it via host.profile.get). A missing/invalid file warns
  // and continues with an empty profile, so the render still runs.
  const profile = await readProfile(params.profile);
  // Thread the manifest's network.allowlist into host.net (same per-tool gate the
  // web view applies post-load) — without it every host.net fetch on the CLI
  // rejects, breaking the one-render-path parity for network-capable tools.
  const host = await createCliBridge({ dom, profile, networkAllowlist: tool.manifest.network?.allowlist });

  // Warn about flags this tool has no use for. The docs promise flags are validated
  // against the manifest; they were simply swallowed, so a typo (`--urll=…`) rendered
  // defaults with no hint that the value went nowhere.
  warnUnknownFlags(params, tool.manifest);

  // A password-protected share link (`zx=…`) carries the WHOLE state encrypted. The web
  // shell prompts for the password; the CLI takes it as a flag. Decrypt BEFORE expandQuery,
  // exactly as the web shell does, so everything downstream sees a plain query.
  //
  // NO SILENT DEFAULTS. `zx` is a reserved param, so parseUrlState ignores it — which meant
  // a missing or wrong password rendered the tool's DEFAULTS and exited 0. A wrong document
  // that looks right is the worst thing this shell can emit, so both cases now throw.
  let rawQuery = new URLSearchParams(params).toString();
  if (hasEncryptedState(rawQuery)) {
    // `--password` is url-mode's PDF open-password. When it is the only password on the
    // command line and the link is encrypted, it is obviously meant for the link, so it is
    // consumed here and removed from the query rather than also locking an exported PDF.
    // `--link-password` is the unambiguous form and always wins.
    const explicit = params['link-password'];
    rawQuery = await decryptLinkQuery(rawQuery, explicit ?? params.password, explicit === undefined);
  }
  // Expand a packed `z=…` param back into a plain query — the CLI is URL mode under a
  // different transport, so a packed share link must run identically here
  // (`lolly layout-studio --z=1eJ…`). A no-op for ordinary readable params.
  const query = await expandQuery(rawQuery);
  const { values, format: paramFormat, width, height, unit, dpi, password, c2pa, bleed, imprint, durable, depth, hdr } = parseUrlState(
    query,
    tool.manifest,
  );
  // Print prep + press intent for the browser (Tier-B) export tier. `marks` is passed as
  // the raw CSV (?marks) rather than round-tripped through parseUrlState's flag map, and
  // read off the EXPANDED query so a packed link works too. The CMYK press condition uses
  // a distinct --press-profile flag: url-mode's `profile` means the press condition, but
  // the CLI's --profile is the user-profile JSON file (readProfile above) — never conflate.
  const marksRaw = new URLSearchParams(query).get('marks') || null;
  const pressProfile = params['press-profile'] || null;

  // File-typed inputs arrive as a filesystem path (--photo=./pic.jpg → an
  // {__file, path} ref from parseUrlState). The engine can't read files (it's
  // platform-agnostic), so the CLI loads the bytes here, into the same FileRef
  // shape the web picker produces — before createRuntime sees them.
  for (const input of tool.manifest.inputs ?? []) {
    if (input.type !== 'file') continue;
    const ref = values[input.id];
    const p = ref && typeof ref === 'object' ? (ref as { path?: string }).path : null;
    if (!p) { delete values[input.id]; continue; }
    const abs = resolve(process.cwd(), p);
    const buf = await readFile(abs);
    values[input.id] = {
      __file: true,
      name: basename(abs),
      mime: mimeForFile(abs),
      size: buf.length,
      bytes: new Uint8Array(buf),
      url: null,
    };
  }

  // An `asset` input can also take the user's OWN local image (--logo=./brand.png), not
  // just a catalog id or a lolly.tools URL. When the ref's id resolves to a real file on
  // disk, load its bytes into a self-contained (baked) AssetRef here — the same in-memory
  // shape a web upload produces — so the runtime uses it directly instead of asking the
  // catalog for it. A catalog id (suse/logo/…) isn't a real file, so it falls through to
  // normal resolution; a tool URL stays 'remote' for compose.
  for (const input of tool.manifest.inputs ?? []) {
    if (input.type !== 'asset') continue;
    const ref = values[input.id];
    if (!ref || typeof ref !== 'object') continue;
    const r = ref as { id?: string; source?: string };
    if (!r.id || r.source === 'remote') continue;   // tool URLs render via compose, not disk
    let st: Awaited<ReturnType<typeof stat>> | undefined;
    try { st = await stat(resolve(process.cwd(), r.id)); } catch { continue; }  // not a local file → catalog
    if (!st.isFile()) continue;
    const abs = resolve(process.cwd(), r.id);
    const mime = mimeForFile(abs);
    const isVec = mime === 'image/svg+xml';
    const bytes = await readFile(abs);
    values[input.id] = {
      source: 'user',
      id: basename(abs),
      type: isVec ? 'vector' : 'raster',
      format: isVec ? 'svg' : (mime.split('/')[1] || 'png'),
      url: `data:${mime};base64,${bytes.toString('base64')}`,
      meta: { baked: true, name: basename(abs) },
    };
  }

  // `--<blocksInput>-data=rows.csv` populates a `blocks` input from a CSV/JSON file via the
  // SAME engine importer the web offers — so a chart/table can be filled from a spreadsheet
  // headlessly instead of hand-encoding tilde/JSON rows. Read from `params` (the flag isn't
  // a declared input, so parseUrlState ignores it).
  for (const input of tool.manifest.inputs ?? []) {
    if (input.type !== 'blocks') continue;
    const dataPath = params[`${input.id}-data`];
    if (!dataPath) continue;
    const text = await readFile(resolve(process.cwd(), dataPath), 'utf8');
    const fields = (input.fields ?? []) as Array<{ id: string; label?: string; type?: string }>;
    const { rows, truncated } = parseDataRows(text, { fields });
    values[input.id] = rows as (typeof values)[string];
    process.stderr.write(`✓ Imported ${rows.length} row${rows.length === 1 ? '' : 's'} into --${input.id} from ${dataPath}${truncated ? ' (row cap reached)' : ''}\n`);
  }

  // `--<tableInput>-data=table.csv` fills a `table` input from a CSV/TSV/Markdown
  // file (first row = headings) — the headless twin of the sidebar's spreadsheet
  // paste. The inline form (--data=<compact-or-JSON string>) already works via
  // parseUrlState; this flag is for real files. Read from `params` (not a
  // declared input, so parseUrlState ignores it).
  for (const input of tool.manifest.inputs ?? []) {
    if (input.type !== 'table') continue;
    const dataPath = params[`${input.id}-data`];
    if (!dataPath) continue;
    const text = await readFile(resolve(process.cwd(), dataPath), 'utf8');
    const parsed = parseTableText(text);
    if (!parsed) throw new Error(`--${input.id}-data: ${dataPath} does not parse as a CSV/TSV/Markdown table`);
    values[input.id] = parsed as (typeof values)[string];
    process.stderr.write(`✓ Imported ${parsed.rows.length} row${parsed.rows.length === 1 ? '' : 's'} × ${parsed.columns.length} columns into --${input.id} from ${dataPath}\n`);
  }

  // --share/--link: print a shareable lolly.tools link for the current inputs instead of
  // rendering (the CLI half of the web Share dialog + the TUI's `u`). Handled BEFORE the
  // transform/format paths so it works for any tool; a teammate reopens the exact config
  // without hand-reconstructing a URL. (A `file`-typed input has no shareable form, so it
  // is simply absent from the link — same as the web.)
  if (share) {
    const runtime = await createRuntime(tool, host, values);
    const q = serializeUrlState(runtime.getModel());
    process.stdout.write(`https://lolly.tools/#/tool/${tool.manifest.id}${q ? '?' + q : ''}\n`);
    return;
  }

  // Transform-path tools (on-device utilities) produce their output via the
  // exportFile hook (bytes in → bytes out), not by rendering a DOM node. They
  // don't use a render format at all — short-circuit before the format checks.
  if (tool.manifest.hooks?.exportFile) {
    const runtime = await createRuntime(tool, host, values);
    const fileIn = (tool.manifest.inputs ?? []).find(i => i.type === 'file');
    let tier = 'node';
    let bytes: Uint8Array;
    let filename: string | undefined;
    let usedTransformBrowser = false;
    try {
      const res = await runtime.exportFile();
      bytes = res.bytes as Uint8Array;
      filename = res.filename;
    } catch (e) {
      const msg = (e as Error).message;
      const ref = fileIn ? (values[fileIn.id] as { name?: string; mime?: string; bytes?: Uint8Array } | undefined) : undefined;
      if (!needsBrowserTier(e) || !fileIn || !ref?.bytes) throw e;
      // The utility rebuilds real pixels (canvas / PDF page render), which the Node
      // host cannot do. Re-run the SAME hook in the scoped browser driving the built
      // web shell — the tool's export gate runs there, on these bytes. When no browser
      // or no built shell is present, transformViaWebShell names exactly what's missing.
      process.stderr.write(`Note: ${msg} Running it in the browser tier instead.\n`);
      const { transformViaWebShell } = await import('@lolly-tools/node-shell/webshell-render');
      const out = await transformViaWebShell({
        toolId: tool.manifest.id,
        fileInputId: fileIn.id,
        file: { name: ref.name || 'input', mime: ref.mime || 'application/octet-stream', bytes: ref.bytes },
        query: serializeUrlState(runtime.getModel()),
      });
      bytes = out.bytes;
      filename = out.filename;
      tier = 'browser';
      usedTransformBrowser = true;
    }
    // Copy the VIEW (not `.buffer`): the browser tier hands back a Uint8Array whose
    // backing buffer may be larger than the file, and `.buffer` would write the slack.
    const buf = Buffer.from(bytes);
    const dest = outputPath || (filename ? resolve(process.cwd(), filename) : null);
    if (dest) {
      await writeFile(dest, buf);
      // One-line result summary (input→output delta + the tool's a11y summary) so the
      // headless path reports what a transform did, not just a byte count. Matches the
      // TUI's utility result panel.
      const inBytes = fileIn ? (values[fileIn.id] as { size?: number } | undefined)?.size : undefined;
      const label = runtime.getHydratedString(tool.manifest.a11yLabel).trim();
      const delta = typeof inBytes === 'number' ? `${inBytes.toLocaleString()} → ${buf.length.toLocaleString()} bytes` : `${buf.length.toLocaleString()} bytes`;
      process.stderr.write(`✓ ${label ? label + ' — ' : ''}${delta} → ${dest}\n`);
    } else {
      process.stdout.write(buf);
    }
    // --verify: one line per file. The tool's exportFile is what runs the checks and
    // it throws on a failed one (nothing is written, exit 1), so reaching here means
    // no check failed. Stated exactly that way — this does not re-run anything.
    if (verify) {
      const srcName = fileIn ? (values[fileIn.id] as { name?: string } | undefined)?.name ?? '(input)' : '(no file input)';
      process.stderr.write(`✓ verified: ${tool.manifest.id} exported ${srcName} with no failed check (tier: ${tier})\n`);
    }
    if (usedTransformBrowser) {
      const [{ closeBrowser }, { closeWebShell }] = await Promise.all([
        import('@lolly-tools/node-shell/browsers'), import('@lolly-tools/node-shell/webshell-render'),
      ]);
      await Promise.all([closeBrowser(), closeWebShell()]);
    }
    return;
  }

  // The runtime resolves asset refs (catalog ids → AssetRefs with a `format`), which
  // the matchExportFormat default below reads — so it's created before format resolution.
  const runtime = await createRuntime(tool, host, values);

  // Format resolution mirrors URL mode: an explicit flag wins (--export= arrives
  // as `format`, --format= as `paramFormat`); otherwise infer it from the
  // --output extension; otherwise a manifest-flagged matchExportFormat input
  // defaults to its uploaded file's own format (a dropped JPEG → jpg — same
  // rule as the web shell); otherwise the tool's first declared format.
  const targetFormat =
    format ?? paramFormat ??
    (outputPath ? formatFromOutput(outputPath, tool.manifest.render.formats) : null) ??
    matchedExportFormat(tool.manifest, runtime.getModel() as Array<{ id: string; value: unknown }>) ??
    tool.manifest.render.formats[0]!;

  // The PRO float formats (exr / .hdr) are admitted for ANY tool, declared or not.
  // plans/deeprichpixels.md §10 rules out per-tool depth declarations — depth is an
  // export concern, tools stay declarative — so a tool.json listing "exr" would be
  // exactly the mistake the plan names (and would drag the schema enum plus every
  // per-brand generated catalog index along with it). The honest gate is at render
  // time instead: a tool with no vector root, or a request with no float source,
  // refuses with a message that says which. See DEEP_FORMATS in node-shell/raster.ts.
  if (!tool.manifest.render.formats.includes(targetFormat) && !DEEP_FORMATS.includes(targetFormat as never)) {
    throw new Error(
      `Tool "${toolId}" does not support format "${targetFormat}". ` +
      `Supported: ${tool.manifest.render.formats.join(', ')}` +
      ` (plus the pro float formats ${DEEP_FORMATS.join(', ')}, which need hdr=1)`,
    );
  }

  let finalFormat = targetFormat;         // the format actually written (may fall back to html)
  let buf: Buffer;
  let usedBrowser = false;                // a pooled browser was launched → tear it down before exit
  let webShellExport = false;             // the Tier-B web shell produced the bytes → it owns c2pa

  if (isCaptureTool(tool.manifest)) {
    // Capture tools (url-shot): drive the scoped Chromium straight at the target URL —
    // jsdom can't rasterise a live page. The SAME capture path the TUI uses; a clear,
    // actionable BrowserError surfaces if no browser is installed (`lolly install-browser`).
    const params = captureParamsFrom(runtime.getModel() as Array<{ id: string; value: unknown }>);
    const cdims = pxDims(
      { width: width ?? undefined, height: height ?? undefined, unit: unit ?? undefined, dpi: dpi ?? undefined },
      tool.manifest as { render?: { width?: number; height?: number } },
    );
    const cap = await captureUrl(params, targetFormat, cdims);
    buf = Buffer.from(cap.bytes);
    usedBrowser = true;                   // captureUrl launched the pooled Chromium
  } else {
    // Set up the rendering DOM. Brand vars go on first: the catalog's semantic
    // colour slots (--brand-primary, --brand-surface, …) land on the canvas root
    // BEFORE hydration, so a template's var(--brand-primary, fallback) reads the
    // same brand via web, URL mode, and CLI (plans/brand-token-contract.md §7).
    const canvas = dom.window.document.getElementById('canvas')!;
    await applyBrandVars(canvas, host);
    canvas.innerHTML = runtime.getHydrated();

    // Pass through requested output dimensions. A physical unit (mm/cm/in/pt)
    // qualifies the value so the engine converts it for the format; px is the
    // default. (e.g. --width=210 --height=297 --unit=mm --export=svg → A4.)
    const u = unit || 'px';
    const qual = (v: number | null | undefined): string | number | undefined => (typeof v === 'number' && v > 0 ? (u !== 'px' ? `${v}${u}` : v) : undefined);
    const exportOpts: CliExportOpts = { width: qual(width), height: qual(height) };
    if (u !== 'px') exportOpts.dpi = dpi || 300;
    // --depth=8|16|float requests the export's bits per channel (--depth=auto, the
    // default, carries nothing). A request, not a promise: depth follows provenance,
    // so the writer emits deep bits only where the pipeline produced them.
    //
    // CONSUMED on the CLI as of Phase B3: --export=exr --depth=float writes 32-bit
    // FLOAT samples instead of the default 16-bit HALF. Every other combination is
    // logged and ignored rather than obeyed — EXR has no integer sample type, Radiance
    // is RGBE by definition, and no CLI raster path has a >8-bit SOURCE yet, so
    // --depth=16 on png/tiff here would be padding. See plans/deeprichpixels.md §10
    // and the note in docs/url-mode.md.
    if (depth !== 'auto') exportOpts.depth = depth;
    // --hdr=… routes the render through the engine's float HDR view transform. Today
    // that is the CLI's ONLY float pixel source, so it is what exr/.hdr require; the
    // brand's semantic colours (already resolved onto the canvas by applyBrandVars
    // above) are the boost targets, so a CLI EXR glows on the same colours a web HDR
    // export does. Values that are not hex (an oklch() slot) are skipped by hdr.ts's
    // parser rather than failing the export.
    if (hdr) {
      exportOpts.hdr = {
        targets: BRAND_HDR_SLOTS
          .map(s => canvas.style.getPropertyValue(`--brand-${s}`).trim())
          .filter(v => /^#[0-9a-fA-F]{3,8}$/.test(v)),
        peakNits: hdr.peakNits, reach: hdr.reach, lift: hdr.lift, richness: hdr.richness,
      };
    }
    // --password= sets the standard PDF's open-password (basic lock).
    if (targetFormat === 'pdf' && password) exportOpts.password = password;

    const dims = {
      width: width ?? undefined, height: height ?? undefined, unit: unit ?? undefined, dpi: dpi ?? undefined,
      ...(password ? { password } : {}),
      ...(bleed ? { bleed } : {}),
      ...(marksRaw ? { marks: marksRaw } : {}),
      ...(imprint ? { imprint: true } : {}),
      ...(durable ? { durable: true } : {}),
      ...(pressProfile ? { pressProfile } : {}),
      // Forward the c2pa setting so the browser tier stamps it (single authority); the
      // Node post-stamp below is skipped when the browser ran, avoiding a double-stamp.
      ...(c2pa != null ? { c2pa: c2pa.on, c2paDays: c2pa.days ?? undefined } : {}),
    };
    const viaRaster = async (): Promise<Buffer> => {
      const { renderRaster } = await import('./raster.ts');
      const res = await renderRaster({ runtime, dom, manifest: tool.manifest, format: targetFormat, dims });
      const bytes = Buffer.from(res.bytes);
      usedBrowser = res.usedBrowser;
      webShellExport = res.usedBrowser; // Tier B == the web shell; it owns c2pa for that path
      // Tier A (resvg) rasterises THIS runtime's own SVG, so a swallowed hook failure
      // yields a blank raster — gate it. Tier B re-renders in a real browser whose host
      // has the capability, so hookErrors don't describe those bytes; renderViaWebShell
      // already throws if the browser produced nothing.
      if (!usedBrowser) assertRenderOk({ hookErrors: runtime.hookErrors, format: targetFormat, bytes });
      return bytes;
    };

    // Print prep on a path that cannot apply it. bleed/marks geometry lives in the web
    // shell (Tier B reads ?bleed/?marks off the export URL); the DOM-free engine export
    // has nowhere to put it, so asking for it here used to be a byte-for-byte no-op with
    // no warning. Refuse instead — for a print job a silently un-bled file is exactly the
    // kind of plausible wrong output that gets discovered at the press.
    if ((bleed || marksRaw) && NODE_FORMATS.includes(targetFormat.toLowerCase()) && !VECTOR_ESCALATABLE.has(targetFormat.toLowerCase())) {
      throw new Error(
        `--bleed/--marks cannot be applied to "${targetFormat}" here: print geometry is added by the full render tier, ` +
        `and "${targetFormat}" is produced directly by the engine, which has nowhere to put a bleed box or crop marks. ` +
        'Export pdf, pdf-cmyk, cmyk-tiff or png (which route through that tier), or drop the flags. No file was written.',
      );
    }

    // What the DOM-free attempt said, kept so a failed escalation can report BOTH halves
    // (why there is no browser-free path, and why the browser tier could not step in).
    let domFreeError: Error | null = null;
    try {
      try {
        // Engine-native / data formats (svg/emf/eps/dxf + html/json/csv/ics/vcf) render DOM-free
        // through the bridge. Raster/PDF/video route to raster.ts: Tier A (resvg, no browser)
        // for PNG from an SVG-native tool, else Tier B (the scoped Chromium driving the built
        // web shell). `usedBrowser` tells us to tear the browser + server down before exit.
        const domFree = NODE_FORMATS.includes(targetFormat.toLowerCase());
        // …EXCEPT: a vector format asked for WITH print prep has to start at the browser tier,
        // because that is the only tier that can honour bleed/marks (see the refusal above).
        const forceBrowser = domFree && !!(bleed || marksRaw);
        if (domFree && !forceBrowser) {
          const blob = await runtime.export(canvas, targetFormat, exportOpts);
          buf = Buffer.from(await blob.arrayBuffer());
          // The DOM-free render is this runtime's own output — a swallowed onInit failure
          // (e.g. an unavailable capability) yields an empty file. Refuse to write it.
          assertRenderOk({ hookErrors: runtime.hookErrors, format: targetFormat, bytes: buf });
        } else {
          buf = await viaRaster();
        }
      } catch (e) {
        // ESCALATION, not substitution. svg/emf/eps/dxf sit in NODE_FORMATS, so an
        // HTML-layout tool's "no root <svg>" used to end the story — even though the web
        // shell's HTML→SVG walker produces real vector for exactly that case. Retry at the
        // browser tier, the same way a raster format already does.
        //
        // The gate is a TYPE, not a phrase. The old fallback keyed on error prose and got
        // it wrong in both directions; "needs a browser engine" (plural verb) does not even
        // match needsBrowserTier's "needs a browser". So: escalate on any DOM-free failure
        // EXCEPT a RenderIntegrityError, which means this runtime's own render is broken
        // (a hook threw) and re-rendering it elsewhere would only launder the bug. If the
        // browser tier can't run either, both halves are reported and nothing is written.
        if (!VECTOR_ESCALATABLE.has(targetFormat.toLowerCase()) || (e as Error)?.name === 'RenderIntegrityError') throw e;
        domFreeError = e as Error;
        process.stderr.write(
          `Note: "${targetFormat}" has no browser-free path for this tool (${firstLine(domFreeError.message)}). ` +
          'Escalating to the browser render tier.\n',
        );
        buf = await viaRaster();
        domFreeError = null;
      }
    } catch (e) {
      // THE FORMAT IS NOT PRODUCIBLE HERE.
      //
      // What this used to do: notice a browser-ish error message, export HTML instead,
      // rename --output=aa.svg to aa.html, print a note, and EXIT 0. A pipeline that asked
      // for PDF received HTML and had no way to know. That is the single worst outcome
      // this shell can produce, so it is gone: the requested format either comes out or
      // the run fails, with nothing written at the requested path.
      //
      // The HTML artifact is still available, but only when asked for by name
      // (--html-fallback), because then the caller knows to expect it.
      if (!htmlFallback || finalFormat === 'html') throw exportFailure(targetFormat, e as Error, domFreeError);
      const blob = await runtime.export(canvas, 'html', {});
      buf = Buffer.from(await blob.arrayBuffer());
      assertRenderOk({ hookErrors: runtime.hookErrors, format: 'html', bytes: buf });
      finalFormat = 'html';
      webShellExport = false;
      usedBrowser = false;
      // Retarget --output to a .html name so the file's extension matches its content.
      if (outputPath) outputPath = outputPath.replace(/\.[^./\\]+$/, '') + '.html';
      process.stderr.write(
        `Warning: "${targetFormat}" could not be produced here (${firstLine((e as Error).message)}). ` +
        `--html-fallback was given, so HTML was written instead${outputPath ? ` — to ${outputPath}, NOT the name you asked for` : ''}.\n`,
      );
    }
  }

  // Refuse bytes that are demonstrably a different container from the one requested —
  // the --export=avif that quietly wrote PNG. Runs before the C2PA stamp (which picks its
  // embedder by format) and before anything is written.
  assertFormatBytes(finalFormat, buf);

  // --c2pa[=7|30|90|365] stamps Content Credentials into the finished bytes —
  // URL mode's `c2pa` param under the CLI transport (same last-byte-operation
  // rule as the web shell's stampC2pa). Applies to any C2PA-capable format the
  // CLI now produces (svg via the engine; png/jpg/pdf via the raster tiers);
  // off/unsupported is a clear warn-and-continue, mirroring the web shell's
  // never-fail-the-export policy. Ephemeral on-device signing only — verifiers
  // report it unverified; the enrolled-identity path is a browser feature (see
  // docs/content-credentials-identity.md).
  if (c2pa?.on && !webShellExport && C2PA_FORMATS.includes(finalFormat)) {
    // Only the paths that produced their OWN bytes here (DOM-free svg, Tier-A resvg PNG,
    // url-shot capture) stamp in Node. The Tier-B browser tier already stamped via the
    // forwarded ?c2pa param (exportUrl) — re-stamping would double the credential.
    if (finalFormat === 'pdf' && password) {
      process.stderr.write('Warning: password-locked export — skipping Content Credentials (an encrypted document cannot take the C2PA update).\n');
    } else {
      try {
        // The "what was this made from / where / when / how big" record, matching
        // the web shell's tools.lolly.export enrichment (shared with the TUI —
        // buildExportC2paOpts also attaches the profile author under `useDetails`).
        const stamped = await embedC2pa(new Uint8Array(buf), finalFormat, buildExportC2paOpts({
          surface: 'cli', manifest: tool.manifest, model: runtime.getModel(),
          format: finalFormat, dims: { width, height, unit, dpi }, days: c2pa.days, profile,
        }));
        buf = Buffer.from(stamped.buffer as ArrayBuffer, stamped.byteOffset, stamped.byteLength);
      } catch (e) {
        process.stderr.write(`Warning: Content Credentials not attached — ${(e as Error).message}\n`);
      }
    }
  } else if (c2pa?.on && !webShellExport) {
    process.stderr.write(`Warning: format "${finalFormat}" has no C2PA container — Content Credentials skipped.\n`);
  }

  if (outputPath) {
    await writeFile(outputPath, buf);
    process.stderr.write(`✓ Wrote ${buf.length} bytes to ${outputPath}\n`);
  } else {
    process.stdout.write(buf);
  }

  // Tier B launches a pooled Chromium + a localhost dist server. This CLI run is
  // single-shot, so tear them down (the bin's explicit exit() would kill them anyway;
  // this keeps a programmatic caller from leaking a browser + open port).
  if (usedBrowser) {
    const [{ closeBrowser }, { closeWebShell }] = await Promise.all([
      import('@lolly-tools/node-shell/browsers'), import('@lolly-tools/node-shell/webshell-render'),
    ]);
    await Promise.all([closeBrowser(), closeWebShell()]);
  }
}

/**
 * Vector formats that live in NODE_FORMATS (the DOM-free engine tries them first) but
 * that the BROWSER tier can also produce — the web shell's HTML→SVG walker turns an
 * HTML-layout tool into real vector, and its EMF/EPS/DXF emitters ride the same IR.
 * So a DOM-free failure on one of these is a reason to escalate, not to refuse.
 */
const VECTOR_ESCALATABLE = new Set(['svg', 'emf', 'eps', 'eps-cmyk', 'dxf']);

const firstLine = (s: string): string => String(s ?? '').split('\n')[0]!.trim();

/**
 * The refusal for "this format cannot be produced here".
 *
 * Names both halves when there are two (no browser-free path AND the browser tier could
 * not step in), so the reader is not left guessing which piece is missing, and always
 * ends with the concrete way out. The underlying errors already carry the actionable
 * hints — `lolly install-browser` from browsers.ts, `npm run build:web` from
 * webshell-render.ts — so they are quoted rather than paraphrased.
 */
export function exportFailure(format: string, failure: Error, domFreeError: Error | null): Error {
  const parts = [`Cannot export "${format}".`];
  if (domFreeError) parts.push(`No browser-free path: ${firstLine(domFreeError.message)}`);
  parts.push(`${domFreeError ? 'And the full render tier is unavailable' : 'Reason'}: ${firstLine(failure.message)}`);
  parts.push('No file was written. Pass --html-fallback if an HTML artifact under a .html name is genuinely useful to you.');
  // A TYPED marker, not prose: `lolly smoke` (browser-free by budget rule) uses it to tell
  // "this tool needs the render tier I am not allowed to launch" from a real render bug,
  // without pattern-matching sentences. Same lesson as needsBrowserTier's sentinel.
  const err = new Error(parts.join(' ')) as Error & { cause?: unknown; code?: string; format?: string };
  err.cause = failure;
  err.code = 'FORMAT_UNAVAILABLE';
  err.format = format;
  return err;
}

/** Flags this shell reads itself, on top of url-mode's RESERVED set. */
const CLI_FLAGS = new Set(['press-profile', 'link-password', 'html-fallback', 'help', 'version']);

/**
 * Warn about `--flags` that match nothing — no declared input, no `urlKey` alias, no
 * reserved param, no CLI flag. They were silently swallowed, so `--urll=https://…`
 * rendered the tool's defaults and said nothing. A warning, not an error: url-mode is
 * deliberately tolerant of extra params (a share link can carry view state a tool no
 * longer declares), and turning that into an exit-1 would break working links.
 */
export function unknownFlags(
  params: Record<string, string>,
  manifest: { inputs?: Array<{ id: string; urlKey?: string; type?: string }> },
): string[] {
  const inputs = manifest.inputs ?? [];
  const known = new Set<string>();
  for (const i of inputs) {
    known.add(i.id);
    if (i.urlKey) known.add(i.urlKey);
    known.add(`${i.id}-data`);          // --<blocks|table>-data=rows.csv
  }
  const prefixes = inputs.map(i => `${i.id}.`);   // --<vector>.<field>=<number>
  return Object.keys(params).filter(
    k => !known.has(k) && !RESERVED.has(k) && !CLI_FLAGS.has(k) && !prefixes.some(p => k.startsWith(p)),
  );
}

function warnUnknownFlags(params: Record<string, string>, manifest: { id: string; inputs?: Array<{ id: string; urlKey?: string }> }): void {
  const unknown = unknownFlags(params, manifest);
  if (!unknown.length) return;
  process.stderr.write(
    `Warning: ${unknown.map(k => `--${k}`).join(', ')} ${unknown.length === 1 ? 'is not an input' : 'are not inputs'} of "${manifest.id}" ` +
    `and had no effect. Run \`lolly ${manifest.id}\` to list its inputs.\n`,
  );
}

/**
 * Decrypt a `zx=…` share link into the plain query it protects.
 *
 * Throws — never returns the encrypted query — because the alternative is what this
 * shell used to do: `zx` is reserved, parseUrlState ignores it, and the run quietly
 * produced the tool at its DEFAULTS with exit 0. A pipeline cannot tell that apart from
 * the real document. The two failure modes (no password, wrong password) are named
 * separately so the caller knows which it is.
 *
 * Readable params riding alongside `zx` are re-appended after the decoded state, so
 * on-visit flags still apply — the same rule expandQuery and the web shell follow.
 */
async function decryptLinkQuery(query: string, password: string | undefined, consumesPlainPassword: boolean): Promise<string> {
  const sp = new URLSearchParams(query);
  const token = sp.get(ENC_PARAM) ?? '';
  if (!password) {
    throw new Error(
      'This is a password-protected link (zx=…) and no password was given. ' +
      'Pass --link-password=<password>. Nothing was rendered: without the password the state cannot be read, ' +
      'and rendering the tool at its defaults instead would hand you a different document under the right filename.',
    );
  }
  const decoded = await unpackEncrypted(token, password);
  if (decoded == null) {
    throw new Error(
      'Could not open the password-protected link (zx=…): the password is wrong, or the token is truncated or tampered with. ' +
      'Nothing was rendered: falling back to the tool\'s defaults would hand you a different document under the right filename.',
    );
  }
  const extras: string[] = [];
  sp.forEach((v, k) => {
    if (k === ENC_PARAM) return;
    if (consumesPlainPassword && k === 'password') return;   // it was the LINK password, not a PDF lock
    extras.push(v === '' ? encodeURIComponent(k) : `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  });
  return extras.length ? `${decoded}&${extras.join('&')}` : decoded;
}

// Load a tool, turning a missing tool dir (ENOENT on tool.json) into a clean, THROWN
// error (not a process.exit) — so a batch loop can catch a bad-toolId row, honour
// --keep-going, and still print its summary, while the single-run path's top-level
// catch prints the same message and exits 1 as before. The substituted message hides
// the internal absolute path + errno the raw readFile ENOENT would leak.
async function loadToolOrThrow(toolId: string, fetchFile: (path: string) => Promise<string>, opts: { lang?: Lang } = {}) {
  try {
    return await loadTool(toolId, fetchFile, opts);
  } catch (e) {
    if ((e as { code?: string })?.code === 'ENOENT') {
      throw new Error(`Tool not found: ${toolId}. Run with no args to list tools.`);
    }
    throw e;
  }
}

// Read + parse a --profile=path.json file into a profile object. A missing or
// malformed file is non-fatal: warn and return {} so the render still proceeds.
async function readProfile(profilePath: string | undefined): Promise<Profile> {
  if (!profilePath) return {};
  try {
    const raw = await readFile(resolve(process.cwd(), profilePath), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    process.stderr.write(`Warning: could not load profile "${profilePath}" (${(e as Error).message}); continuing without it.\n`);
    return {};
  }
}

// True when the tool captures a live URL (url-shot) — its export drives Chromium
// straight at the page, bypassing the DOM export path. Mirrors the TUI's isCaptureTool.
function isCaptureTool(manifest: { capabilities?: string[] }): boolean {
  return (manifest.capabilities ?? []).includes('capture');
}

// Infer an export format from an --output filename's extension, but only when it
// names a format the tool actually declares — otherwise return null so the
// caller falls back to formats[0]. (.jpeg normalises to the canonical 'jpg'.)
function formatFromOutput(path: string, formats: string[]): string | null {
  const ext = extname(path).slice(1).toLowerCase();
  if (!ext) return null;
  // Match against the tool's declared formats, tolerating the jpg/jpeg synonym split
  // (some tools declare 'jpeg', others 'jpg'). Prefer the exact declared spelling, so
  // e.g. `--output=x.jpeg` on a tool that declares 'jpeg' picks jpeg (not a silent SVG
  // fallback), and on a tool that declares 'jpg' picks jpg.
  if (formats.includes(ext)) return ext;
  const alias = ext === 'jpeg' ? 'jpg' : ext === 'jpg' ? 'jpeg' : null;
  if (alias && formats.includes(alias)) return alias;
  // The pro float formats are never declared per tool (see the format gate above), so
  // `--output=poster.exr` has to be honoured off the extension alone or it would
  // silently fall back to formats[0] and write an SVG into a .exr file.
  if (DEEP_FORMATS.includes(ext as never)) return ext;
  return null;
}

// Extension → MIME for a file-typed input loaded from disk. The hook can read
// the real bytes; this is the declared type the FileRef carries (best-effort).
function mimeForFile(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.png':  return 'image/png';
    case '.webp': return 'image/webp';
    case '.gif':  return 'image/gif';
    case '.svg':  return 'image/svg+xml';
    case '.heic': return 'image/heic';
    case '.tif': case '.tiff': return 'image/tiff';
    case '.pdf':  return 'application/pdf';
    case '.json': return 'application/json';
    default: return 'application/octet-stream';
  }
}

export async function listToolsCli(): Promise<void> {
  const indexPath = join(REPO_ROOT, 'catalog', 'tools', 'index.json');
  const index = JSON.parse(await readFile(indexPath, 'utf8')) as {
    tools: Array<{ id: string; status: string; name: string; description?: string }>;
  };
  process.stdout.write('Available tools:\n');
  for (const t of index.tools) {
    process.stdout.write(`  ${t.id.padEnd(20)} [${t.status}] ${t.description ?? t.name}\n`);
  }
}

/**
 * List catalog assets — the discovery half of "use the catalog as an input". An
 * `asset`-type input already accepts any of these ids (the engine resolves them), but
 * nothing surfaced the ids; this does. Optional substring query (id/name/tags) and a
 * `--type=` filter (raster/vector/lottie/palette/tokens/font/audio/video).
 */
export async function listAssetsCli(query?: string, opts: { type?: string } = {}): Promise<void> {
  const indexPath = join(REPO_ROOT, 'catalog', 'assets', 'index.json');
  const index = JSON.parse(await readFile(indexPath, 'utf8')) as {
    assets: Array<{ id: string; name?: string; type: string; tags?: string[] }>;
  };
  const q = (query ?? '').trim().toLowerCase();
  const type = opts.type?.trim().toLowerCase();
  const matches = index.assets.filter(a => {
    if (type && a.type.toLowerCase() !== type) return false;
    if (!q) return true;
    const hay = `${a.id} ${a.name ?? ''} ${(a.tags ?? []).join(' ')}`.toLowerCase();
    return hay.includes(q);
  });
  const width = Math.min(48, matches.reduce((w, a) => Math.max(w, a.id.length), 0));
  process.stdout.write(
    `Catalog assets${type ? ` [${type}]` : ''}${q ? ` matching "${query}"` : ''} — ${matches.length} of ${index.assets.length}:\n`,
  );
  for (const a of matches) {
    process.stdout.write(`  ${a.id.padEnd(width)}  ${`(${a.type})`.padEnd(10)} ${a.name ?? ''}\n`);
  }
  process.stdout.write(
    `\nUse any id as an asset input, e.g.  lolly asset-export --src=${matches[0]?.id ?? '<id>'} --export=png\n`,
  );
}

export async function showToolInputsCli(toolId: string, opts: { lang?: Lang } = {}): Promise<void> {
  const fetchFile = async (path: string): Promise<string> => {
    const full = join(REPO_ROOT, 'tools', path);
    return readFile(full, 'utf8');
  };
  const tool = await loadToolOrThrow(toolId, fetchFile, opts);
  process.stdout.write(`${tool.manifest.name} (${tool.manifest.id} v${tool.manifest.version})\n`);
  process.stdout.write(`Status: ${tool.manifest.status}\n`);
  process.stdout.write(`Formats: ${tool.manifest.render.formats.join(', ')}\n\n`);
  process.stdout.write(`Inputs:\n`);
  for (const i of tool.manifest.inputs) {
    const req = i.required ? ' [required]' : '';
    const def = i.default !== undefined ? ` (default: ${JSON.stringify(i.default)})` : '';
    process.stdout.write(`  --${i.id}=<${i.type}>${req}${def}\n`);
    if (i.help) process.stdout.write(`      ${i.help}\n`);
    const hint = syntaxHint(i.id, i.type);
    if (hint) process.stdout.write(`      ↳ ${hint}\n`);
  }
  process.stdout.write(`\nUsage:\n  lolly ${tool.manifest.id} --some-input=value --output=file.${tool.manifest.render.formats[0]}\n`);
}

/** URL-mode syntax hint for the non-scalar input types, so the CLI's `<tool>` help
 *  explains how to actually express them (the forms are otherwise undocumented). */
function syntaxHint(id: string, type: string): string {
  switch (type) {
    case 'asset':   return 'a catalog id (see `lolly assets`), a local image file, or a lolly.tools tool URL';
    case 'blocks':  return `a JSON array --${id}='[{…}]', tilde rows --${id}='label,val,#hex~…', or a data file --${id}-data=rows.csv`;
    case 'vector':  return `one flag per field, e.g. --${id}.<field>=<number>`;
    case 'file':    return 'a path to your file (read locally, never uploaded)';
    case 'color':   return '#RRGGBB (the # is optional) or a token path';
    case 'boolean': return `bare --${id} = true; --${id}=false to unset`;
    default:        return '';
  }
}
