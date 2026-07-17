// SPDX-License-Identifier: MPL-2.0
/**
 * `lolly smoke` — the catalog-wide render gate.
 *
 * Renders EVERY tool in the active profile's catalog at manifest defaults, each to its
 * first Node-native format (NODE_FORMATS — DOM-free, browser-free), and exits non-zero
 * if any render fails. assertRenderOk is already wired inside the CLI write path, so a
 * hooks.js regression that would ship a blank tool surfaces here as that tool's ✗ —
 * this is the CI job that keeps the gallery from ever shipping a tool that renders
 * blank. Budget rules: renders run sequentially, never launch a browser, never
 * download one.
 *
 * Format choice per tool:
 *   1. the first declared format that is Node-native (svg/emf/eps/dxf + data formats
 *      + html) → the normal runToolCli path, same as a user's `--export=`;
 *   2. no Node-native format declared at all (browser-only tools: pptx/raster/video
 *      first) → an inline hydrate + export-html render. runToolCli refuses `--export=`
 *      of an undeclared format, but html still exercises load → hydrate → hooks →
 *      assertRenderOk, which is what smoke is for (the established headless fallback).
 *
 * Tools that legitimately cannot render headlessly are SKIPPED with a reason, never
 * failed: transform tools (hooks.exportFile — file in → bytes out, nothing to render
 * at defaults) and tools gated on a live-capture capability (camera/microphone/screen/
 * capture — browser-only by definition). Everything else is strict: a hook error is a
 * real failure.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRuntime, loadTool, parseUrlState } from '@lolly/engine';
import { NODE_FORMATS } from '@lolly-tools/node-shell/raster';
import { assertRenderOk } from '@lolly-tools/node-shell/render-integrity';
import { repoRoot } from '@lolly-tools/node-shell/repo-root';

const REPO_ROOT = repoRoot();

/** Capabilities that only a live browser/device session can fulfil — the CLI host has
 *  no camera, mic, screen, or page-capture Chromium (smoke never launches a browser). */
const LIVE_CAPTURE_CAPS = ['capture', 'camera', 'microphone', 'screen'];

/** The slice of tool.json smoke reasons about (kept structural, like run.ts). */
export interface SmokeManifest {
  id: string;
  status?: string;
  capabilities?: string[];
  hooks?: Record<string, unknown> | null;
  render: { formats: string[] };
}

/**
 * The first declared format smoke can render without a browser (declared spelling
 * preserved — some tools say 'jpeg', none respell NODE_FORMATS, but stay tolerant).
 * null → no Node-native format at all → the caller uses the inline html fallback.
 */
export function pickSmokeFormat(formats: string[]): string | null {
  return formats.find(f => NODE_FORMATS.includes(f.toLowerCase())) ?? null;
}

/** Why a tool is skipped rather than rendered — or null when it must render (strict). */
export function skipReason(manifest: SmokeManifest, forcedFormat?: string): string | null {
  if (manifest.hooks && 'exportFile' in manifest.hooks) {
    return 'transform tool (file in → bytes out; nothing to render at defaults)';
  }
  const caps = (manifest.capabilities ?? []).filter(c => LIVE_CAPTURE_CAPS.includes(c));
  if (caps.length) return `needs ${caps.join('+')} — no headless support`;
  if (forcedFormat && !manifest.render.formats.some(f => f.toLowerCase() === forcedFormat.toLowerCase())) {
    return `does not declare "${forcedFormat}"`;
  }
  return null;
}

interface SmokeArgs {
  /** --only=id,id — smoke just these catalog tool ids. */
  only?: string;
  /** --format=svg — force one Node-native format for every tool that declares it. */
  format?: string;
  /** Row/summary sink (stdout by default) — injectable so tests don't garble TAP. */
  out?: (line: string) => void;
}

/** Run the gate. Returns the process exit code: 0 all ok, 1 any ✗, 2 bad invocation. */
export async function smokeCli({ only, format, out }: SmokeArgs = {}): Promise<number> {
  const print = out ?? ((line: string) => process.stdout.write(line));

  if (format && !NODE_FORMATS.includes(format.toLowerCase())) {
    process.stderr.write(
      `smoke is browser-free — --format must be one of: ${NODE_FORMATS.join(', ')}\n`,
    );
    return 2;
  }

  const index = JSON.parse(await readFile(join(REPO_ROOT, 'catalog', 'tools', 'index.json'), 'utf8')) as {
    tools: Array<{ id: string }>;
  };
  let ids = index.tools.map(t => t.id);
  if (only) {
    const want = only.split(',').map(s => s.trim()).filter(Boolean);
    const unknown = want.filter(id => !ids.includes(id));
    if (unknown.length) {
      process.stderr.write(`Unknown tool id(s): ${unknown.join(', ')}. Run \`lolly\` to list tools.\n`);
      return 2;
    }
    ids = want;
  }

  const outDir = await mkdtemp(join(tmpdir(), 'lolly-smoke-'));
  const idWidth = ids.reduce((w, id) => Math.max(w, id.length), 4);
  const started = Date.now();
  let ok = 0;
  let failed = 0;
  let skipped = 0;

  for (const id of ids) {
    const manifest = JSON.parse(await readFile(join(REPO_ROOT, 'tools', id, 'tool.json'), 'utf8')) as SmokeManifest;

    const reason = skipReason(manifest, format);
    if (reason) {
      skipped++;
      print(`– ${id.padEnd(idWidth)} ${'—'.padEnd(9)} skipped: ${reason}\n`);
      continue;
    }

    // Forced format is validated as declared by skipReason above; keep the declared spelling.
    const fmt = format
      ? manifest.render.formats.find(f => f.toLowerCase() === format.toLowerCase())!
      : pickSmokeFormat(manifest.render.formats);
    const outputPath = join(outDir, `${id}.${fmt ?? 'html'}`);

    // Buffer the render's own logging (runToolCli progress lines, hook console noise) so
    // the table stays a table; replay it indented only when the render fails.
    const t0 = Date.now();
    const capture = captureStdio();
    try {
      if (fmt) {
        // Lazy import: runToolCli drags in jsdom + the full bridge; a --format typo or
        // an all-skipped run shouldn't pay for it.
        const { runToolCli } = await import('./run.ts');
        await runToolCli({ toolId: id, params: {}, outputPath, format: fmt });
      } else {
        await renderHtmlHeadless(id, outputPath);
      }
      capture.restore();

      // runToolCli's browser-unavailable fallback retargets the file to .html (an
      // HTML-layout tool asked for svg, say) — report the format that was written.
      const htmlPath = outputPath.replace(/\.[^./\\]+$/, '') + '.html';
      const finalPath = existsSync(outputPath) ? outputPath : htmlPath;
      const wroteFmt = finalPath === outputPath ? (fmt ?? 'html') : `${fmt}→html`;
      const bytes = (await stat(finalPath)).size;
      ok++;
      print(`✓ ${id.padEnd(idWidth)} ${wroteFmt.padEnd(9)} ${bytes.toLocaleString()} B  ${Date.now() - t0}ms\n`);
    } catch (e) {
      capture.restore();
      failed++;
      const msg = ((e as Error).message ?? String(e)).split('\n')[0];
      print(`✗ ${id.padEnd(idWidth)} ${(fmt ?? 'html').padEnd(9)} ${msg}\n`);
      const log = capture.text().trim();
      if (log) print(log.split('\n').map(l => `    ${l}`).join('\n') + '\n');
    }
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  print(`\nsmoke: ${ok} ✓  ${failed} ✗  ${skipped} skipped  (${ids.length} tools, ${secs}s) — outputs in ${outDir}\n`);
  return failed ? 1 : 0;
}

/**
 * The html fallback for tools with NO Node-native format (their formats start pptx/
 * raster/video, and they don't declare html, so runToolCli's declared-format check
 * refuses it). Same primitives as run.ts — jsdom + the CLI bridge + brand vars +
 * hydrate + export — ending in the same assertRenderOk, so a hook failure is still ✗.
 */
async function renderHtmlHeadless(toolId: string, outputPath: string): Promise<void> {
  const jsdom = await import('jsdom');
  const dom = new jsdom.JSDOM('<!DOCTYPE html><html><body><div id="canvas"></div></body></html>');
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.Element = dom.window.Element;

  const fetchFile = async (path: string): Promise<string> => readFile(join(REPO_ROOT, 'tools', path), 'utf8');
  const tool = await loadTool(toolId, fetchFile);
  const { createCliBridge, applyBrandVars } = await import('./bridge.ts');
  // Same per-tool host.net gate as run.ts — a network-capable tool's onInit fetch
  // must pass/fail here exactly as it would on a real CLI render.
  const host = await createCliBridge({ dom, profile: {}, networkAllowlist: tool.manifest.network?.allowlist });
  const { values } = parseUrlState('', tool.manifest);
  const runtime = await createRuntime(tool, host, values);

  const canvas = dom.window.document.getElementById('canvas')!;
  await applyBrandVars(canvas, host);
  canvas.innerHTML = runtime.getHydrated();

  const blob = await runtime.export(canvas, 'html', {});
  const buf = Buffer.from(await blob.arrayBuffer());
  assertRenderOk({ hookErrors: runtime.hookErrors, format: 'html', bytes: buf });
  await writeFile(outputPath, buf);
}

/** Swap stdout/stderr writes for a buffer during one render (restore is idempotent). */
function captureStdio(): { text(): string; restore(): void } {
  const origErr = process.stderr.write.bind(process.stderr);
  const origOut = process.stdout.write.bind(process.stdout);
  let buf = '';
  const sink = (chunk: unknown): boolean => {
    buf += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  };
  process.stderr.write = sink as typeof process.stderr.write;
  process.stdout.write = sink as typeof process.stdout.write;
  return {
    text: () => buf,
    restore: () => {
      process.stderr.write = origErr;
      process.stdout.write = origOut;
    },
  };
}
