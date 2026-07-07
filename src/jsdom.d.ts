// SPDX-License-Identifier: MPL-2.0
// jsdom ships no type declarations (no @types/jsdom); the CLI touches only the
// DOM surface JSDOM exposes, so declare exactly that. `window` is a full DOM
// Window so the engine + Handlebars type-check against lib.dom (no APIs are
// used at runtime that jsdom doesn't implement). This is an ambient module
// declaration (a non-module .d.ts), not an augmentation of the untyped package.
declare module 'jsdom' {
  export class JSDOM {
    constructor(html?: string);
    readonly window: Window & typeof globalThis;
  }
}
