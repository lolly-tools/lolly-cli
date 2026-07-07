// SPDX-License-Identifier: MPL-2.0
/**
 * CLI batch — "the CLI way" of many renders from one file. A batch is a CSV/TSV whose
 * header names a `toolId` column, optional per-row output columns
 * (format/width/height/unit/dpi/filename), and one column per tool input; each data
 * row is rendered by the SAME single-render primitive the rest of the CLI uses
 * (runToolCli → URL mode), writing a sequence-numbered file into an output DIRECTORY.
 *
 * A directory (not a zip) is deliberate: the lean node CLI has no zip dependency, and
 * a directory composes with the user's own `zip`/`tar`. (The TUI's batch packs a zip —
 * same rows, a different idiomatic output per surface.)
 */
import { readFile, mkdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBatchCsv, batchCsvTemplate, loadTool } from '@lolly/engine';
import { runToolCli } from './run.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const fetchFile = (p: string): Promise<string> => readFile(join(REPO_ROOT, 'tools', p), 'utf8');
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'out';

/** Print a starter CSV grid for the given tool ids (their input columns + reserved). */
export async function batchTemplateCli(toolIds: string[]): Promise<void> {
  const tools: Array<{ id: string; inputs: Array<{ id: string }> }> = [];
  for (const raw of toolIds) {
    const id = raw.trim();
    if (!id) continue;
    try {
      const t = await loadTool(id, fetchFile);
      tools.push({ id: t.manifest.id, inputs: (t.manifest.inputs ?? []).map(i => ({ id: i.id })) });
    } catch { process.stderr.write(`Warning: unknown tool "${id}" — skipped.\n`); }
  }
  if (!tools.length) throw new Error('No known tools given. Usage: lolly batch --template=qr-code,chart-creator');
  process.stdout.write(batchCsvTemplate(tools));
}

/** Render every row of a CSV/TSV into `outDir`. Returns a process exit code. */
export async function runBatchCli(csvPath: string, opts: { outDir: string; keepGoing?: boolean }): Promise<number> {
  const text = await readFile(resolve(process.cwd(), csvPath), 'utf8');
  const rows = parseBatchCsv(text);
  if (!rows.length) {
    process.stderr.write('No batch rows found. Expected a header row with a `toolId` column, then one row per render.\n');
    return 1;
  }
  const outDir = resolve(process.cwd(), opts.outDir);
  await mkdir(outDir, { recursive: true });
  const pad = Math.max(2, String(rows.length).length);
  const formatCache = new Map<string, string>();
  const defaultFormat = async (id: string): Promise<string> => {
    const hit = formatCache.get(id);
    if (hit) return hit;
    let f = 'svg';
    try { const t = await loadTool(id, fetchFile); f = t.manifest.render.formats[0] ?? 'svg'; } catch { /* runToolCli reports */ }
    formatCache.set(id, f);
    return f;
  };

  let ok = 0, failed = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    // Per-row output settings ride in `params` as reserved keys — parseUrlState reads
    // them exactly as it would from a URL (`?width=…`), so there's one contract.
    const params = { ...row.params };
    if (row.width) params.width = String(row.width);
    if (row.height) params.height = String(row.height);
    if (row.unit) params.unit = row.unit;
    if (row.dpi) params.dpi = String(row.dpi);
    const fmt = row.format ?? await defaultFormat(row.toolId);
    const seq = String(i + 1).padStart(pad, '0');
    const base = row.filename ? slug(row.filename.replace(/\.[^.]+$/, '')) : slug(row.toolId);
    const outputPath = join(outDir, `${seq}-${base}.${fmt}`);
    try {
      await runToolCli({ toolId: row.toolId, params, outputPath, format: row.format ?? fmt });
      ok++;
    } catch (e) {
      failed++;
      process.stderr.write(`✗ row ${i + 1} (${row.toolId}): ${(e as Error).message}\n`);
      if (!opts.keepGoing) { process.stderr.write('Aborting — use --keep-going to render the rest.\n'); return 1; }
    }
  }
  process.stderr.write(`\nBatch done — ${ok} rendered${failed ? `, ${failed} failed` : ''} → ${outDir}\n`);
  return failed ? 1 : 0;
}
