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

import { loadTool, createRuntime, parseUrlState, serializeUrlState, expandQuery, embedC2pa, C2PA_FORMATS, normalizeLang, parseDataRows } from '@lolly/engine';
import type { Lang } from '@lolly/engine';
// NODE_FORMATS: the DOM-free/raster format split, shared with the TUI. Everything not
// in it — raster, pdf, video — is produced by raster.ts (resvg fast path, else the
// scoped Chromium).
import { NODE_FORMATS, pxDims } from '@lolly-tools/node-shell/raster';
import { buildExportC2paOpts } from '@lolly-tools/node-shell/c2pa-opts';
import { repoRoot } from '@lolly-tools/node-shell/repo-root';
// Fail loud: never write a degenerate file + exit 0 when the render silently failed.
import { assertRenderOk } from '@lolly-tools/node-shell/render-integrity';
// url-shot: capture a live page via the scoped Chromium (shared with the TUI).
import { captureUrl, captureParamsFrom } from '@lolly-tools/node-shell/url-capture';
import { createCliBridge, applyBrandVars } from './bridge.ts';
import type { Profile, ExportOpts } from '../../../engine/src/bridge/host-v1.ts';

const REPO_ROOT = repoRoot();

interface RunToolCliArgs {
  toolId: string;
  params: Record<string, string>;
  outputPath?: string;
  format?: string;
  /** --share/--link: print a shareable lolly.tools URL for the inputs instead of rendering. */
  share?: boolean;
}

export async function runToolCli({ toolId, params, outputPath, format, share }: RunToolCliArgs): Promise<void> {
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

  // Expand a packed `z=…` param back into a plain query first — the CLI is URL mode
  // under a different transport, so a packed share link must run identically here
  // (`lolly layout-studio --z=1eJ…`). A no-op for ordinary readable params.
  const query = await expandQuery(new URLSearchParams(params).toString());
  const { values, format: paramFormat, width, height, unit, dpi, password, c2pa, bleed, imprint } = parseUrlState(
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
    const { bytes, filename } = await runtime.exportFile();
    const buf = Buffer.from((bytes as { buffer?: ArrayBufferLike }).buffer ?? (bytes as ArrayBuffer));
    const dest = outputPath || (filename ? resolve(process.cwd(), filename) : null);
    if (dest) {
      await writeFile(dest, buf);
      // One-line result summary (input→output delta + the tool's a11y summary) so the
      // headless path reports what a transform did, not just a byte count. Matches the
      // TUI's utility result panel.
      const fileInput = (tool.manifest.inputs ?? []).find(i => i.type === 'file');
      const inBytes = fileInput ? (values[fileInput.id] as { size?: number } | undefined)?.size : undefined;
      const label = runtime.getHydratedString(tool.manifest.a11yLabel).trim();
      const delta = typeof inBytes === 'number' ? `${inBytes.toLocaleString()} → ${buf.length.toLocaleString()} bytes` : `${buf.length.toLocaleString()} bytes`;
      process.stderr.write(`✓ ${label ? label + ' — ' : ''}${delta} → ${dest}\n`);
    } else {
      process.stdout.write(buf);
    }
    return;
  }

  // Format resolution mirrors URL mode: an explicit flag wins (--export= arrives
  // as `format`, --format= as `paramFormat`); otherwise infer it from the
  // --output extension; otherwise fall back to the tool's first declared format.
  const targetFormat =
    format ?? paramFormat ??
    (outputPath ? formatFromOutput(outputPath, tool.manifest.render.formats) : null) ??
    tool.manifest.render.formats[0]!;

  if (!tool.manifest.render.formats.includes(targetFormat)) {
    throw new Error(
      `Tool "${toolId}" does not support format "${targetFormat}". ` +
      `Supported: ${tool.manifest.render.formats.join(', ')}`,
    );
  }

  const runtime = await createRuntime(tool, host, values);

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
    const exportOpts: ExportOpts & { password?: string } = { width: qual(width), height: qual(height) };
    if (u !== 'px') exportOpts.dpi = dpi || 300;
    // --password= sets the standard PDF's open-password (basic lock).
    if (targetFormat === 'pdf' && password) exportOpts.password = password;

    try {
      // Engine-native / data formats (svg/emf/eps/dxf + html/json/csv/ics/vcf) render DOM-free
      // through the bridge. Raster/PDF/video route to raster.ts: Tier A (resvg, no browser)
      // for PNG from an SVG-native tool, else Tier B (the scoped Chromium driving the built
      // web shell). `usedBrowser` tells us to tear the browser + server down before exit.
      if (NODE_FORMATS.includes(targetFormat.toLowerCase())) {
        const blob = await runtime.export(canvas, targetFormat, exportOpts);
        buf = Buffer.from(await blob.arrayBuffer());
        // The DOM-free render is this runtime's own output — a swallowed onInit failure
        // (e.g. an unavailable capability) yields an empty file. Refuse to write it.
        assertRenderOk({ hookErrors: runtime.hookErrors, format: targetFormat, bytes: buf });
      } else {
        const { renderRaster } = await import('./raster.ts');
        const res = await renderRaster({
          runtime, dom, manifest: tool.manifest, format: targetFormat,
          dims: {
            width: width ?? undefined, height: height ?? undefined, unit: unit ?? undefined, dpi: dpi ?? undefined,
            ...(password ? { password } : {}),
            ...(bleed ? { bleed } : {}),
            ...(marksRaw ? { marks: marksRaw } : {}),
            ...(imprint ? { imprint: true } : {}),
            ...(pressProfile ? { pressProfile } : {}),
            // Forward the c2pa setting so the browser tier stamps it (single authority); the
            // Node post-stamp below is skipped when the browser ran, avoiding a double-stamp.
            ...(c2pa != null ? { c2pa: c2pa.on, c2paDays: c2pa.days ?? undefined } : {}),
          },
        });
        buf = Buffer.from(res.bytes);
        usedBrowser = res.usedBrowser;
        webShellExport = res.usedBrowser; // Tier B == the web shell; it owns c2pa for that path
        // Tier A (resvg) rasterises THIS runtime's own SVG, so a swallowed hook failure
        // yields a blank raster — gate it. Tier B re-renders in a real browser whose host
        // has the capability, so hookErrors don't describe those bytes; renderViaWebShell
        // already throws if the browser produced nothing.
        if (!usedBrowser) assertRenderOk({ hookErrors: runtime.hookErrors, format: targetFormat, bytes: buf });
      }
    } catch (e) {
      // HTML-layout tools have no <svg> (svg/emf/eps/dxf throw), and Tier-B formats need a
      // browser + a built web shell. When either is unavailable, fall back to writing HTML
      // so an export ALWAYS yields an artifact — the exact graceful fallback the TUI ships.
      // A genuine render failure (RenderIntegrityError: "render produced no usable output")
      // does NOT match this signature, so it correctly rethrows and fails loud.
      const msg = (e as Error).message;
      if (finalFormat !== 'html' && /<svg>|requires an|browser engine|needs a browser|no built web shell|chromium/i.test(msg)) {
        const blob = await runtime.export(canvas, 'html', {});
        buf = Buffer.from(await blob.arrayBuffer());
        assertRenderOk({ hookErrors: runtime.hookErrors, format: 'html', bytes: buf });
        finalFormat = 'html';
        webShellExport = false;
        // Retarget --output to a .html name so the file's extension matches its content.
        if (outputPath) outputPath = outputPath.replace(/\.[^./\\]+$/, '') + '.html';
        process.stderr.write(`Note: "${targetFormat}" needs a browser engine here — wrote HTML instead (${msg.split('\n')[0]}).\n`);
      } else {
        throw e;
      }
    }
  }

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
