// SPDX-License-Identifier: MPL-2.0
/**
 * CLI implementation of the v1 capability bridge.
 *
 * The CLI runs in Node with a jsdom DOM. Storage is in-memory only (each
 * CLI invocation is ephemeral). Assets are read from the catalog on disk.
 *
 * The point of this file is to demonstrate that the SAME engine, hooks, and
 * tools work against a completely different bridge implementation. No tool
 * changes were needed.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDimension, toCssLength, toCssPx, loadTool, createRuntime, emitEmf, emitEps, emitDxf, parseToolUrl, buildEmbedUrl, parseUrlState, expandQuery, RESERVED, assertComposeStack, parseThemedAssetId, applyIconTheme, parseIconThemesDoc, parseTreatedAssetId, parsePhotoTreatmentsDoc, wrapRasterWithTreatment, createTokenSet, colorToHex, isAlias, makeColorApi } from '@lolly/engine';
import type {
  HostV1, Profile, AssetsAPI, AssetRef, AssetQuery, ExportOpts, ExportMeta,
  StateEntry, ComposeSpec, ComposeUrlOpts, ExportFormat, TokenSet,
} from '../../../engine/src/bridge/host-v1.ts';
// PDF metadata inspect/strip is pure pdf-lib (no DOM), so the lean node CLI
// shares the web shell's implementation rather than duplicating it.
import { createPdfAPI } from '../../web/src/bridge/pdf.ts';
// PPTX inspect/rebrand is engine primitives + fflate (plain JS) with the XML
// parser injected, so the CLI shares the web impl and supplies jsdom's DOMParser.
import { createPptxAPI } from '../../web/src/bridge/pptx.ts';
// host.net allowlisted fetch is DOM-free too (global fetch + TransformStream, both
// Node ≥18 globals), so the CLI shares the web module verbatim — the prefix-match
// rules and the 64 MB counting-stream cap can never drift between shells.
import { createNetAPI } from '../../web/src/bridge/net.ts';
// SVG→EMF IR walk is DOM-light (attribute reads), so it runs under jsdom for
// native-SVG tools — the same "no layout engine" constraint as the svg branch.
import { svgDomToIr } from '../../web/src/bridge/svg-ir.ts';

// Repo root holding catalog/ — the shared resolver (LOLLY_ROOT → marker walk → cwd;
// see packages/node-shell/src/repo-root.ts for why a fixed `../../..` can't work in
// the bundled Vercel function). RELATIVE import on purpose: this file is inlined into
// that function by scripts/build-mcp-fn.ts, whose esbuild config leaves bare package
// specifiers external — a `@lolly-tools/node-shell` import would dangle in the bundle.
import { repoRoot } from '../../../packages/node-shell/src/repo-root.ts';
// host.text (HarfBuzz text-to-path). RELATIVE for the same reason as repo-root above —
// this file is inlined into the Vercel MCP function, where a bare @lolly-tools/node-shell
// specifier would dangle. Lazily loads its WASM on first shape, so attaching it is free.
import { createNodeTextAPI } from '../../../packages/node-shell/src/text.ts';
// url-shot page capture (scoped Chromium). RELATIVE for the MCP bundle; its browser is
// lazy-loaded, so importing it costs nothing until a capture actually runs.
import { captureUrl } from '../../../packages/node-shell/src/url-capture.ts';
const REPO_ROOT = repoRoot();

/** One format entry inside a catalog asset record (catalog/assets/index.json). */
interface CatalogAssetFormat {
  format: string;
  url: string;
  checksum?: string;
  width?: number;
  height?: number;
}

/** A catalog asset record — the shape validate-catalog.js guarantees on disk. */
interface CatalogAsset {
  id: string;
  name?: string;
  type: AssetRef['type'];
  version?: string;
  tags?: string[];
  deprecated?: boolean;
  formats: CatalogAssetFormat[];
}

/** The CLI's private extensions to AssetsAPI — stubs mirroring the web shell's
 *  user-image surface (see below); never part of the public HostV1 contract. */
interface CliAssetsAPI extends AssetsAPI {
  _listUserAssets(): Promise<unknown[]>;
  _userAssetsCount(): Promise<number>;
  _userAssetsSize(): Promise<number>;
  _deleteUserAsset(id?: string): Promise<void>;
}

/** The concrete host the CLI builds: HostV1 plus the private assets stubs. */
type CliHost = HostV1 & { assets: CliAssetsAPI };

/** Options `host.export.render` reads beyond ExportOpts: the engine-hydrated
 *  data/text payload and the physical-unit qualifier threaded to the emitters. */
interface CliExportRenderOpts extends ExportOpts {
  dataText?: string;
  dataMime?: string;
  unit?: string;
}

/** Element type of parseIconThemesDoc's result — derived so no engine-internal
 *  type name has to be imported. */
type IconThemeDef = ReturnType<typeof parseIconThemesDoc>[number];

interface CliBridgeOpts {
  profile?: Profile;
  dom: { window: Window & typeof globalThis };
  /** The loaded manifest's `network.allowlist` — what host.net may fetch this
   *  run. Absent/empty ⇒ every host.net fetch rejects (same as the web shell). */
  networkAllowlist?: readonly string[];
}

export async function createCliBridge(
  { profile = {}, dom, networkAllowlist }: CliBridgeOpts = {} as CliBridgeOpts,
): Promise<HostV1> {
  const w = dom.window;
  // Pre-load the asset catalog so query/get can be synchronous-ish.
  const assetCatalogPath = join(REPO_ROOT, 'catalog', 'assets', 'index.json');
  const assetIndex = JSON.parse(await readFile(assetCatalogPath, 'utf8')) as { assets: CatalogAsset[] };
  const assetById = new Map<string, CatalogAsset>(assetIndex.assets.map((a): [string, CatalogAsset] => [a.id, a]));

  const state = new Map<string, { data: object; updatedAt: string }>();

  const host = {
    version: '1',
    shell: 'cli',
    log: (level: 'debug' | 'info' | 'warn' | 'error', msg: string, ctx?: object): void => {
      const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
      out.write(`[${level}] ${msg}${ctx ? ' ' + JSON.stringify(ctx) : ''}\n`);
    },
  } as CliHost;

  host.profile = {
    async get() { return profile; },
    subscribe() { return () => {}; },
  };

  // Colour pairings for themable two-colour icons, from the catalog's palette
  // asset tagged "icon-themes". The in-flight promise is cached so N themed
  // refs resolving in parallel share one read per CLI invocation.
  let iconThemesCache: Promise<IconThemeDef[]> | null = null;
  function iconThemes(): Promise<IconThemeDef[]> {
    iconThemesCache ??= (async () => {
      const pal = [...assetById.values()].find(a => a.type === 'palette' && a.tags?.includes('icon-themes'));
      if (!pal) return [];
      const doc = JSON.parse(await readFile(join(REPO_ROOT, pal.formats[0]!.url.replace(/^\//, '')), 'utf8'));
      return parseIconThemesDoc(doc);
    })().catch(() => []); // unavailable ≠ broken: icons just stay default
    return iconThemesCache;
  }

  // Colour treatments for raster photos, from the catalog's palette asset tagged
  // "photo-treatments" — the raster analogue of iconThemes() above.
  let photoTreatmentsCache: Promise<ReturnType<typeof parsePhotoTreatmentsDoc>> | null = null;
  function photoTreatments(): Promise<ReturnType<typeof parsePhotoTreatmentsDoc>> {
    photoTreatmentsCache ??= (async () => {
      const pal = [...assetById.values()].find(a => a.type === 'palette' && a.tags?.includes('photo-treatments'));
      if (!pal) return [];
      const doc = JSON.parse(await readFile(join(REPO_ROOT, pal.formats[0]!.url.replace(/^\//, '')), 'utf8'));
      return parsePhotoTreatmentsDoc(doc);
    })().catch(() => []); // unavailable ≠ broken: photos just stay untreated
    return photoTreatmentsCache;
  }

  // Design tokens — the catalog's FIRST `type:'tokens'` asset (the same
  // brand-agnostic discovery rule as the web bridge and the MCP tokens
  // resource), read from disk and resolved by the engine per theme. Missing or
  // unreadable → an empty set: token-bound colour inputs fall back to their
  // cached hex and the semantic brand vars (applyBrandVars below) stay unset.
  let tokensDocCache: Promise<unknown> | null = null;
  function tokensDoc(): Promise<unknown> {
    tokensDocCache ??= (async () => {
      const asset = assetIndex.assets.find(a => a.type === 'tokens');
      if (!asset) return null;
      return JSON.parse(await readFile(join(REPO_ROOT, asset.formats[0]!.url.replace(/^\//, '')), 'utf8'));
    })().catch(() => null); // unavailable ≠ broken: everything token-y just degrades
    return tokensDocCache;
  }
  const tokenSets = new Map<string, TokenSet>(); // theme key ('' = default) → resolved set
  async function tokenSet(theme?: string): Promise<TokenSet> {
    const key = theme ?? '';
    let set = tokenSets.get(key);
    if (!set) { set = createTokenSet(await tokensDoc(), { theme }); tokenSets.set(key, set); }
    return set;
  }
  host.tokens = {
    get: (opts = {}) => tokenSet(opts.theme),
    colors: async (opts = {}) => (await tokenSet(opts.theme)).colors(),
    resolve: async (ref, opts = {}) => (await tokenSet(opts.theme)).resolve(ref),
    themes: async () => (await tokenSet()).themes(),
  };

  // Perceptual colour tools (v1.40) — pure engine math, attached verbatim
  // (same object the web bridge attaches, so shells can never drift).
  host.color = makeColorApi();

  // host.text — text-to-path (HarfBuzz WASM), the SAME shaping the web shell uses, so a
  // tool that outlines text via host.text renders identically in the terminal. Without
  // it, brand-lockup (and any host.text-in-hooks tool) throws in onInit and emits an
  // empty SVG. Fonts resolve off disk under the repo root (see text.ts). Node-only fonts
  // are all sfnt; the WASM loads lazily on first shape.
  host.text = createNodeTextAPI({ repoRoot: REPO_ROOT });

  // host.net — allowlisted fetch for tools that declared the 'network' capability,
  // built per-invocation from the loaded manifest's network.allowlist (callers thread
  // it in via CliBridgeOpts). Deny happens before any I/O, so an empty/absent allowlist
  // means the API exists but every fetch rejects — identical fail-closed stance to web.
  host.net = createNetAPI({ allowlist: networkAllowlist });

  host.assets = {
    async get(id) {
      // A presentation modifier can ride in the id, baked in at resolve time
      // (same contract as the web bridge). An id carries at most one:
      //   `<baseId>?theme=<themeId>`  — themable two-colour icon pairing
      //   `<baseId>?treatment=<id>`   — raster photo colour treatment
      const { baseId: themedBase, theme } = parseThemedAssetId(id);
      const { baseId: treatedBase, treatment } = parseTreatedAssetId(id);
      const baseId = theme ? themedBase : treatedBase;
      const meta = assetById.get(baseId);
      if (!meta) throw new Error(`Asset not in catalog: ${baseId}`);
      // Lottie entries list the animation (json) plus a static poster variant;
      // tools always want the animation regardless of listing order (mirrors the
      // web bridge's pickFormat).
      const fmt = meta.type === 'lottie'
        ? (meta.formats.find(f => f.format === 'json') ?? meta.formats[0]!)
        : meta.formats[0]!;
      const localPath = join(REPO_ROOT, fmt.url.replace(/^\//, ''));
      let buf = await readFile(localPath);
      // For palette JSON, embed swatches in meta for templates to use.
      let extraMeta: Record<string, unknown> = { name: meta.name, tags: meta.tags };
      if (meta.type === 'palette' && fmt.format === 'json') {
        try {
          const parsed = JSON.parse(buf.toString('utf8'));
          extraMeta = { ...extraMeta, ...parsed };
        } catch {}
      }
      if (theme) {
        const def = (await iconThemes()).find(t => t.id === theme);
        const baked = def ? applyIconTheme(buf.toString('utf8'), def) : null;
        if (baked) {
          buf = Buffer.from(baked, 'utf8');
          extraMeta = { ...extraMeta, theme, baseId };
        }
        // Unknown theme / non-themable file → plain bytes under the requested
        // id (kept so a temporarily unresolvable theme isn't stripped from
        // persisted state — same contract as the web bridge).
      }
      if (treatment && meta.type === 'raster') {
        const def = (await photoTreatments()).find(t => t.id === treatment);
        // Fall back to a sibling format's dims when the primary format omits them
        // (jpg entries usually do) — otherwise the bake no-ops and the untreated
        // photo is served. Same reasoning as the web bridge.
        const dimSrc = (fmt.width && fmt.height) ? fmt : meta.formats.find(f => f.width && f.height);
        const w = dimSrc?.width, h = dimSrc?.height;
        if (def && w && h) {
          const href = `data:${mimeFor(fmt.format)};base64,${buf.toString('base64')}`;
          const svg = wrapRasterWithTreatment({ href, width: w, height: h, treatment: def });
          return {
            source: 'library',
            id,
            type: meta.type,
            format: fmt.format,
            url: `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`,
            version: meta.version,
            checksum: fmt.checksum,
            meta: { ...extraMeta, treatment, baseId },
          };
        }
        // Unknown/invalid treatment or missing dimensions → plain bytes.
      }
      // jsdom doesn't have URL.createObjectURL by default; encode as data URL.
      const mime = mimeFor(fmt.format);
      const url = `data:${mime};base64,${buf.toString('base64')}`;
      return {
        source: 'library',
        id,
        type: meta.type,
        format: fmt.format,
        url,
        version: meta.version,
        checksum: fmt.checksum,
        meta: extraMeta,
      };
    },
    async query(filter = {}) {
      return Array.from(assetById.values())
        .filter(m => matchesFilter(m, filter))
        .map((m): AssetRef => ({
          source: 'library',
          id: m.id,
          type: m.type,
          format: m.formats[0]?.format ?? 'svg',
          url: '',
          version: m.version,
          meta: { name: m.name, tags: m.tags, _placeholder: true },
        }));
    },
    async pick() {
      throw new Error('Asset picker not available in CLI mode — list ids with `lolly assets [query]` and pass one to the asset input (e.g. --logo=suse/logo/hor-pos-green)');
    },
    async isAvailable(id) {
      return assetById.has(parseThemedAssetId(id).baseId);
    },

    // The user-image library (device upload → downscale → IndexedDB) is a GUI
    // concern. The CLI is ephemeral and headless, so it has no user images —
    // these stubs keep the internal surface consistent with the web bridge.
    async _listUserAssets() { return []; },
    async _userAssetsCount() { return 0; },
    async _userAssetsSize() { return 0; },
    async _deleteUserAsset() { /* no-op: no user images in CLI */ },
  };

  host.state = {
    async save(slot, data) { state.set(slot, { data, updatedAt: new Date().toISOString() }); },
    async load(slot) { return state.get(slot)?.data ?? null; },
    async list() { return Array.from(state.keys()).map(slot => ({ slot })) as StateEntry[]; },
    async delete(slot) { state.delete(slot); },
  };

  host.clipboard = {
    async writeText() { throw new Error('Clipboard unavailable in CLI; use --output instead'); },
    async writeImage() { throw new Error('Clipboard unavailable in CLI; use --output instead'); },
  };

  // CLI export covers everything producible without a layout/paint engine:
  //   • text / data — html, svg, json, csv, ics, vcf (the engine hydrates these)
  // Raster (png/jpg/webp/avif/ico), pdf/pdf-cmyk, zip and video need a real
  // browser engine (jsdom has no layout), so they're produced by the web shell
  // or the Tauri-bundled CLI (which ships a WebView) — a deliberate decision, not
  // a TODO: the node CLI stays dependency-light rather than bundling Chromium.
  host.export = {
    async render(node: Element, format: string, opts: CliExportRenderOpts = {}): Promise<Blob> {
      // Data/text formats: the engine already hydrated the payload (JSON from the
      // model, ICS/VCF/CSV from a sibling text template). The host just wraps it.
      if (opts.dataText !== undefined) {
        return new Blob([opts.dataText], { type: opts.dataMime ?? 'text/plain' });
      }
      if (format === 'html') {
        return new Blob([node.outerHTML], { type: 'text/html' });
      }
      if (format === 'svg') {
        const svg = node.querySelector('svg') ?? node;
        if (svg.tagName.toLowerCase() !== 'svg') {
          throw new Error('SVG export requires an <svg> in the template');
        }
        // Honour requested dimensions (incl. physical units like "210mm"): set
        // width/height in the unit and ensure a px viewBox so it scales.
        const dw = parseDimension(opts.width);
        const dh = parseDimension(opts.height);
        if (dw || dh) {
          if (!svg.getAttribute('viewBox')) {
            const vw = dw ? toCssPx(dw) : (parseFloat(svg.getAttribute('width') as string) || 0);
            const vh = dh ? toCssPx(dh) : (parseFloat(svg.getAttribute('height') as string) || 0);
            if (vw && vh) svg.setAttribute('viewBox', `0 0 ${vw} ${vh}`);
          }
          if (dw) svg.setAttribute('width', toCssLength(dw));
          if (dh) svg.setAttribute('height', toCssLength(dh));
        }
        const raw = w.XMLSerializer
          ? new w.XMLSerializer().serializeToString(svg)
          : svg.outerHTML;
        const xml = injectSvgMeta(raw, opts.meta); // embed authorship provenance
        return new Blob(['<?xml version="1.0" standalone="no"?>\n' + xml], { type: 'image/svg+xml' });
      }
      if (format === 'emf') {
        // EMF is pure bytes built from SVG primitives — no rasteriser needed, so
        // it joins svg as a CLI-native format for native-<svg> tools. Text must
        // already be outlined: the lean CLI has no host.text, so svgDomToIr throws
        // on any live <text> (the always-text-as-paths guard surfaced as an error).
        const svg = node.querySelector('svg') ?? (node.tagName?.toLowerCase() === 'svg' ? node : null);
        if (!svg) throw new Error('EMF export requires an <svg> in the template (HTML-layout tools need a browser engine — use the desktop app)');
        const ir = await svgDomToIr(svg, { host, background: opts.background });
        const bytes = emitEmf(ir, { width: opts.width, height: opts.height, unit: opts.unit, dpi: opts.dpi });
        return new Blob([bytes as BlobPart], { type: 'image/emf' });
      }
      if (format === 'eps' || format === 'eps-cmyk') {
        // EPS is vector PostScript built from the same SVG IR as EMF — text is
        // outlined upstream (svgDomToIr throws on live <text>, as the lean CLI
        // has no host.text), so the emitter writes no fonts. eps-cmyk is naive
        // DeviceCMYK (no embedded output intent), same as the web shell.
        const svg = node.querySelector('svg') ?? (node.tagName?.toLowerCase() === 'svg' ? node : null);
        if (!svg) throw new Error('EPS export requires an <svg> in the template (HTML-layout tools need a browser engine — use the desktop app)');
        const ir = await svgDomToIr(svg, { host, background: opts.background, label: 'EPS' });
        const text = emitEps(ir, { width: opts.width, height: opts.height, unit: opts.unit, dpi: opts.dpi, cmyk: format === 'eps-cmyk', meta: opts.meta as { title?: string } | undefined });
        return new Blob([text], { type: 'application/postscript' });
      }
      if (format === 'dxf') {
        // DXF is the same SVG-IR path as EMF/EPS — a fourth sink on svgDomToIr, so a
        // native-<svg> tool exports vector CAD DXF browser-free (no 150MB Chromium for
        // what is fundamentally text). Text is outlined upstream (host.text present).
        const svg = node.querySelector('svg') ?? (node.tagName?.toLowerCase() === 'svg' ? node : null);
        if (!svg) throw new Error('DXF export requires an <svg> in the template (HTML-layout tools need a browser engine — use the desktop app)');
        const ir = await svgDomToIr(svg, { host, background: opts.background, label: 'DXF' });
        const { text } = emitDxf(ir, { width: opts.width, height: opts.height, unit: opts.unit, dpi: opts.dpi });
        return new Blob([text], { type: 'image/vnd.dxf' });
      }
      throw new Error(`CLI shell does not support format "${format}" (needs a browser engine). Use a text/data format (html, svg, emf, eps, dxf, json, csv, ics, vcf), or run the Tauri-bundled CLI for raster/pdf/zip.`);
    },
    async download() {
      throw new Error('CLI cannot trigger a browser download — pipe the blob to a file via --output');
    },
    // Transform-path delivery has no browser download in the CLI; the runner
    // (run.js) writes the exportFile bytes to --output / stdout directly. This
    // stub keeps the bridge surface complete and fails clearly if a hook calls it.
    async file() {
      throw new Error('CLI delivers transformed files via --output (run.js writes the bytes), not host.export.file');
    },
  };

  // Page capture — navigate a URL in the scoped Chromium and read back its pixels. The
  // CLI ships the same browsers.ts as the TUI, so this is now real (not a stub): a tool
  // that calls host.capture.page in a hook works when a browser is installed, and gets a
  // clear, actionable BrowserError (`lolly install-browser`) when it isn't. Mirrors the
  // TUI bridge. (url-shot's EXPORT is routed straight to captureUrl in run.ts, bypassing
  // this — but this fulfils the 'capture' capability for the hook + non-CLI callers.)
  host.capture = {
    async page(spec) {
      const { bytes, mime } = await captureUrl(
        {
          url: spec.url, scrollDepth: spec.scrollDepth ?? 0, waitMs: spec.waitMs ?? 500,
          css: spec.css ?? '',
          cropLeft: spec.crop?.left ?? 0, cropRight: spec.crop?.right ?? 0,
          cropTop: spec.crop?.top ?? 0, cropBottom: spec.crop?.bottom ?? 0,
          recolor: 'none', tintColor: '#111111', hue: 0,   // recolor 'none' ⇒ tint unused
          zoom: 1,                                          // zoom rides in spec.css (html{zoom:…})
        },
        'png',
        { width: spec.width, height: spec.height ?? spec.width, dpi: (spec.dpr ?? 1) * 96 },
      );
      const url = `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
      return { source: 'remote', id: `capture:${spec.url}`, type: 'raster', format: 'png', url, width: spec.width, height: spec.height };
    },
  };

  // PDF metadata inspect + strip. Unlike raster/PDF *rendering* (which needs a
  // browser engine), metadata surgery is pure pdf-lib, which runs fine in node —
  // so the lean CLI can clean PDFs too.
  host.pdf = createPdfAPI();

  // PPTX deck inspect + rebrand. The web impl already isolates its two host
  // dependencies (fflate zip codec, injectable XML parser), so the CLI reuses
  // it wholesale — jsdom's DOMParser stands in for the browser's.
  host.pptx = createPptxAPI({ parseXml: (xml) => new w.DOMParser().parseFromString(xml, 'application/xml') });

  // Compose — render another tool to an embeddable asset (tool composition).
  // The lean node CLI has no rasteriser, so it composes only children that export
  // to svg/data (same stance as host.export above) — a raster child throws and the
  // runtime omits that slot gracefully. Result is a data: URL (jsdom has no
  // URL.createObjectURL). Mirrors run.js's render path (hydrate into a node →
  // host.export.render), with watermark/provenance suppressed (intermediate asset).
  const composeFetchFile = async (p: string): Promise<string> => readFile(join(REPO_ROOT, 'tools', p), 'utf8');
  host.compose = {
    async render(spec) {
      const { toolId, inputs = {}, format, width, height, unit, dpi, _stack = [] } = (spec ?? {}) as ComposeSpec;
      if (typeof toolId !== 'string' || !toolId) throw new Error('compose: missing toolId');
      assertComposeStack(_stack, toolId); // engine-owned cycle/depth policy, shared with every shell
      const childTool = await loadTool(toolId, composeFetchFile);
      // Pass the ANCESTOR stack (_stack), not `path`: createRuntime re-appends the
      // child's id, so `path` would double-count and hit the depth guard early.
      const childRuntime = await createRuntime(childTool, host, inputs as Parameters<typeof createRuntime>[2], { composeStack: _stack });
      const el = w.document.createElement('div');
      el.innerHTML = childRuntime.getHydrated();
      // Compose children get the same brand vars as the top-level canvas
      // (plans/brand-token-contract.md §3 injection rules). For html-format
      // children the wrapper div (with its inline vars) is what's serialised;
      // the svg serialiser excludes the wrapper root, so standalone svg
      // children still rely on their var() fallbacks (accepted class).
      await applyBrandVars(el, host);
      const fmt = format ?? childTool.manifest.render.formats[0]!;
      // Honour requested dimensions — host.export (CLI svg) parses a unit-qualified
      // width/height via parseDimension; px passes through as a number.
      const u = unit || 'px';
      const qual = (v: number | null | undefined): string | number | undefined => (typeof v === 'number' && v > 0 ? (u !== 'px' ? `${v}${u}` : v) : undefined);
      const blob = await host.export.render(el, fmt as ExportFormat, { width: qual(width), height: qual(height), dpi, embedMeta: false, watermark: false });
      const buf = Buffer.from(await blob.arrayBuffer());
      return {
        source: 'remote',
        id: `compose:${toolId}`,
        type: fmt === 'svg' ? 'vector' : 'raster',
        format: fmt,
        url: `data:${mimeFor(fmt)};base64,${buf.toString('base64')}`,
      };
    },

    // Render a pasted/stored Lolly tool URL to an AssetRef whose id is the
    // canonical embed URL — the same contract as the web bridge, so a tool-sourced
    // asset re-resolves in CLI/headless runs too (svg works; a raster child throws
    // and the caller leaves the slot empty, matching host.compose.render's stance).
    async renderUrl(url, opts = {}) {
      const parsed = parseToolUrl(url);
      if (!parsed) return null;
      let childTool!: Awaited<ReturnType<typeof loadTool>>;
      try { childTool = await loadTool(parsed.toolId, composeFetchFile); } catch { return null; }
      // A pasted link may carry packed state (`?z=…`); expand before parsing. The
      // embed id below is minted from the EXPANDED query too — the packed query's
      // only param is the reserved `z`, which gets stripped, so a packed link would
      // otherwise render (and persist) as all defaults. Same as the web bridge.
      const query = await expandQuery(parsed.query);
      const st = parseUrlState(query, childTool.manifest);
      const supported = (childTool.manifest.render?.formats ?? []).map(f => String(f).toLowerCase());
      const norm = (f: string | null | undefined) => { const x = String(f || '').toLowerCase(); return x === 'jpeg' ? 'jpg' : x; };
      const format = norm(opts.format) || norm(parsed.format)
        || (supported.includes('svg') ? 'svg' : supported[0]);
      const width = opts.width ?? st.width ?? undefined;
      const height = opts.height ?? st.height ?? undefined;
      const unit = opts.unit ?? st.unit ?? undefined;
      const dpi = opts.dpi ?? st.dpi ?? undefined;
      let ref!: AssetRef;
      try {
        ref = await host.compose!.render({
          toolId: parsed.toolId, inputs: st.values,
          format: format as ExportFormat, width, height, unit, dpi, _stack: opts._stack ?? [],
        });
      } catch { return null; }
      if (!ref) return null;
      const q = new URLSearchParams(query);
      for (const k of RESERVED) q.delete(k);
      if (width) q.set('w', String(width));
      if (height) q.set('h', String(height));
      if (unit && unit !== 'px') { q.set('unit', String(unit)); if (dpi) q.set('dpi', String(dpi)); }
      const id = buildEmbedUrl({ toolId: parsed.toolId, format, query: q.toString() });
      // No re-parseable identity (too long) → don't persist a dead slot: a
      // `compose:<toolId>` id can't re-resolve on load (same stance as the web
      // bridge). meta.toolUrl carries the canonical id — it is what drives the
      // live-edit UI and what baking records as provenance (meta.bakedFrom).
      if (!id) return null;
      return {
        ...ref,
        id,
        meta: { ...(ref.meta || {}), tool: parsed.toolId, name: childTool.manifest.name ?? parsed.toolId, toolUrl: id },
      };
    },
  };

  return host;
}

// The seven semantic colour slots → namespaced CSS custom properties on the
// canvas root (plans/brand-token-contract.md §3): `--brand-primary` …
// `--brand-edge`. Reserved --brand-font/--brand-font-text are NOT set yet
// (font rung is a later pass).
const BRAND_VAR_SLOTS = ['primary', 'on-primary', 'secondary', 'surface', 'text', 'muted', 'edge'] as const;

/**
 * Resolve the active brand's semantic colour slots (`color.semantic.*`) via
 * host.tokens and set them as CSS custom properties (`--brand-primary`,
 * `--brand-surface`, …) on the element the tool template hydrates into — the
 * CLI half of the web shell's applyBrandVars, so a semantic-var template
 * renders identically via web, URL mode, and CLI. TokenSet.resolve takes the
 * alias form ({path}) and bare dotted paths under the same rule, so one call
 * covers both. A missing tokens asset or an unresolvable slot sets nothing
 * (never ''), leaving the template's own fallbacks
 * (`var(--brand-primary, #4f83cc)`) in charge.
 */
export async function applyBrandVars(el: HTMLElement, host: HostV1): Promise<void> {
  if (!host.tokens) return;
  for (const slot of BRAND_VAR_SLOTS) {
    let value: unknown;
    try { value = await host.tokens.resolve(`{color.semantic.${slot}}`); } catch { continue; }
    // A string passes through as resolved (oklch()/hex are both valid CSS) —
    // unless it is alias residue: a `{path}` that never resolved is a missing
    // slot, not a colour (contract §3), so it sets nothing. Any structured
    // DTCG colour form is normalised to hex by the engine.
    const css = typeof value === 'string' && value
      ? (isAlias(value) ? null : value)
      : colorToHex(value);
    if (css) el.style.setProperty(`--brand-${slot}`, css);
  }
}

// Embed authorship provenance as <title>/<desc> + a Dublin-Core <metadata> block
// right after the opening <svg> tag (mirrors the web bridge's injectSvgMeta).
function injectSvgMeta(xml: string, meta: ExportMeta | undefined): string {
  if (!meta) return xml;
  const e = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines: string[] = [];
  if (meta.tool) lines.push(`<title>${e(meta.tool)}</title>`);
  const desc = [meta.description, meta.contact].filter(Boolean).join(' · ');
  if (desc) lines.push(`<desc>${e(desc)}</desc>`);
  lines.push(
    '<metadata>',
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/">',
    '<rdf:Description rdf:about="">',
  );
  if (meta.author) lines.push(`<dc:creator>${e(meta.author)}</dc:creator>`);
  lines.push(`<dc:publisher>${e(meta.software)}</dc:publisher>`);
  lines.push(`<dc:source>${e(meta.source)}</dc:source>`, '</rdf:Description>', '</rdf:RDF>', '</metadata>');
  const m = xml.match(/<svg\b[^>]*?>/);
  if (!m) return xml;
  const at = m.index! + m[0]!.length;
  return xml.slice(0, at) + '\n' + lines.join('\n') + xml.slice(at);
}

function matchesFilter(meta: CatalogAsset, filter: AssetQuery): boolean {
  if (filter.type && meta.type !== filter.type) return false;
  if (filter.namespace && !meta.id.startsWith(filter.namespace + '/') && meta.id !== filter.namespace) return false;
  if (filter.tags?.length) {
    const tags = new Set(meta.tags ?? []);
    if (!filter.tags.every(t => tags.has(t))) return false;
  }
  if (!filter.includeDeprecated && meta.deprecated) return false;
  return true;
}

function mimeFor(format: string): string {
  switch (format) {
    case 'svg': return 'image/svg+xml';
    case 'png': return 'image/png';
    case 'jpg': case 'jpeg': return 'image/jpeg';
    case 'webp': return 'image/webp';
    case 'emf': return 'image/emf';
    case 'eps': case 'eps-cmyk': return 'application/postscript';
    case 'json': return 'application/json';
    default: return 'application/octet-stream';
  }
}
