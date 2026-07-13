// SPDX-License-Identifier: MPL-2.0
/**
 * Thin re-export — the headless-Chromium launcher moved to @lolly-tools/node-shell
 * (shared with the TUI, one resolution order + one remediation message). Kept because
 * scripts/characterize-export.ts imports this path; new code should import the
 * package directly.
 */
export {
  INSTALL_BROWSERS_DIR, BrowserError, resolveBrowsersDir,
  getBrowser, browserInstalled, closeBrowser,
} from '@lolly-tools/node-shell/browsers';
