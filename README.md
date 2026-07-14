# Crush for VS Code

Syntax highlighting and compiler diagnostics for the [Crush](https://github.com/nixpt/crush-ast) language.

## What this is

- **Syntax highlighting** — a hand-written TextMate grammar (`syntaxes/crush.tmLanguage.json`)
  covering Crush's actual lexer surface: keywords, string/number literals (including
  triple-quoted strings), comments (`//` and `#`), `@lang { ... }` polyglot blocks,
  `@annotation` AI-native annotations, and capability-call syntax (`io.print(...)`,
  `fs.read(...)` — no sigil, plain dotted calls).
- **Diagnostics** — runs `crushc --message-format json --check` on open/save and surfaces
  its output as real VS Code problems (squiggles + Problems panel), rather than a hand-rolled
  parser reimplementation. `crushc` is the source of truth for what's a Crush syntax/type
  error; this extension just plumbs its existing NDJSON diagnostic format
  (`crush-lang-sdk::theme::JsonDiagnostic`) into `vscode.Diagnostic`.

## What this is not (yet)

No language server, no autocomplete, no hover, no go-to-definition. Diagnostics are a process
spawn per lint (on save by default, or on every edit if `crush.diagnostics.onChange` is
enabled), not a persistent LSP session — deliberately simple for v1. `crush-symbols`
(structural code-intel: find/callers/callees/impact/trace) is the natural foundation for a
real language server if that's wanted later; not built here.

## Requirements

`crushc` on `PATH` (or set `crush.crushcPath` to its location) for diagnostics.
Syntax highlighting works with no external dependency.

## Settings

| Setting | Default | Description |
|---|---|---|
| `crush.crushcPath` | `"crushc"` | Path to the `crushc` binary. |
| `crush.diagnostics.enable` | `true` | Run `crushc` and show its diagnostics. |
| `crush.diagnostics.onChange` | `false` | Lint on every edit instead of just on save/open. |

## Building

```bash
npm install
npm run compile
npx @vscode/vsce package   # produces crush-lang-<version>.vsix
```

Install the `.vsix` via VS Code's "Install from VSIX..." command, or `code --install-extension crush-lang-0.1.0.vsix`.

## Provenance

Not adapted from `crush-capsules/vscode-exosphere` — that extension (webview chat panel,
`exo://` virtual filesystem, Joker MCP client) has no language-tooling code at all, nothing to
reuse. Built fresh against `crush-frontend`'s actual lexer (`crates/crush-frontend/src/parser/lexer.rs`)
and `crushc`'s existing `--message-format json` diagnostic wire format, both verified against
the real compiler, not guessed from documentation.

An archived "AI Native LSP Server for Crush" was found in `exosphere-1.0.zip`
(`crates/ai/services/lsp/`) — real `tower-lsp` protocol wiring, but its actual
completion/diagnostic logic is naive string-matching (`.ends_with("fs.")`, not real parsing)
delegated to external `CSS`/`AIDA` services that don't exist in the current workspace. Not a
usable starting point as-is; the protocol-wiring shape is the only reusable part if a real LSP
is built later.

## License

Licensed under either of [MIT](LICENSE-MIT) or [Apache License 2.0](LICENSE-APACHE) at your option.
