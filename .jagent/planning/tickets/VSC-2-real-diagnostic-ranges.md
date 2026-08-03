# VSC-2 — Real diagnostic ranges (post crush-ast CRUSH-74)

**Status**: Backlog — GATED on crush-ast CRUSH-74 (+ crush-lsp LSP-2) · **Priority**: P2

Squiggle accuracy is capped by crushc/crush-lsp's positions, which are capped
by crush-ast dropping source locations mid-pipeline (parser emits empty meta —
the CRUSH-74 wire). When it lands: verify the NDJSON JsonDiagnostic → 
vscode.Diagnostic plumbing surfaces real ranges end-to-end against a fixture
with errors at known positions; fix any 0:0-range assumptions baked in.

## Done
- [ ] Fixture-verified accurate squiggles via both crushc and crush-lsp paths
