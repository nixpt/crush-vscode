#!/usr/bin/env python3
"""Regenerate schemas/*.schema.json from crush-ast (CRUSH-366).

  python3 scripts/gen-schemas.py /path/to/crush-ast

CAST   <- crates/crush-cast/bindings/{Program,Function,Statement,Expression}.ts
          (the ts-rs export of the serde types, i.e. what `validate_json` accepts)
CASM   <- crates/crush-cast/SCHEMA.md (the casm::Program wire format) + the
          opcode names in crates/casm/src/lib.rs
"""
import json
import re
import sys
from pathlib import Path

root = Path(sys.argv[1])
out = Path(__file__).resolve().parent.parent / "schemas"
b = root / "crates/crush-cast/bindings"


def strip_comments(s):
    return re.sub(r"/\*.*?\*/", "", s, flags=re.S)


def split_top(s, sep):
    parts, depth, cur, i = [], 0, "", 0
    while i < len(s):
        c = s[i]
        if c in "{[<(":
            depth += 1
        elif c in "}]>)":
            depth -= 1
        if depth == 0 and s.startswith(sep, i):
            parts.append(cur)
            cur = ""
            i += len(sep)
            continue
        cur += c
        i += 1
    parts.append(cur)
    return [p.strip() for p in parts if p.strip()]


def ty(t):
    t = t.strip()
    if t == "string":
        return {"type": "string"}
    if t in ("number", "bigint"):
        return {"type": "number"}
    if t == "boolean":
        return {"type": "boolean"}
    if t == "null":
        return {"type": "null"}
    if t in ("Expression", "Statement", "CastType"):
        return {"$ref": "#/$defs/" + t}
    if t.startswith("Array<[string, CastType]>"):
        return {"type": "array", "items": {"type": "array", "prefixItems": [{"type": "string"}, {"$ref": "#/$defs/CastType"}], "minItems": 2, "maxItems": 2}}
    m = re.fullmatch(r"Array<(.*)>", t)
    if m:
        return {"type": "array", "items": ty(m.group(1))}
    if t.startswith("{ [key in string]"):
        return {"type": "object"}
    alts = split_top(t, " | ")
    if len(alts) > 1:
        return {"anyOf": [ty(a) for a in alts]}
    return {}  # a named helper type: left open


def variants(file, name):
    s = strip_comments((b / file).read_text())
    body = s[s.index(f"export type {name} =") + len(f"export type {name} ="):].strip().rstrip(";")
    out_ = []
    for v in split_top(body, " | "):
        m = re.match(r'\{ "type": "(\w+)"(.*)\}(?: & (\w+))?$', v, re.S)
        if not m:
            continue
        props = {"type": {"const": m.group(1)}}
        required = ["type"]
        for f in split_top(m.group(2).strip().lstrip(","), ","):
            fm = re.match(r"(\w+)(\?)?:\s*(.*)$", f.strip(), re.S)
            if not fm:
                continue
            props[fm.group(1)] = ty(fm.group(3))
            if not fm.group(2):
                required.append(fm.group(1))
        # Only `type` is required here: the ts-rs export marks `meta`/`type_hint`/…
        # required, but the serde types default them and the shipped examples omit
        # them (examples/cast/*.cast.json), so listing them would be a false error.
        out_.append({"type": "object", "title": m.group(1), "properties": props, "required": ["type"],
                     "x-fields": [r for r in required if r != "type"]})
    return out_


cast = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://github.com/nixpt/crush-ast/crush-cast.schema.json",
    "title": "Crush CAST program",
    "description": "CAST syntax tree (.cast.json). Generated from crush-cast's ts-rs bindings; helper types (AI nodes, manifests) are left open.",
    "type": "object",
    "required": ["cast_version", "entry", "lang", "functions"],
    "properties": {
        "cast_version": {"type": "string"},
        "entry": {"type": "string", "description": "name of the entry function"},
        "lang": {"type": ["string", "null"]},
        "functions": {"type": "object", "additionalProperties": {"$ref": "#/$defs/Function"}},
        "ai_meta": {}, "manifest": {}, "exhaustive_sites": {"type": "array"},
        "wip": {}, "temporaries": {"type": "array"}, "decisions": {"type": "array"},
    },
    "$defs": {
        "Function": {
            "type": "object",
            "required": ["body"],
            "properties": {
                "params": ty("Array<[string, CastType]>"),
                "body": {"type": "array", "items": {"$ref": "#/$defs/Statement"}},
                "meta": {"type": "object"},
                "annotations": {},
            },
        },
        "Statement": {"oneOf": variants("Statement.ts", "Statement")},
        "Expression": {"oneOf": variants("Expression.ts", "Expression")},
        "CastType": {"description": "a CastType: unit variants are strings (\"Int\"), others {\"Array\": …}", "type": ["string", "object"]},
    },
}
(out / "cast.schema.json").write_text(json.dumps(cast, indent=2) + "\n")

# ---- CASM -----------------------------------------------------------------
src = (root / "crates/casm/src/lib.rs").read_text()
# The opcode parser (`impl Instruction { fn to_opcode … match self.op.as_str()`):
# every `"name" | "alias" =>` arm; a field is required where the arm calls
# `require_field("key", …)` (optional ones use `.args.get(..).unwrap_or(..)`).
start = re.search(r'^\s+"push_int"\s*=>', src, re.M).start()
region = src[src.rfind("match", 0, start):]
arm = re.compile(r'^\s{12}((?:"[a-z_0-9]+"\s*\|?\s*)+)=>', re.M)
marks = list(arm.finditer(region))
ops, reqs = [], {}
for k, m in enumerate(marks):
    body = region[m.end(): marks[k + 1].start() if k + 1 < len(marks) else len(region)]
    if k + 1 == len(marks):
        body = body[:1500]
    names = re.findall(r'"([a-z_0-9]+)"', m.group(1))
    keys = re.findall(r'require_field\("(\w+)"', body)
    for n in names:
        ops.append(n)
        if keys:
            reqs[n] = list(dict.fromkeys(keys))
ops = sorted(set(ops))
casm = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://github.com/nixpt/crush-ast/crush-casm.schema.json",
    "title": "Crush CASM program",
    "description": "CASM IR (.casm / .sno / .casm.json), the JSON form of casm::Program. Derived from crates/crush-cast/SCHEMA.md.",
    "type": "object",
    "required": ["version", "functions"],
    "properties": {
        "version": {"type": "string", "description": "CASM format version; the major must match the runtime's"},
        "functions": {"type": "object", "additionalProperties": {"$ref": "#/$defs/Function"}},
        "manifest": {"type": "object"},
        "lang": {"type": ["string", "null"]},
    },
    "$defs": {
        "Function": {
            "type": "object",
            "required": ["body"],
            "properties": {
                "params": {"type": "array", "items": {"type": "string"}},
                "locals": {"type": "array", "items": {"type": "string"}},
                "body": {"type": "array", "items": {"$ref": "#/$defs/Instruction"}},
            },
        },
        "Instruction": {
            "type": "object",
            "required": ["op"],
            "properties": {
                "op": {"type": "string", "examples": ops, "description": "opcode name (completion list; not enforced, so a runtime-only opcode never shows a false error)"},
                "instr_lang": {"type": "string"},
                "meta": {},
            },
            "allOf": [
                {"if": {"properties": {"op": {"const": o}}, "required": ["op"]}, "then": {"required": k}}
                for o, k in sorted(reqs.items())
            ],
        },
    },
}
(out / "casm.schema.json").write_text(json.dumps(casm, indent=2) + "\n")
print(len(cast["$defs"]["Statement"]["oneOf"]), "statements,", len(cast["$defs"]["Expression"]["oneOf"]), "expressions,", len(ops), "ops,", len(reqs), "with required args")
