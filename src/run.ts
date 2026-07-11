// SPDX-License-Identifier: MPL-2.0
/**
 * CLI runner — the working implementation.
 *
 * Loads a tool from disk, runs the engine against a jsdom DOM, and writes the
 * exported file. This is the SAME engine path the web shell uses; only the
 * host bridge implementation differs. That's the URL-mode-as-CLI principle —
 * CLI is just a different transport, not a different render engine.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname, resolve, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadTool, createRuntime, parseUrlState, expandQuery, embedC2pa, summarizeInputs, C2PA_FORMATS, ENGINE_VERSION, normalizeLang } from '@lolly/engine';
import type { Lang } from '@lolly/engine';

// Formats the DOM-free engine writes on its own (svg/emf/eps + text/data). Everything
// else — raster, pdf, video — is produced by raster.ts (resvg fast path, else the scoped
// Chromium). Kept in sync with shells/tui/src/engine-render.ts NODE_FORMATS.
const NODE_FORMATS = ['svg', 'emf', 'eps', 'eps-cmyk', 'html', 'json', 'csv', 'ics', 'vcf', 'txt', 'md'];
import { createCliBridge, applyBrandVars } from './bridge.ts';
import type { Profile, ExportOpts } from '../../../engine/src/bridge/host-v1.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

interface RunToolCliArgs {
  toolId: string;
  params: Record<string, string>;
  outputPath?: string;
  format?: string;
}

export async function runToolCli({ toolId, params, outputPath, format }: RunToolCliArgs): Promise<void> {
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
  const host = await createCliBridge({ dom, profile });

  // Expand a packed `z=…` param back into a plain query first — the CLI is URL mode
  // under a different transport, so a packed share link must run identically here
  // (`lolly layout-studio --z=1eJ…`). A no-op for ordinary readable params.
  const query = await expandQuery(new URLSearchParams(params).toString());
  const { values, format: paramFormat, width, height, unit, dpi, password, c2pa } = parseUrlState(
    query,
    tool.manifest,
  );

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

  // Engine-native / data formats (svg/emf/eps + html/json/csv/ics/vcf) render DOM-free
  // through the bridge. Raster/PDF/video route to raster.ts: Tier A (resvg, no browser)
  // for PNG from an SVG-native tool, else Tier B (the scoped Chromium driving the built
  // web shell). `usedBrowser` tells us to tear the browser + server down before exit.
  let buf: Buffer;
  let usedBrowser = false;
  if (NODE_FORMATS.includes(targetFormat.toLowerCase())) {
    const blob = await runtime.export(canvas, targetFormat, exportOpts);
    buf = Buffer.from(await blob.arrayBuffer());
  } else {
    const { renderRaster } = await import('./raster.ts');
    const res = await renderRaster({
      runtime, dom, manifest: tool.manifest, format: targetFormat,
      dims: { width: width ?? undefined, height: height ?? undefined, unit: unit ?? undefined, dpi: dpi ?? undefined, ...(password ? { password } : {}) },
    });
    buf = Buffer.from(res.bytes);
    usedBrowser = res.usedBrowser;
  }

  // --c2pa[=7|30|90|365] stamps Content Credentials into the finished bytes —
  // URL mode's `c2pa` param under the CLI transport (same last-byte-operation
  // rule as the web shell's stampC2pa). Applies to any C2PA-capable format the
  // CLI now produces (svg via the engine; png/jpg/pdf via the raster tiers);
  // off/unsupported is a clear warn-and-continue, mirroring the web shell's
  // never-fail-the-export policy. Ephemeral on-device signing only — verifiers
  // report it unverified; the enrolled-identity path is a browser feature (see
  // docs/content-credentials-identity.md).
  if (c2pa?.on && C2PA_FORMATS.includes(targetFormat)) {
    if (targetFormat === 'pdf' && password) {
      process.stderr.write('Warning: password-locked export — skipping Content Credentials (an encrypted document cannot take the C2PA update).\n');
    } else {
      try {
        const days = c2pa.days ?? 30;
        // The "what was this made from / where / when / how big" record, matching
        // the web shell's tools.lolly.export enrichment: export context + date +
        // output size + the scalar-input digest, so a CLI-made asset inspects as
        // richly as a browser-made one.
        const inputs = summarizeInputs(runtime.getModel());
        const sizeLine = (typeof width === 'number' && width > 0 && typeof height === 'number' && height > 0)
          ? (u !== 'px' ? `${width} × ${height} ${u} @ ${dpi || 300} DPI` : `${width} × ${height} px`)
          : undefined;
        const stamped = await embedC2pa(new Uint8Array(buf), targetFormat, {
          title: tool.manifest.name,
          claimGenerator: 'Lolly lolly.tools',
          generatorInfo: { name: 'Lolly', version: ENGINE_VERSION },
          environment: {
            surface: 'cli', engine: `node ${process.version}`, os: process.platform,
            format: targetFormat, tool: tool.manifest.name || toolId,
            date: new Date().toISOString(),
            ...(sizeLine ? { dimensions: sizeLine } : {}),
            ...(Object.keys(inputs).length ? { inputs } : {}),
          },
          ...(profile.useDetails === true && profile.firstname
            ? { author: { name: [profile.firstname, profile.lastname].filter(Boolean).join(' '), ...(profile.email ? { email: profile.email } : {}) } }
            : {}),
          dates: { notBefore: new Date(Date.now() - 60_000), notAfter: new Date(Date.now() + days * 86_400_000) },
        });
        buf = Buffer.from(stamped.buffer as ArrayBuffer, stamped.byteOffset, stamped.byteLength);
      } catch (e) {
        process.stderr.write(`Warning: Content Credentials not attached — ${(e as Error).message}\n`);
      }
    }
  } else if (c2pa?.on) {
    process.stderr.write(`Warning: format "${targetFormat}" has no C2PA container — Content Credentials skipped.\n`);
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
      import('./browser.ts'), import('./webshell-render.ts'),
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

// Infer an export format from an --output filename's extension, but only when it
// names a format the tool actually declares — otherwise return null so the
// caller falls back to formats[0]. (.jpeg normalises to the canonical 'jpg'.)
function formatFromOutput(path: string, formats: string[]): string | null {
  const ext = extname(path).slice(1).toLowerCase();
  if (!ext) return null;
  const norm = ext === 'jpeg' ? 'jpg' : ext;
  return formats.includes(norm) ? norm : null;
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
    case 'asset':   return 'a catalog id (see `lolly assets`) or a lolly.tools tool URL';
    case 'blocks':  return `a JSON array --${id}='[{…}]', or tilde rows --${id}='label,val,#hex~label2,val2'`;
    case 'vector':  return `one flag per field, e.g. --${id}.<field>=<number>`;
    case 'file':    return 'a path to your file (read locally, never uploaded)';
    case 'color':   return '#RRGGBB (the # is optional) or a token path';
    case 'boolean': return `bare --${id} = true; --${id}=false to unset`;
    default:        return '';
  }
}
