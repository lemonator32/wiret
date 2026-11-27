"""Writes test/golden/*.json: what the Python prototype produces for every content file, so
the TypeScript tests can check the port gives the same text, bytes and results.
  python scripts/golden.py   (run from app/)"""
import json, os, sys, base64
HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(APP, "..", "prototype"))
from wiret.parser import parse, ParseError

def files():
    for d in ("std", "lessons", "examples"):
        for name in sorted(os.listdir(os.path.join(APP, "content", d))):
            if name.endswith(".wiret"):
                with open(os.path.join(APP, "content", d, name), encoding="utf-8") as f:
                    yield f"{d}/{name}", f.read()

def edit_requests(m):
    """[graph, kind, request]: every canvas edit and menu the page can ask for on every node
    and input, except the ones that make a node with a random id."""
    from wiret.registry import ModuleIndex, signature
    idx = ModuleIndex(m)
    for g in m.graphs():
        yield g.name, "menu", {"kind": "canvas", "x": 0, "y": 0}
        for n in g.nodes:
            sig = signature(n, g, idx)
            yield g.name, "menu", {"kind": "node", "node": n.id}
            for op in ({"op": "delete", "node": n.id}, {"op": "toggle_attr", "node": n.id, "name": "disabled"},
                       {"op": "rename", "node": n.id, "text": "zz"}, {"op": "toggle_flat", "node": n.id},
                       {"op": "add_pin", "node": n.id}, {"op": "move", "moves": [[n.id, 5.4, 7.6]]},
                       {"op": "label", "node": n.id, "text": "L"}, {"op": "color", "node": n.id, "text": "#abcdef"},
                       {"op": "int_attr", "node": n.id, "name": "count", "text": "3"},
                       {"op": "add_note", "on": n.id, "text": "a note"}):
                yield g.name, "edit", op
            for p in sig.inputs:
                yield g.name, "menu", {"kind": "pin", "node": n.id, "dir": "in", "pin": p.name}
                yield g.name, "prompt", [n.id, p.name]
                for op in ({"op": "disconnect", "node": n.id, "dir": "in", "pin": p.name},
                           {"op": "literal", "node": n.id, "pin": p.name, "text": "1"},
                           {"op": "literal", "node": n.id, "pin": p.name, "text": ""},
                           {"op": "literal", "node": n.id, "pin": p.name, "text": "hi there", "verbatim": True},
                           {"op": "toggle", "node": n.id, "pin": p.name},
                           {"op": "remove_pin", "node": n.id, "pin": p.name}):
                    yield g.name, "edit", op
            for p in sig.outputs:
                yield g.name, "menu", {"kind": "pin", "node": n.id, "dir": "out", "pin": p.name}
                yield g.name, "edit", {"op": "disconnect", "node": n.id, "dir": "out", "pin": p.name}
                yield g.name, "edit", {"op": "remove_pin", "node": n.id, "pin": p.name}


def edit_cases(text, m):
    from wiret import webapi
    for graph, kind, req in edit_requests(m):
        if kind == "menu":
            r = webapi.menu(text, graph, json.dumps(req))
        elif kind == "prompt":
            r = webapi.literal_prompt(text, graph, *req)
        else:
            r = webapi.edit(text, graph, json.dumps(req))
            d = json.loads(r)
            if "text" in d:             # the new text by its hash, to keep the fixture small
                import hashlib
                d["text"] = hashlib.sha256(d["text"].encode()).hexdigest()
            r = json.dumps(d)
        yield [graph, kind, req], r


def main(which):
    out = {}
    for name, text in files():
        entry = {}
        m = parse(text)
        if "print" in which:
            from wiret.printer import print_module, semantic_hash, layout_hash
            entry["canonical"] = print_module(m)
            entry["semantic_hash"] = semantic_hash(m)
            entry["layout_hash"] = layout_hash(m)
        if "check" in which:
            from wiret.compiler import compile_module
            r = compile_module(parse(text), text)
            entry["diags"] = [[d.severity, d.code, str(d)] for d in r.diags]
            if r.ok:
                entry["wbc"] = base64.b64encode(r.wbc).decode()
            rd = compile_module(parse(text), text, debug=True, export_all=True)
            if rd.ok:
                entry["wbc_debug"] = base64.b64encode(rd.wbc).decode()
        if "run" in which:
            from wiret import webapi
            entry["run"] = json.loads(webapi.run(text, "Main"))
            entry["run_det"] = json.loads(webapi.run(text, "Main", deterministic=True))
        if "web" in which:
            from wiret import webapi
            entry["check_json"] = json.loads(webapi.check(text))
            entry["debug_run"] = json.loads(webapi.debug_run(text, "Main"))
        if "disasm" in which:
            from wiret.compiler import compile_module
            from wiret.disasm import disassemble
            r = compile_module(parse(text), text)
            if r.ok:
                entry["disasm"] = disassemble(r.wbc)
        if "edits" in which and not name.startswith("std/"):
            entry["edits"] = [[req, json.loads(r)] for req, r in edit_cases(text, m)]
        out[name] = entry
    with open(os.path.join(APP, "test", "golden", f"{which}.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(out, f, indent=1, sort_keys=True)
    print(f"wrote test/golden/{which}.json")

if __name__ == "__main__":
    for w in sys.argv[1:] or ["print"]:
        main(w)
