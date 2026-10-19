/**
 * A static reader for Go source: tokens, top-level declarations and the facts inside function bodies. It does not
 * type-check, resolve generics, evaluate constants or build an AST beyond what the assessment needs, and it never runs
 * the Go toolchain. What it does not understand is reported, not guessed (spec/assessment-1.md §5.2).
 */

export interface Token {
  kind: "ident" | "string" | "rune" | "number" | "punct";
  value: string;
  line: number;
  /** Last line of the token; differs from `line` only for raw strings. */
  endLine: number;
}

export class SourceSyntaxError extends Error {
  constructor(
    message: string,
    readonly line: number
  ) {
    super(message);
    this.name = "SourceSyntaxError";
  }
}

const IDENT_START = /[\p{L}_]/u;
const IDENT_PART = /[\p{L}\p{N}_]/u;
const PUNCT3 = ["...", "<<=", ">>=", "&^="];
const PUNCT2 = [":=", "==", "!=", "<=", ">=", "&&", "||", "<-", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<", ">>", "&^"];

/** Tokenizes Go source. Comments are dropped; an unterminated literal or comment is a syntax error. */
export function tokenizeGo(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r" || c === "\f" || c === "﻿") {
      i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) throw new SourceSyntaxError("unterminated block comment", line);
      for (let k = i; k < end; k++) if (text[k] === "\n") line++;
      i = end + 2;
      continue;
    }
    if (c === '"') {
      let value = "";
      let k = i + 1;
      for (;;) {
        if (k >= n || text[k] === "\n") throw new SourceSyntaxError("unterminated string literal", line);
        const d = text[k]!;
        if (d === "\\") {
          const e = text[k + 1];
          value += e === "n" ? "\n" : e === "t" ? "\t" : e === '"' ? '"' : e === "\\" ? "\\" : `\\${e ?? ""}`;
          k += 2;
          continue;
        }
        if (d === '"') break;
        value += d;
        k++;
      }
      tokens.push({ kind: "string", value, line, endLine: line });
      i = k + 1;
      continue;
    }
    if (c === "`") {
      const end = text.indexOf("`", i + 1);
      if (end < 0) throw new SourceSyntaxError("unterminated raw string literal", line);
      const value = text.slice(i + 1, end);
      const start = line;
      for (const ch of value) if (ch === "\n") line++;
      tokens.push({ kind: "string", value, line: start, endLine: line });
      i = end + 1;
      continue;
    }
    if (c === "'") {
      let k = i + 1;
      while (k < n && text[k] !== "'" && text[k] !== "\n") k += text[k] === "\\" ? 2 : 1;
      if (text[k] !== "'") throw new SourceSyntaxError("unterminated rune literal", line);
      tokens.push({ kind: "rune", value: text.slice(i + 1, k), line, endLine: line });
      i = k + 1;
      continue;
    }
    if (IDENT_START.test(c)) {
      let k = i + 1;
      while (k < n && IDENT_PART.test(text[k]!)) k++;
      tokens.push({ kind: "ident", value: text.slice(i, k), line, endLine: line });
      i = k;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(text[i + 1] ?? ""))) {
      let k = i + 1;
      while (k < n && (/[0-9A-Za-z_.]/.test(text[k]!) || ((text[k] === "+" || text[k] === "-") && /[eEpP]/.test(text[k - 1]!)))) k++;
      tokens.push({ kind: "number", value: text.slice(i, k), line, endLine: line });
      i = k;
      continue;
    }
    const three = text.slice(i, i + 3);
    const two = text.slice(i, i + 2);
    const value = PUNCT3.includes(three) ? three : PUNCT2.includes(two) ? two : c;
    tokens.push({ kind: "punct", value, line, endLine: line });
    i += value.length;
  }
  return tokens;
}

/** The generated-code marker Go tooling recognizes (`go help generate`). */
export const GENERATED_HEADER = /^\/\/ Code generated .* DO NOT EDIT\.$/m;
export function isGeneratedGo(text: string): boolean {
  // The marker must appear before the package clause.
  const pkg = text.search(/^package\s/m);
  return GENERATED_HEADER.test(pkg < 0 ? text : text.slice(0, pkg));
}

export interface GoImport {
  /** The local name: the alias, or the last path element (a guess for packages whose name differs from it). */
  name: string;
  path: string;
  line: number;
  aliased: boolean;
}

export interface GoFunction {
  name: string;
  /** Receiver type name without pointer or type parameters, for methods. */
  receiverType?: string;
  receiverName?: string;
  params: string;
  results: string;
  startLine: number;
  endLine: number;
  /** Token index range of the body, `{` … `}` inclusive; absent for a declaration without a body. */
  body?: [number, number];
}

export interface GoField {
  name: string;
  type: string;
  embedded: boolean;
  line: number;
}

export interface GoType {
  name: string;
  kind: "struct" | "interface" | "other";
  fields: GoField[];
  /** Interface method names. */
  methods: string[];
  /** Interface method signatures, parameters and results as source text. */
  signatures: Array<{ name: string; params: string; results: string }>;
  startLine: number;
  endLine: number;
}

export interface GoValueDecl {
  name: string;
  keyword: "var" | "const";
  startLine: number;
  endLine: number;
  range: [number, number];
}

export interface GoFile {
  packageName: string;
  imports: GoImport[];
  functions: GoFunction[];
  types: GoType[];
  values: GoValueDecl[];
  tokens: Token[];
}

const KEYWORDS = new Set([
  "break", "case", "chan", "const", "continue", "default", "defer", "else", "fallthrough", "for", "func", "go", "goto", "if",
  "import", "interface", "map", "package", "range", "return", "select", "struct", "switch", "type", "var"
]);

/** Index of the token closing the bracket opened at `open`. */
function matching(tokens: Token[], open: number): number {
  const opener = tokens[open]!.value;
  const closer = opener === "(" ? ")" : opener === "[" ? "]" : "}";
  let depth = 0;
  for (let k = open; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.kind !== "punct") continue;
    if (t.value === opener) depth++;
    else if (t.value === closer && --depth === 0) return k;
  }
  throw new SourceSyntaxError(`unbalanced "${opener}"`, tokens[open]!.line);
}

/** Source text of a token range, with Go's conventional spacing for type expressions. */
const text = (tokens: Token[], from: number, to: number) => {
  let out = "";
  let prev: Token | undefined;
  for (const t of tokens.slice(from, to)) {
    const value = t.kind === "string" ? JSON.stringify(t.value) : t.value;
    const tight =
      !prev ||
      ["(", "[", "]", ".", "*", "&", "..."].includes(prev.value) ||
      [")", "]", ",", ".", ";"].includes(value) ||
      ((value === "(" || value === "[") && (prev.kind === "ident" || prev.value === "]")) ||
      (value === "{" && prev.value === "struct");
    out += (tight ? "" : " ") + value;
    prev = t;
  }
  return out;
};

/** Parses the declarations of one Go file. */
export function parseGo(source: string): GoFile {
  const tokens = tokenizeGo(source);
  const file: GoFile = { packageName: "", imports: [], functions: [], types: [], values: [], tokens };
  let i = 0;
  const at = (k: number) => tokens[k];
  const is = (k: number, value: string) => at(k)?.kind === "punct" && at(k)!.value === value;
  const lineEnd = (k: number) => {
    // A top-level declaration that is not bracketed ends at the last token on its line, or at the closing bracket of any
    // bracket that starts on it.
    const line = tokens[k]!.line;
    let end = k;
    for (let m = k; m < tokens.length && tokens[m]!.line === line; m++) {
      if (tokens[m]!.kind === "punct" && ["(", "[", "{"].includes(tokens[m]!.value)) {
        m = matching(tokens, m);
      }
      end = m;
    }
    return end;
  };

  const importSpec = (k: number): number => {
    let alias: string | undefined;
    if (at(k)?.kind === "ident" || is(k, ".")) alias = tokens[k++]!.value;
    const spec = at(k);
    if (spec?.kind !== "string") throw new SourceSyntaxError("malformed import", spec?.line ?? 0);
    const last = spec.value.split("/").pop()!;
    file.imports.push({ name: alias ?? last.replace(/^go-|\.v\d+$|-go$/g, "").replace(/[-.]/g, "_"), path: spec.value, line: spec.line, aliased: alias !== undefined });
    return k + 1;
  };

  const typeSpec = (k: number): number => {
    const nameToken = at(k)!;
    let m = k + 1;
    if (is(m, "[") && at(m + 1)?.kind === "ident" && at(m + 2)?.kind !== "punct") m = matching(tokens, m) + 1; // type parameters
    if (is(m, "=")) m++;
    const kindToken = at(m);
    const type: GoType = { name: nameToken.value, kind: "other", fields: [], methods: [], signatures: [], startLine: nameToken.line, endLine: nameToken.line };
    if (kindToken?.kind === "ident" && (kindToken.value === "struct" || kindToken.value === "interface") && is(m + 1, "{")) {
      type.kind = kindToken.value;
      const close = matching(tokens, m + 1);
      type.endLine = tokens[close]!.line;
      // Members are grouped by line at depth one.
      let p = m + 2;
      while (p < close) {
        const line = tokens[p]!.line;
        const start = p;
        let q = p;
        while (q < close && tokens[q]!.line === line) {
          if (tokens[q]!.kind === "punct" && ["(", "[", "{"].includes(tokens[q]!.value)) q = matching(tokens, q);
          q++;
        }
        const member = tokens.slice(start, q).filter((t) => !(t.kind === "punct" && t.value === ";"));
        p = q;
        if (!member.length) continue;
        if (type.kind === "interface") {
          if (member[0]!.kind === "ident" && member[1]?.value === "(") {
            const close = matching(member, 1);
            type.methods.push(member[0]!.value);
            type.signatures.push({ name: member[0]!.value, params: text(member, 2, close), results: text(member, close + 1, member.length).replace(/^\((.*)\)$/, "$1") });
          }
          continue;
        }
        const withoutTag = member.at(-1)?.kind === "string" ? member.slice(0, -1) : member;
        const qualified = withoutTag.every((t, idx) => (idx === 0 && t.value === "*") || t.kind === "ident" || t.value === ".");
        const embedded = qualified && withoutTag.filter((t) => t.kind === "ident").length <= 2 && !(withoutTag.length >= 2 && withoutTag[0]!.kind === "ident" && withoutTag[1]!.kind === "ident");
        if (embedded) {
          const last = withoutTag.filter((t) => t.kind === "ident").at(-1);
          if (last) type.fields.push({ name: last.value, type: text(withoutTag, 0, withoutTag.length), embedded: true, line });
          continue;
        }
        const names: string[] = [];
        let r = 0;
        while (r < withoutTag.length && withoutTag[r]!.kind === "ident") {
          names.push(withoutTag[r]!.value);
          if (withoutTag[r + 1]?.value === ",") r += 2;
          else {
            r++;
            break;
          }
        }
        const typeText = text(withoutTag, r, withoutTag.length);
        for (const name of names) type.fields.push({ name, type: typeText, embedded: false, line });
      }
      file.types.push(type);
      return close + 1;
    }
    const end = lineEnd(k);
    type.endLine = tokens[end]!.line;
    file.types.push(type);
    return end + 1;
  };

  const valueSpec = (k: number, keyword: "var" | "const"): number => {
    const end = lineEnd(k);
    let m = k;
    while (m <= end && at(m)?.kind === "ident") {
      file.values.push({ name: tokens[m]!.value, keyword, startLine: tokens[k]!.line, endLine: tokens[end]!.line, range: [k, end] });
      if (is(m + 1, ",")) m += 2;
      else break;
    }
    return end + 1;
  };

  const grouped = (k: number, spec: (k: number) => number): number => {
    if (!is(k, "(")) return spec(k);
    const close = matching(tokens, k);
    let m = k + 1;
    while (m < close) {
      if (is(m, ";")) {
        m++;
        continue;
      }
      m = spec(m);
    }
    return close + 1;
  };

  while (i < tokens.length) {
    const t = tokens[i]!;
    if (t.kind !== "ident") {
      i++;
      continue;
    }
    switch (t.value) {
      case "package":
        file.packageName = at(i + 1)?.value ?? "";
        i += 2;
        break;
      case "import":
        i = grouped(i + 1, importSpec);
        break;
      case "type":
        i = grouped(i + 1, typeSpec);
        break;
      case "var":
      case "const": {
        const keyword = t.value;
        i = grouped(i + 1, (k) => valueSpec(k, keyword));
        break;
      }
      case "func": {
        const fn: GoFunction = { name: "", params: "", results: "", startLine: t.line, endLine: t.line };
        let k = i + 1;
        if (is(k, "(")) {
          const close = matching(tokens, k);
          const receiver = tokens.slice(k + 1, close);
          const idents = receiver.filter((r) => r.kind === "ident");
          // `(s *T)`, `(T)`, `(s *T[K])`: the type is the first identifier after the optional name.
          const bracket = receiver.findIndex((r) => r.value === "[");
          const head = bracket < 0 ? receiver : receiver.slice(0, bracket);
          const headIdents = head.filter((r) => r.kind === "ident");
          fn.receiverType = headIdents.at(-1)?.value ?? idents.at(-1)?.value;
          if (headIdents.length >= 2) fn.receiverName = headIdents[0]!.value;
          k = close + 1;
        }
        const name = at(k);
        if (name?.kind !== "ident") {
          i = k;
          break;
        }
        fn.name = name.value;
        k++;
        if (is(k, "[")) k = matching(tokens, k) + 1;
        if (!is(k, "(")) {
          i = k;
          break;
        }
        const paramsClose = matching(tokens, k);
        fn.params = text(tokens, k + 1, paramsClose);
        k = paramsClose + 1;
        const resultsStart = k;
        // Results run to the body's `{`, skipping brackets and struct/interface literal types.
        while (k < tokens.length && !is(k, "{") && tokens[k]!.line === tokens[paramsClose]!.line) {
          if (is(k, "(") || is(k, "[")) k = matching(tokens, k);
          else if ((at(k)!.value === "struct" || at(k)!.value === "interface") && is(k + 1, "{")) k = matching(tokens, k + 1);
          k++;
        }
        fn.results = text(tokens, resultsStart, k).replace(/^\((.*)\)$/, "$1");
        if (is(k, "{")) {
          const close = matching(tokens, k);
          fn.body = [k, close];
          fn.endLine = tokens[close]!.line;
          i = close + 1;
        } else {
          i = k;
        }
        file.functions.push(fn);
        break;
      }
      default:
        i++;
    }
  }
  return file;
}

export interface Call {
  /** The selector chain: `["s", "Store", "GetMemo"]` for `s.Store.GetMemo(…)`, `["f"]` for `f(…)`. */
  chain: string[];
  line: number;
}

export interface BodyFacts {
  calls: Call[];
  /** Two-element selectors that are not calls, e.g. `codes.NotFound`. */
  selectors: Call[];
  strings: Array<{ value: string; line: number; endLine: number }>;
  /** Lines of `go` statements. */
  goStatements: number[];
}

const NOT_CALLS = new Set([
  ...KEYWORDS, "append", "cap", "clear", "close", "complex", "copy", "delete", "imag", "len", "make", "max", "min", "new", "panic", "print",
  "println", "real", "recover", "bool", "byte", "error", "float32", "float64", "int", "int8", "int16", "int32", "int64", "rune", "string",
  "uint", "uint8", "uint16", "uint32", "uint64", "uintptr", "any"
]);

/** The calls, selectors, string literals and `go` statements in a token range. */
export function bodyFacts(tokens: Token[], [from, to]: [number, number]): BodyFacts {
  const facts: BodyFacts = { calls: [], selectors: [], strings: [], goStatements: [] };
  for (let k = from; k <= to; k++) {
    const t = tokens[k]!;
    if (t.kind === "string") {
      facts.strings.push({ value: t.value, line: t.line, endLine: t.endLine });
      continue;
    }
    if (t.kind !== "ident") continue;
    if (t.value === "go" && tokens[k - 1]?.value !== ".") {
      facts.goStatements.push(t.line);
      continue;
    }
    if (tokens[k - 1]?.kind === "punct" && tokens[k - 1]!.value === ".") continue; // inside a chain
    const chain = [t.value];
    let m = k + 1;
    while (tokens[m]?.value === "." && tokens[m + 1]?.kind === "ident") {
      chain.push(tokens[m + 1]!.value);
      m += 2;
    }
    if (tokens[m]?.kind === "punct" && tokens[m]!.value === "(") {
      if (!(chain.length === 1 && NOT_CALLS.has(chain[0]!))) facts.calls.push({ chain, line: t.line });
    } else if (chain.length === 2) {
      facts.selectors.push({ chain, line: t.line });
    }
    k = m - 1;
  }
  return facts;
}

/**
 * The parameter (or result) types of a signature, with names removed: `ctx context.Context, a, b int` →
 * `["context.Context", "int", "int"]`. Go requires a list to name all of its parameters or none.
 */
export function signatureTypes(list: string): string[] {
  const segments: string[] = [];
  let depth = 0;
  let current = "";
  for (const c of list) {
    if ("([{".includes(c)) depth++;
    if (")]}".includes(c)) depth--;
    if (c === "," && depth === 0) {
      segments.push(current.trim());
      current = "";
    } else current += c;
  }
  if (current.trim()) segments.push(current.trim());
  const named = segments.some((s) => /^[\p{L}_][\p{L}\p{N}_]* +\S/u.test(s));
  if (!named) return segments;
  const types: string[] = [];
  let pending = 0;
  for (const s of segments) {
    const m = s.match(/^[\p{L}_][\p{L}\p{N}_]* +(.+)$/u);
    if (!m) {
      pending++;
      continue;
    }
    for (let k = 0; k <= pending; k++) types.push(m[1]!);
    pending = 0;
  }
  return types;
}
