# Porting conventions (Python prototype → TypeScript)

The TypeScript in `src/core/` is a line-for-line port of `prototype/wiret/*.py`. These rules
keep independently ported modules compatible with each other.

## Names
- Module `wiret/foo.py` becomes `src/core/foo.ts`. Import siblings as `./foo.js` (ESM, `.js` suffix).
- Functions, methods, fields and variables: snake_case becomes camelCase
  (`print_module` → `printModule`, `field_place` → `fieldPlace`). A leading underscore is kept:
  `_div_s` → `_divS`, `_f32` → `_f32`.
- Classes keep their names (`GraphInfo`, `ModuleIndex`). ALL_CAPS constants keep their names.
- Keep docstrings as `/** */` comments, trimmed if very long. Keep inline comments that explain why.

## Data
- `@dataclass` → a class with a positional constructor in field order, defaults as in Python
  (`new Lit("string", text)`, `new Attr("note", args)`). Mutable defaults (`field(default_factory=list)`)
  become fresh `[]` per instance. Properties (`@property`) become getters.
- `Optional[X]` → `X | null`. Python `None` → `null` (never `undefined` in data).
- Python tuples used as records → TS arrays/tuples (`[a, b]`). Tuples used as dict keys or set
  members → encode with `key(...)` from `./pyutil.js` (a stable string), since JS Maps compare
  arrays by identity.
- `dict` → `Map` when keys are not plain strings or order/`in` matters with non-string keys;
  `Record<string, T>` / plain objects only for JSON-shaped data. `set` → `Set`.
- `isinstance(x, Cls)` → `x instanceof Cls`.
- Exceptions → classes extending `Error`; `try/except E` → `catch (e) { if (!(e instanceof E)) throw e; ... }`.

## Numbers (important)
- Python `int` that can exceed 2^53 (any i64/u64 value, wrap arithmetic, `struct` 64-bit
  packing, bit tricks on 64-bit) → `bigint`. In the VM: **i64 values are `bigint`, i32 values
  are `number`**, f32/f64 are `number`, bools are i32 `0`/`1`.
- Elsewhere (indices, counts, positions, i32-range literal values) use `number`.
- Literal values in the model (`Lit("int", v)`) hold `bigint` for kind `int` (so 64-bit
  literals survive) — convert with `Number(...)` where only small values are possible.
- `//` and `%` on Python ints floor towards −∞: use `pyutil.floorDiv` / `pyutil.pyMod`.
- `round()` is banker's rounding → `pyutil.pyRound`.
- `repr(float)` / `str(float)` → `pyutil.floatRepr`; `f"{x:.{p}g}"` → `pyutil.formatG(x, p)`.
- `struct.pack/unpack` → `DataView` helpers in `pyutil` (`f32`, `f32Bits`, `f64Bits`, ...).

## Strings
- Python `len(s)` counts code points: use `pyutil.cpLen(s)`; `s.encode()` → `pyutil.utf8(s)`
  (a `Uint8Array`); `bytes.decode()` → `pyutil.fromUtf8(b)`.
- Python string slicing by index is by code point; port carefully (`Array.from(s)`) when the
  text may hold non-BMP characters, else plain `slice` is fine.
- `re` patterns usually work as JS regexes; use the `u` flag; `re.match` anchors at start
  (use `^` or a sticky `y` regex), `re.fullmatch` anchors both ends.
- `sorted(...)` with default ordering on strings compares code points: use `pyutil.cmp`
  (not `localeCompare`). `sorted` is stable, as is `Array.prototype.sort`.

## Library replacements
- `hashlib.sha256(...).hexdigest()` → `sha256Hex` (`@noble/hashes`), `zlib.compress(b, 9)` →
  `pako.deflate(b, { level: 9 })`, `difflib.SequenceMatcher` → `./difflib.js`,
  `decimal` (detmath) → `decimal.js`, `unicodedata.normalize("NFC", s)` → `s.normalize("NFC")`,
  `json.dumps` → `pyutil.jsonDumps` where byte-identical output to Python matters.
- Modules return objects, not JSON strings, where the Python returned `json.dumps(...)` only to
  cross the Pyodide boundary (webapi).
