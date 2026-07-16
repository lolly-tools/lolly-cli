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
 * through the DOM-free bridge. The tier internals (pxDims, resvg rasterisation, the
 * web-shell driver) live in @lolly-tools/node-shell, shared with the TUI.
 */
import type { JSDOM } from 'jsdom';
import { serializeUrlState } from '@lolly/engine';
import { pxDims, rasterizeSvgToPng } from '@lolly-tools/node-shell/raster';
import type { RenderDims } from '@lolly-tools/node-shell/webshell-render';

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
  // PNG-only, and layout formats need a real engine). A pixel-watermark (imprint) request
  // also falls through: resvg can't embed the DCT mark, so the web shell's imprintCanvas
  // must do it (exportUrl carries ?imprint=1 from dims.imprint).
  if (fmt === 'png' && !dims.imprint) {
    const svg = await tryRenderSvg(runtime, dom);
    if (svg) {
      const { width, height } = pxDims(dims, manifest);
      return { bytes: await rasterizeSvgToPng(svg, width, height), usedBrowser: false };
    }
  }

  // Tier B — drive the built web shell in the scoped Chromium; capture the exact bytes
  // its own export path downloads (one render path, no drift vs web/desktop).
  const { renderViaWebShell } = await import('@lolly-tools/node-shell/webshell-render');
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
