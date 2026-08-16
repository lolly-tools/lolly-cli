// SPDX-License-Identifier: MPL-2.0
/**
 * argv → flags + positionals, and the frozen vocabulary around them
 * (plans/73-cli-ga-contract.md §1.1–§1.3).
 *
 * The parser is deliberately tiny and deliberately FROZEN: `--k=v`; a bare `--k` is
 * "1"; `--k=0|false|off|no` is false; values may span newlines (a multiline longtext
 * input is one argv element and must survive intact, matching URL mode's %0A); no short
 * flags other than -h/-v; `--` ends option parsing; a repeated flag keeps the last
 * occurrence EXCEPT for the documented repeatable set, which accumulates.
 *
 * Two things that are new at GA and cannot be added later without breaking someone:
 *   • `--` - without it a longtext value beginning with `--` can never be passed.
 *   • the bare-value-flag refusal - `--output` (no `=`) parsed to "1" and wrote a file
 *     literally named `1`. Every value-taking flag now says so instead.
 */

import { usageError } from './exit-codes.ts';

export interface ParsedArgs {
  /** Last-wins flags, minus the repeatable ones. */
  flags: Record<string, string>;
  /** Repeatable flags, in order (currently only --trust-anchor). */
  repeated: Record<string, string[]>;
  /** Non-flag arguments, in order, including everything after `--`. */
  positionals: string[];
}

/** Flags that ACCUMULATE rather than last-wins. Frozen: adding one is additive. */
export const REPEATABLE = new Set(['trust-anchor']);

/**
 * Flags that must carry a value. A bare form is a usage error rather than "1".
 *
 * The list is the value-taking reserved/CLI flags a user can plausibly type. Tool
 * inputs are NOT here: a bare `--dark` meaning true is the documented boolean form.
 */
export const VALUE_FLAGS = new Set([
  'output', 'export', 'format', 'width', 'height', 'unit', 'dpi', 'depth',
  'bleed', 'marks', 'cuts', 'lang', 'filename', 'slot', 'z', 'zx',
  // `designv` takes a published version's slug or `latest`. A bare form parsing to
  // "1" would name no version, fall silently through the resolution ladder, and
  // render against a different design system under the name the author asked for.
  'designv',
  // `profile` is listed BESIDE `press-profile` because it is its frozen alias (§B1),
  // and a flag's two spellings must refuse the same things. Without it a bare
  // `--profile` parsed to "1" and handed the CMYK export a press condition literally
  // named "1", while `--press-profile` alone exited 2. Same flag, opposite answers.
  'press-profile', 'profile', 'user-profile', 'link-password', 'text', 'trust-anchor',
  // NOTE: no bare `out`. `preflight --out=` was removed before GA (§1.4) - one shell,
  // one spelling for "where output goes" per shape: `--output` for a single file,
  // `--out-dir` for a directory of them. Leaving `out` here also made a bare `--out`
  // a usage error on EVERY command, so a tool declaring a boolean input `out` could
  // never be set with the documented bare-flag form.
  'out-dir', 'only', 'type', 'require', 'template', 'password',
  // The signing identity. Both take a PATH, and a bare form must never parse to the
  // string "1" and then be reported as an unreadable file called "1". There is
  // deliberately no flag that takes the KEY or its passphrase: argv is visible in `ps`
  // to every user on the machine, kept in shell history, and echoed into CI logs.
  'sign-key', 'sign-cert',
]);

/** Subcommand words a tool id may never take (contract §1.1). `completion` is reserved
 *  now so the deferred `lolly completion <shell>` can land additively later. */
export const RESERVED_SUBCOMMANDS = [
  'list', 'describe', 'run', 'assets', 'batch', 'smoke', 'validate', 'preflight',
  'install-browser', 'completion', 'help', 'version',
] as const;

/** Global flags valid on every command (contract §1.2). */
export interface GlobalFlags {
  json: boolean;
  quiet: boolean;
  verbose: boolean;
  strict: boolean;
}

/** A bare `--flag` parses to '1'; `--flag=false|0|off|no` turns it back off. */
export function isOn(v: string | undefined): boolean {
  return v !== undefined && !/^(0|false|off|no)$/i.test(v);
}

/**
 * Parse an argv slice.
 *
 * `strictValues` gates the bare-value-flag refusal; the URL-merge path passes false,
 * because there the flags have already been through this parser once.
 */
export function parseArgs(argv: readonly string[], opts: { strictValues?: boolean } = {}): ParsedArgs {
  const flags: Record<string, string> = {};
  const repeated: Record<string, string[]> = {};
  const positionals: string[] = [];
  let optionsEnded = false;

  for (const a of argv) {
    if (optionsEnded) { positionals.push(a); continue; }
    if (a === '--') { optionsEnded = true; continue; }
    // [\s\S] (not .) so a value may span newlines.
    const m = /^--([^=]+)(?:=([\s\S]*))?$/.exec(a);
    if (!m) { positionals.push(a); continue; }
    const key = m[1]!;
    const value = m[2];
    if (opts.strictValues !== false && value === undefined && VALUE_FLAGS.has(key)) {
      throw usageError(
        `--${key} needs a value: write --${key}=<value>. A bare --${key} used to parse as the string "1" ` +
        `(which is how --output alone wrote a file called "1").`,
        'MISSING_FLAG_VALUE',
      );
    }
    if (REPEATABLE.has(key)) {
      (repeated[key] ??= []).push(value ?? '1');
      continue;
    }
    // Any OTHER flag that appears 2+ times also accumulates its full list in
    // `repeated` (seeded with the first occurrence), so a `multiple` tool input
    // (--files=a --files=b) keeps every value. `flags` still holds the last, so
    // single-valued callers are unaffected.
    if (key in flags) (repeated[key] ??= [flags[key]!]).push(value ?? '1');
    flags[key] = value ?? '1';
  }
  return { flags, repeated, positionals };
}

/** Read the global flags out of a parsed set (they are also left in `flags`, so a
 *  programmatic caller sees exactly what was typed). */
export function globalFlags(flags: Record<string, string>): GlobalFlags {
  return {
    json: isOn(flags.json),
    quiet: isOn(flags.quiet),
    verbose: isOn(flags.verbose) || Boolean(process.env.DEBUG),
    strict: isOn(flags.strict),
  };
}

/**
 * `--text=outline|live` (contract §1.3/§6a). Anything else is a usage error rather than
 * a silent "outline", because the whole point of the flag is knowing which you got.
 */
export function textMode(v: string | undefined): 'outline' | 'live' | undefined {
  if (v === undefined) return undefined;
  const s = v.trim().toLowerCase();
  if (s === 'outline' || s === '1') return 'outline';
  if (s === 'live') return 'live';
  throw usageError(`--text must be "outline" or "live" (got "${v}").`, 'BAD_FLAG_VALUE');
}

/**
 * `--password-stdin` (Docker's convention, contract B15): read the password from stdin
 * so it never appears in `ps` output or a shell history file. `--password=` stays and is
 * frozen; the two together are a usage error, because guessing which one you meant is
 * exactly the class of guess this CLI does not make.
 */
export async function resolvePassword(
  flags: Record<string, string>,
  readStdin: () => Promise<Buffer>,
): Promise<string | undefined> {
  const fromStdin = isOn(flags['password-stdin']);
  if (!fromStdin) return flags.password;
  if (flags.password !== undefined) {
    throw usageError('--password and --password-stdin cannot both be given.', 'CONFLICTING_FLAGS');
  }
  const buf = await readStdin();
  const pw = buf.toString('utf8').replace(/\r?\n$/, '');
  if (!pw) throw usageError('--password-stdin was given but stdin was empty.', 'EMPTY_STDIN');
  return pw;
}
