// SPDX-License-Identifier: MPL-2.0
/**
 * `lolly validate <file> [--json] [--deep] [--trust-anchor=<root.pem>]` —
 * on-device Content Credentials check for any stampable container (pdf,
 * png/apng, jpg, gif, svg, tiff, webp, mp4, webm).
 *
 * `--deep` additionally runs the web shell's neural pixel-watermark scan
 * (Adobe TrustMark / Meta Content Seal, incl. Lolly's own ?durable=1 mark)
 * by driving the built dist in the scoped Chromium — the same on-device
 * decode the /valid view runs. Needs the Tier-B setup (`lolly
 * install-browser` + `npm run build:web`); everything else in this file
 * stays DOM-free and browser-free.
 *
 * The same engine verifier that backs the web shell's /valid view
 * (engine/src/c2pa-verify.js): re-checks the credential a Lolly export embeds
 * — hashed URIs, COSE claim signature, certificate window, hard binding — and
 * prints a report whose codes mirror c2patool /
 * verify.contentauthenticity.org, headlined by the question users actually
 * ask: was this genuinely made with Lolly, by whom, and where. No jsdom, no
 * network: bytes in, verdict out.
 *
 * `--trust-anchor=<root.pem>` (repeatable) pins CA roots, the same trust
 * decision as `c2patool --trust_anchors`: a signature whose x5chain verifies
 * to a pinned root reports the CA-verified identity instead of the default
 * signingCredential.untrusted.
 *
 * Exit codes: 0 = credential intact (untrusted-by-design is not a failure),
 * 1 = credential broken, 2 = no credential found.
 */

import { readFile } from 'node:fs/promises';
import { verifyC2pa, resolveVerdict, defaultTrustAnchors } from '@lolly/engine';
import type { DeepScanResult } from '@lolly-tools/node-shell/webshell-render';

const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', BOLD = '\x1b[1m', YELLOW = '\x1b[33m', RESET = '\x1b[0m';
const tty = process.stdout.isTTY;
const paint = (code: string, s: string) => (tty ? code + s + RESET : s);

// Every claim/signer string is attacker-controlled bytes from the file being
// checked. Strip control characters (incl. ESC) before printing so a crafted
// manifest can't inject ANSI sequences that forge or hide verdict lines in
// the very tool meant to be trustworthy about them.
const clean = (v: unknown) => String(v).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');

export async function validateCli(
  filePath: string,
  { json = false, deep = false, trustAnchors }: { json?: boolean; deep?: boolean; trustAnchors?: string[] } = {},
): Promise<number> {
  // Repeatable --trust-anchor=<root.pem>: the entry point's flag parser keeps
  // only the LAST occurrence of a flag, so the raw argv is scanned here
  // instead (opts.trustAnchors — PEM file paths — overrides, for tests).
  const anchorPaths = trustAnchors
    ?? process.argv.map((a) => /^--trust-anchor=(.+)$/.exec(a)?.[1]).filter((x): x is string => Boolean(x));
  // The vendored C2PA trust list (Google/Gemini, camera makers, …) plus any
  // --trust-anchor=<root.pem> the caller pins. NOTE the real policy: UNLIKE
  // the web /valid view, the CLI does NOT pin the Lolly CA root — a
  // Lolly-CA-signed export that reads "Verified" on /valid reads plain
  // "Credential intact" here unless its root is pinned by flag. Deliberate or
  // not, that split is now explicit in the engine's defaultTrustAnchors
  // (engine/src/c2pa-verdict.ts) and flagged for a product decision in
  // plans/maintainability-2026-07-18.md.
  const extra: string[] = [];
  for (const p of anchorPaths) extra.push(await readFile(p, 'utf8'));
  const anchors = defaultTrustAnchors({ includeLollyRoot: false, extra });
  const bytes = new Uint8Array(await readFile(filePath));
  const report = await verifyC2pa(bytes, { trustAnchors: anchors });

  // --deep: the neural pixel-watermark scan (Adobe TrustMark / Meta Content Seal,
  // incl. Lolly's ?durable=1 mark) — the /valid view's own decode, driven headlessly
  // via the Tier-B browser. Advisory: it never changes the exit code (a durable mark
  // is a soft binding, and its ABSENCE is never proof — per the detectors' policy).
  let deepScan: DeepScanResult | null = null;
  let deepErr: string | null = null;
  if (deep) {
    try {
      const [{ deepScanViaWebShell, closeWebShell }, { closeBrowser }] = await Promise.all([
        import('@lolly-tools/node-shell/webshell-render'),
        import('@lolly-tools/node-shell/browsers'),
      ]);
      try { deepScan = (await deepScanViaWebShell([filePath]))[0] ?? null; }
      finally { await closeWebShell(); await closeBrowser(); }
    } catch (err) {
      deepErr = (err as Error).message;
    }
  }

  if (json) {
    process.stdout.write(JSON.stringify(deep ? { ...report, deepScan, ...(deepErr ? { deepScanError: deepErr } : {}) } : report, null, 2) + '\n');
  } else {
    // The engine's shared verdict ladder (resolveVerdict, engine/src/
    // c2pa-verdict.ts) replaces the private ladder + expired-only re-derivation
    // that used to live here; the strings below are this surface's unchanged
    // rendering of each semantic state. Two deliberate CLI quirks, preserved:
    //  • partsMadeWithLolly is elevated to a headline here (resolveVerdict
    //    keeps it a flag, matching the web hero, where parts is only a
    //    scorecard pip) — it can only fire on the 'trusted'/'valid' states,
    //    exactly the rung it occupied before (after likely, before expired);
    //  • there is no separate "Verified" headline for a CA-trusted signer
    //    (the web /valid has one): 'trusted' renders as "Credential intact",
    //    with the identity shown in the facts below.
    const v = resolveVerdict(report);
    const headline = v.state === 'lolly'
      ? paint(GREEN, '✦ Made with Lolly') + paint(DIM, ' — credential intact, file unchanged since export')
      : v.state === 'delivered'
        ? paint(GREEN, '◆ Delivered by Lolly') + paint(DIM, ' — verified authentic official asset; delivered by Lolly, not created by it')
      : v.state === 'likelyLolly'
        ? paint(YELLOW, '~ Likely made with Lolly') + paint(DIM, ' — the credential\'s own content checks out and records a Lolly export, but this file\'s bytes no longer match it')
      : v.partsMadeWithLolly
        ? paint(YELLOW, '~ Parts made with Lolly') + paint(DIM, ' — the intact provenance chain records Lolly steps, but the file as it stands was produced by another tool')
      : v.state === 'expired'
        ? paint(YELLOW, '! Credential expired') + paint(DIM, ' — the file still matches what was signed; the one-year on-device certificate has lapsed')
      : v.state === 'invalid'
        ? paint(RED, '✕ Credential broken') + paint(DIM, ' — the file no longer matches what was signed')
      : v.state === 'none'
        ? paint(DIM, '○ No Content Credentials found')
        // 'valid' and 'trusted' — see the no-separate-Verified-headline note above.
        : paint(GREEN, '✓ Credential intact') + paint(DIM, ' — signed on-device (integrity, not identity)');
    process.stdout.write(`${paint(BOLD, filePath)}${report.format ? paint(DIM, `  [${report.format}]`) : ''}\n${headline}\n`);
    if (report.reason && report.state !== 'invalid') process.stdout.write(paint(DIM, `  ${clean(report.reason)}\n`));
    if (report.claim && !report.madeWithLolly) {
      process.stdout.write(paint(DIM, report.trusted
        ? '  (fields below are the CA-verified signer’s own claim)\n'
        : '  (fields below are self-asserted by whoever signed the file)\n'));
    }

    if (report.claim) {
      const c = report.claim;
      const s: Partial<NonNullable<typeof report.signer>> = report.signer || {};
      const env: Record<string, string | number | boolean> = report.environment || {};
      const signedAt = c.actions?.find((a) => a.when)?.when;
      const generator = c.generatorInfo?.name
        ? `${c.generatorInfo.name}${c.generatorInfo.version ? ' ' + c.generatorInfo.version : ''}`
        : c.claimGenerator;
      const id = report.signer?.identity;
      const facts: Array<[string, unknown]> = [
        ['Title', c.title],
        ['Identity', report.trusted && id
          && `${id.email || s.commonName}${id.issuer ? ` — verified by ${id.issuer}` : ''}`],
        ['Tool', env.tool],
        ['Produced by', report.author && `${report.author.name}${report.author.email ? ` <${report.author.email}>` : ''}`],
        [report.delivered ? 'Delivered by' : 'Made with', generator],
        ['Signed', signedAt],
        ['Where', [env.surface, env.engine, env.os].filter(Boolean).join(' · ')],
        ['Signer', s.commonName], ['Issuer', s.organization && `${s.organization}${s.selfSigned ? ' (self-signed)' : ''}`],
        ['Algorithm', s.alg], ['Manifest', c.manifestLabel],
      ];
      for (const [k, v] of facts) if (v) process.stdout.write(`  ${paint(DIM, k.padEnd(11))} ${clean(v)}\n`);
    }
    for (const chk of report.checks) {
      const mark = chk.ok ? paint(GREEN, '✓') : chk.code === 'signingCredential.untrusted' ? paint(DIM, 'ℹ') : paint(RED, '✕');
      process.stdout.write(`  ${mark} ${clean(chk.code)} ${paint(DIM, '— ' + clean(chk.explanation))}\n`);
    }
    if (deepErr) {
      process.stdout.write(paint(YELLOW, `! Deep scan unavailable`) + paint(DIM, ` — ${clean(deepErr)}\n`));
    } else if (deepScan) {
      if (!deepScan.scanned) {
        process.stdout.write(paint(DIM, `○ Deep scan: this file type can't be pixel-scanned (raster/video only)\n`));
      } else if (deepScan.lollyDurable) {
        process.stdout.write(paint(GREEN, '✦ Lolly durable mark decoded from the pixels') + paint(DIM,
          ' — a TrustMark-format identifier that survives metadata stripping and re-encoding\n'));
      } else {
        if (deepScan.trustmark) process.stdout.write(paint(YELLOW, '~ Adobe TrustMark watermark decoded') + paint(DIM, ' — embedded by another TrustMark-aware tool\n'));
        if (deepScan.contentSeal) process.stdout.write(paint(YELLOW, '~ Meta Content Seal watermark decoded\n'));
        if (!deepScan.trustmark && !deepScan.contentSeal) {
          process.stdout.write(paint(DIM, '○ Deep scan: no pixel watermark decoded (not proof of absence)\n'));
        }
      }
    }
  }

  return report.state === 'valid' ? 0 : report.state === 'none' ? 2 : 1;
}
