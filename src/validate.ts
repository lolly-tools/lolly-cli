// SPDX-License-Identifier: MPL-2.0
/**
 * `lolly validate <file> [--json] [--trust-anchor=<root.pem>]` —
 * on-device Content Credentials check for any stampable container (pdf,
 * png/apng, jpg, gif, svg, tiff, webp, mp4, webm).
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
import { verifyC2pa, pemToDer, c2paTrustAnchors } from '@lolly/engine';

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
  { json = false, trustAnchors }: { json?: boolean; trustAnchors?: string[] } = {},
): Promise<number> {
  // Repeatable --trust-anchor=<root.pem>: the entry point's flag parser keeps
  // only the LAST occurrence of a flag, so the raw argv is scanned here
  // instead (opts.trustAnchors — PEM file paths — overrides, for tests).
  const anchorPaths = trustAnchors
    ?? process.argv.map((a) => /^--trust-anchor=(.+)$/.exec(a)?.[1]).filter((x): x is string => Boolean(x));
  // The vendored C2PA trust list (Google/Gemini, camera makers, …) plus any
  // --trust-anchor=<root.pem> the caller pins, so recognised signers read as
  // trusted here exactly as they do in the web /valid view.
  const anchors: Uint8Array[] = [...c2paTrustAnchors()];
  for (const p of anchorPaths) anchors.push(pemToDer(await readFile(p, 'utf8')));
  const bytes = new Uint8Array(await readFile(filePath));
  const report = await verifyC2pa(bytes, { trustAnchors: anchors });

  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    const fails = report.checks.filter((c) => !c.ok && c.code !== 'signingCredential.untrusted');
    const expiredOnly = fails.length === 1 && fails[0]!.code === 'signingCredential.expired';
    const headline = report.madeWithLolly
      ? paint(GREEN, '✦ Made with Lolly') + paint(DIM, ' — credential intact, file unchanged since export')
      : report.delivered && report.trusted
        ? paint(GREEN, '◆ Delivered by Lolly') + paint(DIM, ' — verified authentic official asset; delivered by Lolly, not created by it')
      : report.likelyMadeWithLolly
        ? paint(YELLOW, '~ Likely made with Lolly') + paint(DIM, ' — the credential\'s own content checks out and records a Lolly export, but this file\'s bytes no longer match it')
      : report.partsMadeWithLolly
        ? paint(YELLOW, '~ Parts made with Lolly') + paint(DIM, ' — the intact provenance chain records Lolly steps, but the file as it stands was produced by another tool')
      : expiredOnly
        ? paint(YELLOW, '! Credential expired') + paint(DIM, ' — the file still matches what was signed; the one-year on-device certificate has lapsed')
        : {
          valid: paint(GREEN, '✓ Credential intact') + paint(DIM, ' — signed on-device (integrity, not identity)'),
          invalid: paint(RED, '✕ Credential broken') + paint(DIM, ' — the file no longer matches what was signed'),
          none: paint(DIM, '○ No Content Credentials found'),
        }[report.state];
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
  }

  return report.state === 'valid' ? 0 : report.state === 'none' ? 2 : 1;
}
