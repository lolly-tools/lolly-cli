# lolly-cli

The headless shell. It renders any tool in the catalogue to a file without a browser, and it exists for two reasons beyond convenience: it is the proof that the engine and the tools are genuinely host-agnostic, and it is the CI smoke gate.

The design claim it defends is stated in the header of `bin/lolly.ts`: **the CLI is URL mode under a different transport.** `--foo=bar` argv pairs become the same input values the web shell parses from `?foo=bar`. The engine cannot tell which transport delivered them, so the GUI and the CLI cannot drift.

Own repo `lolly-cli`, mounted in the umbrella [`lolly`](https://github.com/lolly-tools/lolly) as a git submodule at `shells/cli/`. See the [submodule caveat](#submodule-caveat), which for this shell is sharper than usual.

## Entry point

**`bin/lolly.ts`** is the entry, declared as the `lolly` bin in `package.json` and run by Node's native TypeScript type-stripping, with no build step. It parses argv, peels off the reserved subcommands, and delegates:

| Invocation | Goes to |
|---|---|
| `lolly` | `listToolsCli()` in `src/run.ts` |
| `lolly <tool-id>` | `showToolInputsCli()` in `src/run.ts` |
| `lolly <tool-id> --foo=bar …` | `runToolCli()` in `src/run.ts` |
| `lolly validate <file>` | `src/validate.ts`, the same engine verifier the web `/verify` view uses |
| `lolly install-browser` | `src/install-browser.ts`, a one-time scoped Chromium download |
| `lolly assets [query]` | `listAssetsCli()` in `src/run.ts`, the catalogue asset listing |
| `lolly batch …` | `src/batch.ts`, a CSV/JSON multi-row run |
| `lolly smoke` | `src/smoke.ts`, renders every catalogue tool at defaults |

`src/run.ts` is the render path: build a jsdom document, load the tool, create the runtime, hydrate the template into that DOM, then export. `src/batch.ts` handles multi-row runs and `src/raster.ts` picks the raster tier.

## The bridge

**`src/bridge.ts` is one monolithic file, and that is deliberate.** The web shell splits its bridge into dozens of files with lazy facades because it has a boot budget to defend. A CLI process has no first paint, so there is nothing to defend, and a single file makes this shell readable as what it is: a complete, alternative, from-scratch implementation of the same `HostV1` contract. That the same engine and the same unmodified tools run against it is the point. Do not "improve" it by mirroring the web shell's file layout.

`createCliBridge({ dom, profile, networkAllowlist })` is async and resolves to a `HostV1` with `shell: 'cli'`. Assets come from the filesystem, reading `catalog/assets/index.json` once at startup into a `Map`. State is an in-memory `Map`, so nothing persists between invocations. `log` writes to stdout, or to stderr for `warn` and `error`.

`applyBrandVars` is also exported from here, and `shells/tui` imports `createCliBridge` directly.

### Cross-submodule dependency: this shell does not build without `shells/web`

`src/bridge.ts` imports two modules from the web shell by relative path:

```ts
import { createPdfAPI } from '../../web/src/bridge/pdf.ts';
import { svgDomToIr }   from '../../web/src/bridge/svg-ir.ts';
```

It used to import four. `net.ts` and `pptx.ts` moved to `packages/node-shell/src/`, which is where shared shell plumbing belongs, and the web bridge re-exports them from there. The remaining two cannot follow, because neither is actually DOM-free: `pdf.ts` decodes and re-encodes embedded rasters through a canvas (feature-detected, so the CLI simply skips that pass), and `svg-ir.ts` decodes `<image>` hrefs through a canvas and pulls in `font-registry.ts`, which reads IndexedDB and `document.fonts`. Both degrade gracefully under jsdom, which is why the CLI can use them at all, but a "node shell" package is the wrong home for browser canvas code.

So the consequence still holds, and is worth stating plainly: **`shells/cli` cannot be typechecked or run without `shells/web` checked out**, even though they are separate git repositories. `tsc -p shells/cli` compiles those web files too. A partial submodule checkout that omits `shells/web` breaks this shell. Closing the gap properly means splitting the DOM-optional halves of `pdf.ts` and `svg-ir.ts` out from their portable cores.

There is a second, looser dependency on the web shell, this time on its *build output*. The raster tier in `src/raster.ts` has two levels. Tier A rasterises an SVG-native tool's PNG with resvg, a few-megabyte Rust module, and needs nothing else. Tier B covers everything else, meaning HTML-layout raster, JPEG, WebP, PDF and video, by driving the **built** web shell in a scoped Chromium so the bytes match a web or desktop download exactly. `packages/node-shell/src/webshell-render.ts` serves `shells/web/dist` from an ephemeral localhost server and errors clearly when there is no `index.html` there, so Tier B needs `npm run build:web` to have run. `--durable=1` additionally needs the TrustMark encoder model inside that dist.

Everything else in the bridge comes from `@lolly/engine` and `@lolly-tools/node-shell`, the latter holding the pieces this shell shares with the TUI: `repo-root`, `raster`, `webshell-render`, `browsers`, `text` (HarfBuzz in Node), `audio`, `url-capture`, `c2pa-opts`, `render-integrity`, plus `net` and `pptx`, which the web shell shares too. Note that `bridge.ts` imports node-shell modules by **relative path** rather than by the `@lolly-tools/node-shell/*` specifier: this file is inlined into the Vercel MCP function by `scripts/build-mcp-fn.ts`, whose esbuild config treats bare package specifiers as external, so a package-specifier import would dangle in that bundle. The TUI, which is never bundled, uses the specifier form.

## Run it

From the umbrella root, no build step:

```bash
npm run cli                                              # list available tools
npm run cli -- qr-code                                   # show a tool's inputs
npm run cli -- qr-code --url=https://suse.com --output=./qr.svg
npm run cli -- qr-code --url=https://suse.com --export=png > qr.png
npm run smoke                                            # render every catalogue tool at defaults
```

`npm run cli` is `node shells/cli/bin/lolly.ts`. The `--` matters, otherwise npm eats the flags.

It reads the **active content profile's** views at the repo root, so `npm run profile` tells you which tools it can see. `lolly --help` prints the full flag set, including `--share`, `--c2pa`, `--bleed`, `--marks`, `--imprint`, `--durable`, `--press-profile`, `--link-password` and `--html-fallback`.

## Build it

There is nothing to build. Node runs the TypeScript directly. Typechecking is `tsc -p shells/cli`, part of the umbrella's `npm run typecheck`, and it compiles the two web-shell files listed above alongside this shell's own.

## Surprising things

- **`--profile` is the user-profile file, not a press condition.** The CMYK press condition is `--press-profile`. This trips people up often enough that `bin/lolly.ts` calls it out inline.
- **State does not persist.** Every invocation starts with an empty in-memory store, so there are no saved sessions here.
- **A format that cannot be produced here is an error, not a different file.** Asking for a format this shell cannot make fails with a non-zero exit and writes nothing at the requested path. It used to write HTML under a renamed output and exit 0, which meant a pipeline asking for PDF could receive HTML and never know. `--html-fallback` opts back into the HTML artifact, under a `.html` name and with a warning saying so.
- **The output is sniffed against the requested format before it is written.** Headless Chromium has no AV1 encoder, so `--export=avif` used to receive PNG bytes and write them under the `.avif` name. Bytes that are demonstrably a different container are now refused.
- **`--bleed` and `--marks` only apply to `pdf`, `pdf-cmyk` and `cmyk-tiff`.** Those are the three renderers wired to the engine's print geometry. Any other format refuses the flags rather than accepting them and producing a file identical to one exported without them.
- **A `zx=` link needs `--link-password`.** A missing or wrong password is an error. It never falls back to rendering the tool at its defaults, which would be a different document under the right filename.
- **`lolly validate` is a real verifier, not a stub.** It runs the same engine Content Credentials modules as the web `/verify` view, accepts `--trust-anchor`, and with `--deep` also does a neural pixel-watermark scan, which is Tier B and so needs the browser and the built web shell.
- **A tool ID can never be `validate`, `install-browser`, `assets`, `batch` or `smoke`.** Those five are reserved subcommands, matched before the argv is treated as a tool ID.
- Tier B's Chromium is downloaded on request by `lolly install-browser` into a scope this shell owns. It is not your system Chrome and it is not fetched implicitly on first render.

## Submodule caveat

This shell runs **inside the umbrella repo** and nowhere else. It resolves `@lolly/engine` and `@lolly-tools/node-shell` through npm workspaces declared in the umbrella's `package.json`, it reads the repo-root `catalog/` and `tools/` profile views, and as described above it imports four files out of `shells/web`.

```bash
git clone --recurse-submodules https://github.com/lolly-tools/lolly.git
# or, in an existing clone, BEFORE npm install:
git submodule update --init --recursive
```

Commit changes to files in this directory in the `lolly-cli` repo, then commit the moved pointer in the umbrella. See [`CONTRIBUTING.md`](../../CONTRIBUTING.md) §4.
