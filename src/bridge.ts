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

import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { buildCmykPaletteMap, parseDimension, toCssLength, toCssPx, toPixels, loadTool, createRuntime, emitEmf, emitEps, emitDxf, parseToolUrl, buildEmbedUrl, parseUrlState, expandQuery, RESERVED, assertComposeStack, parseThemedAssetId, applyIconTheme, parseIconThemesDoc, parseTreatedAssetId, parsePhotoTreatmentsDoc, wrapRasterWithTreatment, createTokenSet, colorToHex, isAlias, makeColorApi, makeGeomApi, isZzfxmRef, parseZzfxmRef, formatZzfxmRef } from '@lolly/engine';
import type {
  HostV1, Profile, AssetsAPI, AssetRef, AssetQuery, ExportOpts, ExportMeta,
  StateEntry, ComposeSpec, ComposeUrlOpts, ExportFormat, TokenSet,
} from '@lolly-tools/core/host-v1';
// Deep image encoders (v1.100 host.codec) — off the @lolly/engine barrel by
// design, imported deep-relative like node-shell/raster.ts does for packExr.
import { encodeExr, encodeRadiance, encodePng16, encodeDither8 } from '../../../engine/src/deep-encode.ts';
// PDF metadata inspect/strip is pure pdf-lib (no DOM), so the lean node CLI
// shares the web shell's implementation rather than duplicating it.
import { createPdfAPI } from '../../web/src/bridge/pdf.ts';
// PPTX inspect/rebrand is engine primitives + fflate (plain JS) with the XML
// parser injected, so the CLI shares one impl with the web shell and supplies
// jsdom's DOMParser. RELATIVE import on purpose, same reason as repo-root below:
// this file is inlined into the Vercel MCP function by scripts/build-mcp-fn.ts,
// whose esbuild config leaves bare package specifiers external, so a
// `@lolly-tools/node-shell/pptx` import would dangle in the bundle.
import { createPptxAPI } from '../../../packages/node-shell/src/pptx.ts';
// host.net allowlisted fetch is DOM-free too (global fetch + TransformStream, both
// Node ≥18 globals), so every shell builds it from one module — the prefix-match
// rules and the 64 MB counting-stream cap can never drift. RELATIVE for the same
// MCP-bundle reason as above.
import { createNetAPI } from '../../../packages/node-shell/src/net.ts';
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
// host.audio (WAV/ZzFXM decode + the engine's frame analysis). RELATIVE for the same
// MCP-bundle reason; it pulls no codec and no WASM, so attaching it is free.
import { createNodeAudioAPI } from '../../../packages/node-shell/src/audio.ts';
// url-shot page capture (scoped Chromium). RELATIVE for the MCP bundle; its browser is
// lazy-loaded, so importing it costs nothing until a capture actually runs.
import { captureUrl } from '../../../packages/node-shell/src/url-capture.ts';
// host.images (decode/resize/encode via sharp). RELATIVE for the same MCP-bundle reason;
// it resolves sharp lazily and returns null when it isn't installed, so importing it is
// free and a lean install simply leaves host.images undefined.
import { createNodeImagesAPI } from '../../../packages/node-shell/src/images.ts';
// LOLLY_STATE_DIR resolution (shared with the TUI). RELATIVE for the MCP-bundle reason.
import { resolveStateDir } from '../../../packages/node-shell/src/state-dir.ts';
// Text-as-paths on the svg branch (contract §6a). Local to this shell: it resolves
// fonts through host.text's headless registry, not the web shell's fetching one.
import { outlineSvgText } from './svg-outline.ts';
import { unavailableHere } from './exit-codes.ts';
const REPO_ROOT = repoRoot();

/**
 * Capabilities THIS shell can actually fulfil — the CLI's answer to the web shell's
 * PROVIDED_CAPABILITIES (shells/web/src/bridge/capabilities-provided.ts), which the
 * gallery uses to disable tools it cannot run. The CLI never declared its set at all,
 * so a `screen`/`microphone` tool rendered a misleading placeholder and exited 0
 * instead of refusing (contract B11).
 *
 * What is in and why:
 *   • network  — host.net, allowlisted per manifest.
 *   • wasm     — host.text's HarfBuzz WASM loads in Node.
 *   • compose  — host.compose renders child tools in-process.
 *   • capture  — host.capture.page drives the scoped Chromium. Present even when no
 *                browser is installed: that is a "not installed HERE yet" (exit 3 with
 *                `lolly install-browser`), not "this shell cannot do it".
 * What is out: clipboard (throws by design, §4.4), camera/microphone/screen (no
 * device access in a headless process, and shelling out to one is a non-goal),
 * ffmpeg (never shipped), filesystem (the RUNNER reads and writes files; the host
 * bridge exposes no filesystem API a tool could call).
 */
export const CLI_CAPABILITIES = ['network', 'wasm', 'compose', 'capture'] as const;

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
  /** The `hdr=` request, forwarded by run.ts. The canonical HostV1 ExportOpts has no
   *  HDR dials (the web shell carries its own extension too — shells/web/src/bridge/
   *  export.ts's ExportOpts), so this is the CLI's local extension of the same shape,
   *  in url-mode's 0–100 author dial units. Absent ⇒ SDR ⇒ exr/hdr refuse. */
  hdr?: { targets?: readonly string[]; peakNits?: number; reach?: number; lift?: number; richness?: number } | null;
  /** `--text=outline|live` (contract §1.3). Default outline; 'live' keeps `<text>`. */
  text?: 'outline' | 'live';
  /** Reported once per run that could not be outlined, so the runner can warn (and
   *  refuse under --strict) instead of the bridge writing to stderr itself. */
  onTextFallback?: (run: { text: string; reason: string }) => void;
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
    capabilities: CLI_CAPABILITIES,
    // EVERY level goes to stderr (contract B4). `info`/`debug` used to go to stdout,
    // where a tool's one chatty log line interleaved itself into a piped PNG — and
    // tools ship as data from another repository, so this shell cannot assume they are
    // quiet. stdout carries the payload and nothing else.
    log: (level: 'debug' | 'info' | 'warn' | 'error', msg: string, ctx?: object): void => {
      if (level === 'debug' && !process.env.DEBUG) return;
      process.stderr.write(`[${level}] ${msg}${ctx ? ' ' + JSON.stringify(ctx) : ''}\n`);
    },
    // The literal is built in stages below (profile, assets, state, export, …), so the
    // assertion is what tells TypeScript the finished object is a CliHost.
  } as unknown as CliHost;

  host.profile = {
    async get() { return profile; },
    subscribe() { return () => {}; },
  };

  // Deep image codecs (v1.100) — the same pure engine writers the web shell
  // wraps, so a tool that hands over a float frame encodes identically headless.
  // (No native deps; the writers are pure TypeScript.)
  host.codec = {
    png16: async (f, o) => encodePng16({ ...f, space: f.space ?? 'srgb-linear' }, o),
    exr: async (f, o) => encodeExr({ ...f, space: f.space ?? 'srgb-linear' }, o),
    radiance: async (f, o) => encodeRadiance({ ...f, space: f.space ?? 'srgb-linear' }, o),
    dither8: async (f, o) => encodeDither8({ ...f, space: f.space ?? 'srgb-linear' }, o),
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

  // Vector geometry (v1.64) — the geometry kernel behind SVG path-data strings.
  // Pure engine math, attached verbatim (the SAME object the web bridge attaches),
  // so a pen-tool hook computes identical geometry headlessly.
  host.geom = makeGeomApi();

  // host.text — text-to-path (HarfBuzz WASM), the SAME shaping the web shell uses, so a
  // tool that outlines text via host.text renders identically in the terminal. Without
  // it, brand-lockup (and any host.text-in-hooks tool) throws in onInit and emits an
  // empty SVG. Fonts resolve off disk under the repo root (see text.ts). Node-only fonts
  // are all sfnt; the WASM loads lazily on first shape.
  host.text = createNodeTextAPI({ repoRoot: REPO_ROOT });

  // host.audio (v1.71) — the SAME per-frame analysis the web shell runs (the engine's
  // analysePcm), so an audio-reactive tool draws identical frames headlessly. The
  // decoder is what differs and it is narrow on purpose: WAV plus our own ZzFXM
  // songs, with no shelling out to ffmpeg, so a headless render never silently
  // depends on whatever binary is on PATH. Anything needing a platform codec (mp3,
  // aac, opus) rejects by name — see packages/node-shell/src/audio.ts.
  host.audio = createNodeAudioAPI({ repoRoot: REPO_ROOT });

  // host.images — decode/resize/encode, backed by sharp (native codecs; reads HEIC/AVIF/
  // TIFF, writes the web-safe three). Without it a converter tool like convert-image can
  // only throw, which is what the CLI used to do. ATTACHED ONLY IF sharp resolves: the
  // contract is optional and tools feature-detect it, so absent is a defined state and
  // strictly better than a present-but-throwing stub.
  const images = createNodeImagesAPI();
  if (images) host.images = images;

  // host.net — allowlisted fetch for tools that declared the 'network' capability,
  // built per-invocation from the loaded manifest's network.allowlist (callers thread
  // it in via CliBridgeOpts). Deny happens before any I/O, so an empty/absent allowlist
  // means the API exists but every fetch rejects — identical fail-closed stance to web.
  host.net = createNetAPI({ allowlist: networkAllowlist });

  host.assets = {
    async get(id) {
      // A PROCEDURAL asset: `zzfxm:<seed>[:<style>]` names a song that is
      // synthesised on demand, not a file the catalog stores. It resolves to
      // ITSELF — url === id — exactly as the web bridge does, so a headless render
      // of a project carries the same bed marker a browser render does. Without
      // it the engine's resolveOne throws "Asset not in catalog", nulls the field
      // before hooks run, and the bed silently disappears from the output.
      // The CLI cannot synthesise the audio (no Web Audio), but dropping the ref
      // would be a different document, not a smaller one.
      if (isZzfxmRef(id)) {
        const ref = parseZzfxmRef(id);
        if (!ref) throw new Error(`Malformed procedural audio ref: ${id}`);
        const canonical = formatZzfxmRef(ref);
        return {
          source: 'library', id: canonical, type: 'audio', format: 'zzfxm', url: canonical,
          meta: { name: 'Generated music', generated: true, seed: ref.seed, ...(ref.style ? { style: ref.style } : {}) },
        };
      }
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

  // host.state — in memory by default (a CLI invocation is ephemeral), on DISK when
  // the machine names a state directory (contract §1.5/B14). Opt-in on purpose: a
  // render must not leave files in $HOME nobody asked for (non-goal §8.7), but a tool
  // that saves state was previously unscriptable, because every run started empty.
  const stateHome = resolveStateDir();
  const stateFsDir = stateHome.explicit ? join(stateHome.dir, 'state') : null;
  const slotFile = (slot: string): string => join(stateFsDir!, encodeURIComponent(slot) + '.json');
  host.state = {
    async save(slot, data) {
      const entry = { data, updatedAt: new Date().toISOString() };
      state.set(slot, entry);
      if (stateFsDir) {
        await mkdir(stateFsDir, { recursive: true });
        await writeFile(slotFile(slot), JSON.stringify(entry, null, 2));
      }
    },
    async load(slot) {
      const hit = state.get(slot);
      if (hit) return hit.data;
      if (!stateFsDir) return null;
      try { return (JSON.parse(await readFile(slotFile(slot), 'utf8')) as { data: object }).data ?? null; }
      catch { return null; }
    },
    async list() {
      const slots = new Set(state.keys());
      if (stateFsDir) {
        try {
          for (const f of await readdir(stateFsDir)) {
            if (f.endsWith('.json')) slots.add(decodeURIComponent(f.slice(0, -5)));
          }
        } catch { /* no state dir yet — nothing saved */ }
      }
      return Array.from(slots).map(slot => ({ slot })) as StateEntry[];
    },
    async delete(slot) {
      state.delete(slot);
      if (stateFsDir) { try { await rm(slotFile(slot)); } catch { /* already gone */ } }
    },
  };

  // The clipboard keeps throwing (shelling out to pbcopy/xclip is a non-goal), but the
  // throw is now CLASSIFIED: exit 3, "impossible in this installation", naming the way
  // out. It is not a bug and it is not a usage error (contract §4.4).
  const noClipboard = (): never => {
    throw unavailableHere(
      'The clipboard is not available in the CLI — write the result with --output=<path> (or --output=- for stdout) instead.',
      'CAPABILITY_UNAVAILABLE',
    );
  };
  host.clipboard = {
    async writeText() { return noClipboard(); },
    async writeImage() { return noClipboard(); },
  };

  // CLI export covers everything producible without a layout/paint engine:
  //   • text / data — html, svg, json, csv, ics, vcf (the engine hydrates these)
  // Raster (png/jpg/webp/avif/ico), pdf/pdf-cmyk, zip and video need a real
  // browser engine (jsdom has no layout), so they're produced by the web shell
  // or the Tauri-bundled CLI (which ships a WebView) — a deliberate decision, not
  // a TODO: the node CLI stays dependency-light rather than bundling Chromium.
/**
 * The tool's OWN root `<svg>`, or null when the tool draws in HTML.
 *
 * The vector formats below (svg / emf / eps / dxf) are CLI-native only for tools whose
 * template IS an `<svg>` — a browser-free vector path with no layout engine. The old
 * test for that was `node.querySelector('svg')`, which finds ANY descendant, and that
 * is wrong now that an HTML-layout tool can contain one: Layout Studio's vector path
 * boxes emit an inline `<svg><path>` per shape, so a poster with one pen shape used to
 * export as that ONE shape, with the artboard, the background and every other box
 * silently dropped — a plausible-looking wrong file, which is worse than a refusal.
 *
 * So: descend only through wrappers that have exactly one drawable child (scripts and
 * styles don't count — several native-svg tools ship a template script beside their
 * `<svg>`). A container with two drawable children is a LAYOUT, not a wrapper, and the
 * answer is null → the caller raises "needs a browser engine", which is the truth.
 */
const NON_DRAWABLE = new Set(['script', 'style', 'template', 'link', 'meta']);
function rootSvgOf(node: Element | null): Element | null {
  let cur: Element | null = node;
  for (let depth = 0; cur && depth < 8; depth++) {
    if (cur.tagName?.toLowerCase() === 'svg') return cur;
    const kids = Array.from(cur.children).filter(
      (el) => !NON_DRAWABLE.has(el.tagName.toLowerCase()),
    );
    if (kids.length !== 1) return null;
    cur = kids[0] ?? null;
  }
  return null;
}

  host.export = {
    async render(node: Element, format: string, opts: CliExportRenderOpts = {}): Promise<Blob> {
      // Data/text formats: the engine already hydrated the payload (JSON from the
      // model, ICS/VCF/CSV from a sibling text template). The host just wraps it.
      if (opts.dataText !== undefined) {
        return new Blob([opts.dataText], { type: opts.dataMime ?? 'text/plain' });
      }
      if (format === 'html') {
        // Strip any template <script> (editor-runtime helpers — e.g. a canvas
        // auto-resize hook) before serialising: the exported markup is static, and
        // the web shell's HTML export (renderStaticHtml) does the same. Clone so the
        // live node is left untouched.
        const clone = node.cloneNode(true) as Element;
        clone.querySelectorAll('script').forEach((el) => el.remove());
        return new Blob([clone.outerHTML], { type: 'text/html' });
      }
      if (format === 'svg') {
        const svg = rootSvgOf(node);
        if (!svg) {
          throw new Error('SVG export requires the template\'s root drawable to be an <svg> (HTML-layout tools need a browser engine — use the desktop app or the web shell)');
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
        // TEXT AS PATHS (contract §6a). Every other vector format this shell writes
        // (emf/eps/dxf) already outlines through the same host.text; svg kept live
        // <text>, so a recipient without the font silently got a different design.
        // `--text=live` (opts.text) is the documented opt-out for anyone who wants an
        // editable SVG; a run whose font cannot be resolved keeps its <text> and warns,
        // because unlike EMF, SVG can represent live text and a hard failure on the
        // everyday format would be worse than a warned fallback.
        if (opts.text !== 'live') {
          const res = await outlineSvgText(svg, host, {
            getComputedStyle: w.getComputedStyle ? (el: Element) => { try { return w.getComputedStyle(el); } catch { return null; } } : null,
          });
          for (const f of res.fallbacks) opts.onTextFallback?.(f);
        }
        const raw = w.XMLSerializer
          ? new w.XMLSerializer().serializeToString(svg)
          : svg.outerHTML;
        const xml = injectSvgMeta(raw, opts.meta); // embed authorship provenance
        return new Blob(['<?xml version="1.0" standalone="no"?>\n' + xml], { type: 'image/svg+xml' });
      }
      if (format === 'emf') {
        // EMF is pure bytes built from SVG primitives — no rasteriser needed, so
        // it joins svg as a CLI-native format for native-<svg> tools. Live <text>
        // is outlined in the walk: host.text (createNodeTextAPI above) shapes any
        // run whose family resolves to an sfnt on disk (e.g. the Outfit platform
        // face); an unresolvable family throws (the always-text-as-paths guard).
        const svg = rootSvgOf(node);
        if (!svg) throw new Error('EMF export requires an <svg> in the template (HTML-layout tools need a browser engine — use the desktop app)');
        const ir = await svgDomToIr(svg, { host, background: opts.background });
        const bytes = emitEmf(ir, { width: opts.width, height: opts.height, unit: opts.unit, dpi: opts.dpi });
        return new Blob([bytes as BlobPart], { type: 'image/emf' });
      }
      if (format === 'eps' || format === 'eps-cmyk') {
        // EPS is vector PostScript built from the same SVG IR as EMF — text is
        // outlined upstream (svgDomToIr shapes live <text> via host.text; an
        // unresolvable family throws), so the emitter writes no fonts. eps-cmyk
        // is naive DeviceCMYK: no embedded output intent (same as the web shell).
        //
        // The brand cmykPalette IS threaded now, through the SAME shared builder
        // the web shell's three CMYK sinks use (engine/src/cmyk-palette.ts). It
        // used to be omitted here, which made the finish fix web-only: a brand
        // declaring a Gold spot with finish 'foil' got a naive
        // rgb→cmyk gold build out of `lolly … --export=eps-cmyk`, silently, with
        // nothing in the file saying so. A finish now resolves to
        // FINISH_MASK_CMYK here exactly as it does in the browser.
        const svg = rootSvgOf(node);
        if (!svg) throw new Error('EPS export requires an <svg> in the template (HTML-layout tools need a browser engine — use the desktop app)');
        const ir = await svgDomToIr(svg, { host, background: opts.background, label: 'EPS' });
        const text = emitEps(ir, {
          width: opts.width, height: opts.height, unit: opts.unit, dpi: opts.dpi,
          cmyk: format === 'eps-cmyk',
          ...(format === 'eps-cmyk' ? { cmykPalette: await brandCmykPalette(host) } : {}),
          meta: opts.meta as { title?: string } | undefined,
        });
        return new Blob([text], { type: 'application/postscript' });
      }
      if (format === 'dxf') {
        // DXF is the same SVG-IR path as EMF/EPS — a fourth sink on svgDomToIr, so a
        // native-<svg> tool exports vector CAD DXF browser-free (no 150MB Chromium for
        // what is fundamentally text). Text is outlined upstream (host.text present).
        const svg = rootSvgOf(node);
        if (!svg) throw new Error('DXF export requires an <svg> in the template (HTML-layout tools need a browser engine — use the desktop app)');
        const ir = await svgDomToIr(svg, { host, background: opts.background, label: 'DXF' });
        const { text } = emitDxf(ir, { width: opts.width, height: opts.height, unit: opts.unit, dpi: opts.dpi });
        return new Blob([text], { type: 'image/vnd.dxf' });
      }
      if (format === 'exr' || format === 'hdr') {
        // The pro float formats (plans/deeprichpixels.md §6 B3, surfaced CLI-first per
        // §10 item 4): the engine's own OpenEXR / Radiance writers over a resvg raster
        // of THIS tool's SVG. Browser-free, so they belong on this side of the tier
        // split rather than in raster.ts's Tier B.
        //
        // Two refusals, in order, both loud (their wording deliberately avoids run.ts's
        // "fall back to HTML" signature — a pro-format request must never quietly
        // become a .html file):
        //   1. no root <svg> → this tool needs layout, which jsdom cannot do;
        //   2. no `hdr=` → the raster is 8-bit sRGB and float would be padding.
        const svg = rootSvgOf(node);
        if (!svg) throw new Error('EXR/HDR export needs the template\'s root drawable to be a vector image (HTML-layout tools have no browser-free raster here — use the desktop app or the web shell)');
        const raw = w.XMLSerializer ? new w.XMLSerializer().serializeToString(svg) : svg.outerHTML;
        // Lazy: pulls in resvg (a native module) and the engine's EXR/Radiance writers
        // only when a pro format is actually asked for.
        const { renderDeepRaster, deepFormatMime } = await import('../../../packages/node-shell/src/raster.ts');
        // Physical units convert through the engine's own unit maths at the export
        // DPI, exactly like every other CLI format (--width=210 --unit=mm --dpi=300).
        const dpi = opts.dpi ?? 300;
        const px = (v: string | number | undefined, fallback: number): number => {
          const d = parseDimension(v);
          return d ? Math.max(1, Math.round(toPixels(d, dpi))) : fallback;
        };
        const { bytes, mime } = await renderDeepRaster({
          svg: raw,
          width: px(opts.width, parseFloat(svg.getAttribute('width') as string) || 1280),
          height: px(opts.height, parseFloat(svg.getAttribute('height') as string) || 720),
          format,
          hdr: opts.hdr ?? null,
          depth: opts.depth,
          log: (level, message) => host.log(level, message),
        });
        return new Blob([bytes as BlobPart], { type: mime || deepFormatMime(format) });
      }
      // The remedy list is NODE_FORMATS itself, not a hand-kept copy of it: the two
      // drifted, so the message offered formats the engine no longer claims and omitted
      // `md`, which works. A remedy a reader cannot act on is worse than no remedy.
      const { NODE_FORMATS } = await import('../../../packages/node-shell/src/raster.ts');
      throw new Error(`CLI shell does not support format "${format}" (needs a browser engine). Use one of the browser-free formats (${NODE_FORMATS.join(', ')}), a pro float format (exr, hdr — with hdr=1), install the render tier with \`lolly install-browser\`, or run the Tauri-bundled CLI for raster/pdf/zip.`);
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
    // Pro float formats (plans/deeprichpixels.md §6 B3). `image/x-exr` is the de-facto
    // OpenEXR type (never IANA-registered); `image/vnd.radiance` IS registered for RGBE.
    case 'exr': return 'image/x-exr';
    case 'hdr': return 'image/vnd.radiance';
    case 'json': return 'application/json';
    default: return 'application/octet-stream';
  }
}

/**
 * The brand palette as a CMYK substitution map, for the CLI's eps-cmyk sink.
 *
 * Built through the ENGINE's `buildCmykPaletteMap` — the same one the web
 * shell's PDF/TIFF/EPS sinks use — so a declared finish resolves to
 * `FINISH_MASK_CMYK` in the terminal exactly as it does in the browser. Before
 * this existed the CLI passed no palette at all, so the finish fix stopped at
 * the shell boundary and `lolly wordmark --export=eps-cmyk` still converted a
 * declared foil into its plausible swatch gold, silently.
 *
 * Total: a brand with no tokens, an unreadable tokens doc or a throwing
 * `host.tokens.colors()` yields an empty map, which is byte-identical to the
 * previous behaviour (every colour falls through to the generic conversion).
 */
async function brandCmykPalette(host: HostV1): Promise<Map<string, { cmyk: [number, number, number, number] }>> {
  try {
    const colors = await host.tokens?.colors?.();
    if (!Array.isArray(colors) || colors.length === 0) return new Map();
    return buildCmykPaletteMap(colors.map(c => ({
      hex: c.value,
      ...(Array.isArray(c.cmyk) ? { cmyk: c.cmyk } : {}),
      label: c.name,
      spot: c.spot ?? null,
    })));
  } catch {
    return new Map();
  }
}
