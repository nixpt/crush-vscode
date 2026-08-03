# VSC-1 — TextMate grammar sync vs the real lexer surface

**Status**: Backlog · **Priority**: P3

The hand-written grammar (syntaxes/crush.tmLanguage.json) tracks "Crush's
actual lexer surface" by hand — which is about to move: crush-ast CRUSH-75
makes lambda syntax (`|a, b| { }`) real and turns unknown-operator chars into
lex errors; M5 (CRUSH-27, landed) added the @annotation node set. Ticket:
(1) fixture-based grammar tests (sample .crush files + expected scopes) so
drift is visible; (2) update for lambdas when CRUSH-75 merges; (3) verify the
@annotation list matches crush-cast's actual node types, not a guess.

## Done
- [ ] Grammar fixtures in CI; lambda + annotation coverage current
