// SPDX-License-Identifier: MPL-2.0
/**
 * The CLI's raster/PDF/video tier — two levels, smallest-footprint first:
 *
 *   Tier A (no browser):  PNG from an SVG-native tool, rasterised with resvg (pure
 *                         Rust — a few-MB native module, not a browser). Instant,
 *                         always available, zero setup. Covers most of the catalog.
 *   Tier B (headless):    everything else (HTML-layout raster, jpg/webp, pdf, video)
 *                         — drive the built web shell in a scoped Chromium so the
 *                         bytes match a web/desktop Download exactly (webshell-render).
 *
 * run.ts calls this only for non-engine-native formats; svg/emf/eps + data still go
 * through the DOM-free bridge. Mirrors the fast-path in shells/tui/src/engine-render.ts.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JSDOM } from 'jsdom';
import { serializeUrlState, parseDimension, toPixels } from '@lolly/engine';
import type { RenderDims } from './webshell-render.ts';

// shells/cli/src → repo root is three levels up. Catalog fonts feed resvg so text-bearing
// SVG tools rasterise with the brand faces, not whatever the OS happens to have.
const FONTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'catalog', 'fonts');

interface Runtime {
  getHydrated(): string;
  getModel(): unknown;
  export(node: unknown, format: string, opts?: object): Promise<Blob>;
}
interface Manifest { id: string; render?: { width?: number; height?: number } }

export interface RasterResult { bytes: Uint8Array; usedBrowser: boolean }

/**
 * Render a raster/PDF/video format. Returns the bytes plus whether Tier B (the browser)
 * ran, so the caller can tear the browser + server down on a single-shot CLI invocation.
 */
export async function renderRaster(opts: {
  runtime: Runtime; dom: JSDOM; manifest: Manifest; format: string; dims: RenderDims;
}): Promise<RasterResult> {
  const { runtime, dom, manifest, dims } = opts;
  const fmt = opts.format.toLowerCase();

  // Tier A — PNG from an SVG-native tool: resvg rasterises the engine's own SVG. No
  // browser, no built web shell. jpg/webp/pdf/video fall through to Tier B (resvg is
  // PNG-only, and layout formats need a real engine).
  if (fmt === 'png') {
    const svg = await tryRenderSvg(runtime, dom);
    if (svg) {
      const { width, height } = pxDims(dims, manifest);
      return { bytes: await rasterizeSvgToPng(svg, width, height), usedBrowser: false };
    }
  }

  // Tier B — drive the built web shell in the scoped Chromium; capture the exact bytes
  // its own export path downloads (one render path, no drift vs web/desktop).
  const { renderViaWebShell } = await import('./webshell-render.ts');
  const query = serializeUrlState(runtime.getModel() as never);
  const { bytes } = await renderViaWebShell(manifest.id, query, fmt, dims);
  return { bytes, usedBrowser: true };
}

/**
 * Render the runtime's current state to an SVG string, or null when this tool can't
 * produce SVG in a pure-Node shell (HTML-layout tools have no <svg> and need a browser).
 */
async function tryRenderSvg(runtime: Runtime, dom: JSDOM): Promise<string | null> {
  try {
    const canvas = dom.window.document.getElementById('canvas');
    if (!canvas) return null;
    canvas.innerHTML = runtime.getHydrated();
    const blob = await runtime.export(canvas, 'svg', {});
    return await blob.text();
  } catch {
    return null;
  }
}

/** Resolve export dims to plain pixels (converts a physical unit like mm via the engine's
 *  own unit math; falls back to the tool's render size, else 1280×720). */
function pxDims(dims: RenderDims, manifest: Manifest): { width: number; height: number } {
  const dpi = dims.dpi && dims.dpi > 0 ? dims.dpi : 300;
  const render = manifest.render ?? {};
  const toPx = (v: number | undefined, fallback: number): number => {
    if (!(typeof v === 'number' && v > 0)) return fallback;
    const u = dims.unit || 'px';
    if (u === 'px') return Math.round(v);
    const d = parseDimension(`${v}${u}`);
    return d ? Math.round(toPixels(d, dpi)) : Math.round(v);
  };
  return { width: toPx(dims.width, render.width ?? 1280), height: toPx(dims.height, render.height ?? 720) };
}

/** Rasterise an SVG string to a `width`×`height` px PNG via resvg (pure Rust, no browser).
 *  resvg's `fitTo` constrains one axis, so to honour BOTH requested dimensions we set the
 *  root's width/height to the exact target box and render at that intrinsic size — the
 *  SVG's own viewBox + preserveAspectRatio then place the content (letterbox/meet as the
 *  tool authored it), matching the web/desktop raster rather than dropping the height. */
async function rasterizeSvgToPng(svg: string, width: number, height: number): Promise<Uint8Array> {
  const { Resvg } = await import('@resvg/resvg-js');
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const m = svg.match(/<svg\b([^>]*)>/);
  let sized = svg;
  if (m) {
    let attrs = m[1]!;
    // Keep a viewBox (the content coordinate space); synthesise one from the root's own
    // width/height if it lacks one, so the content still scales to the target box.
    if (!/\bviewBox=/.test(attrs)) {
      const ow = attrs.match(/\bwidth="([\d.]+)"/)?.[1];
      const oh = attrs.match(/\bheight="([\d.]+)"/)?.[1];
      if (ow && oh) attrs += ` viewBox="0 0 ${ow} ${oh}"`;
    }
    attrs = attrs.replace(/\s(width|height)="[^"]*"/g, '');   // drop native size, keep viewBox + PAR
    sized = svg.replace(/<svg\b[^>]*>/, `<svg${attrs} width="${w}" height="${h}">`);
  }
  const r = new Resvg(sized, {
    fitTo: { mode: 'original' },
    font: { fontDirs: [FONTS_DIR], loadSystemFonts: true },
  });
  return r.render().asPng();
}
