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
import { pxDims, rasterizeSvgToPng, rasterizeSvgToImprintedPng } from '@lolly-tools/node-shell/raster';
import type { RenderDims } from '@lolly-tools/node-shell/webshell-render';

interface Runtime {
  getHydrated(): string;
  getModel(): unknown;
  export(node: unknown, format: string, opts?: object): Promise<Blob>;
}
interface Manifest { id: string; render?: { width?: number; height?: number } }

export interface RasterResult {
  bytes: Uint8Array;
  usedBrowser: boolean;
  /** Whether the Lolly Imprint was genuinely embedded on the Node tier. Undefined on
   *  the browser tier, which owns (and reports) its own marks. Never guessed: a frame
   *  below the watermark's detection floor writes an unmarked PNG and says false. */
  imprinted?: boolean;
}

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
  // PNG-only, and layout formats need a real engine). A durable-credential (neural
  // TrustMark) request still falls through — that encoder is a browser feature.
  //
  // The pixel-watermark (imprint) used to fall through too, and that stopped being
  // acceptable the moment the Imprint became default-on for CLI renders (contract §12
  // O2): every `--export=png` would have demanded the scoped Chromium for a mark the
  // caller never asked for. It is embedded HERE instead, browser-free, through the
  // engine's own DOM-free watermark maths (rasterizeSvgToImprintedPng). A frame below
  // the detection floor comes back null and writes the ordinary PNG — the browser
  // could not have marked it either.
  //
  // Print prep falls through too, as a BACKSTOP. resvg is handed the tool's own SVG and
  // knows nothing about a bleed box or crop marks, so Tier A used to accept --bleed /
  // --marks and produce bytes identical to a run without them: no marks, no warning,
  // exit 0. run.ts now refuses those flags outright for any format that cannot carry
  // page geometry (PRINT_PREP_FORMATS), so this should be unreachable — it stays so the
  // silent no-op cannot come back if that allowlist ever widens.
  if (fmt === 'png' && !dims.durable && !dims.bleed && !dims.marks) {
    const svg = await tryRenderSvg(runtime, dom);
    if (svg) {
      const { width, height } = pxDims(dims, manifest);
      if (dims.imprint) {
        const marked = await rasterizeSvgToImprintedPng(svg, width, height);
        if (marked) return { bytes: marked, usedBrowser: false, imprinted: true };
      }
      return { bytes: await rasterizeSvgToPng(svg, width, height), usedBrowser: false, imprinted: false };
    }
  }

  // Tier B — drive the built web shell in the scoped Chromium; capture the exact bytes
  // its own export path downloads (one render path, no drift vs web/desktop).
  const query = serializeUrlState(runtime.getModel() as never);
  const MOTION = ['gif', 'apng', 'webm', 'mp4'];
  // PROTOTYPE opt-in: real Playwright screenshots instead of dom-to-image for the
  // frame-by-frame capture (see renderVideoViaScreenshot's doc comment). Motion
  // formats only, and only when explicitly requested — every other case, and the
  // default with this unset, still goes through renderViaWebShell unchanged.
  if (MOTION.includes(fmt) && process.env.LOLLY_VIDEO_CAPTURE === 'screenshot') {
    const { renderVideoViaScreenshot } = await import('@lolly-tools/node-shell/webshell-render');
    const { bytes } = await renderVideoViaScreenshot(manifest.id, query, fmt, dims);
    return { bytes, usedBrowser: true };
  }
  const { renderViaWebShell } = await import('@lolly-tools/node-shell/webshell-render');
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
