// SPDX-License-Identifier: MPL-2.0
/**
 * Thin re-export — the web-shell render tier moved to @lolly-tools/node-shell (shared
 * with the TUI). Kept because scripts/characterize-export.ts imports this path; new
 * code should import the package directly.
 */
export { renderViaWebShell, closeWebShell } from '@lolly-tools/node-shell/webshell-render';
export type { RenderDims } from '@lolly-tools/node-shell/webshell-render';
