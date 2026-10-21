/**
 * A reader for the part of JavaScript and TypeScript that registers HTTP routes: a tokenizer and a recognizer over its tokens.
 * It reads text only; it never runs, resolves packages or follows anything outside the repository.
 *
 * What it recognizes (and nothing else):
 * - receivers, by how they are declared: `express()`, `express.Router()`, `Router()`, `new Router()`, `fastify()`, `Fastify()`, `new Hono()`.
 *   A call such as `cache.get('key')` is not a route, because `cache` is not a receiver;
 * - routes on a receiver: `r.get('/p', ...)`, `r.route('/p').get(...).post(...)`, Fastify's `r.route({ method, url, handler })`;
 * - NestJS: `@Controller('prefix')` classes with `@Get('p')` and the like on their methods;
 * - mounts: `app.use('/prefix', ...middleware, router)`, where `router` is declared here or imported from a relative module (or a path
 *   alias the caller supplies), so a router's routes carry the prefixes that lead to it.
 *
 * What it does not do: evaluate anything. A path that is not a string, a template or a `+` of strings and names has no known value and
 * is reported as `dynamic`; a name inside a path (`/${entity}/create`) is kept as a `{entity}` placeholder, never guessed. Routes
 * registered in a loop, by a helper or by reflection are found only as far as the registration call itself is literal.
 */

export type TokenKind = "id" | "str" | "tpl" | "num" | "p" | "re";

export interface Token {
  kind: TokenKind;
  /** Identifier, punctuator or number text; a string's value; a template's raw source between the backticks. */
  value: string;
  line: number;
  endLine: number;
  /** Template literals: the source of each `${…}` expression and the text between them. */
  exprs?: string[];
  quasis?: string[];
}

export class JsSyntaxError extends Error {
  constructor(message: string, readonly line: number) {
    super(message);
    this.name = "JsSyntaxError";
  }
}

const PUNCT3 = ["...", "===", "!==", "**=", "<<=", ">>=", "&&=", "||=", "??=", ">>>"];
const PUNCT2 = ["=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "**", "<<", ">>"];
const REGEX_AFTER = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^", "=>", "&&", "||", "??", "==", "===", "!=", "!=="]);
const REGEX_AFTER_WORDS = new Set(["return", "typeof", "case", "of", "in", "delete", "void", "throw", "new", "else", "do", "yield", "await"]);

const isIdStart = (c: string) => /[A-Za-z_$\u0080-￿]/.test(c);
const isIdPart = (c: string) => /[A-Za-z0-9_$\u0080-￿]/.test(c);

/** @throws JsSyntaxError for an unterminated string, template, comment or regular expression. */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  const n = text.length;
  const last = () => tokens[tokens.length - 1];

  /** Scans a template literal starting after its opening backtick; returns the index after the closing one. */
  const template = (start: number): { end: number; exprs: string[]; quasis: string[]; lines: number } => {
    const exprs: string[] = [];
    const quasis: string[] = [];
    let k = start;
    let quasi = "";
    let lines = 0;
    while (k < n) {
      const c = text[k]!;
      if (c === "\\") {
        quasi += text.slice(k, k + 2);
        if (text[k + 1] === "\n") lines++;
        k += 2;
        continue;
      }
      if (c === "`") {
        quasis.push(quasi);
        return { end: k + 1, exprs, quasis, lines };
      }
      if (c === "$" && text[k + 1] === "{") {
        quasis.push(quasi);
        quasi = "";
        let depth = 1;
        let j = k + 2;
        const exprStart = j;
        while (j < n && depth > 0) {
          const d = text[j]!;
          if (d === "\n") lines++;
          if (d === "{") depth++;
          else if (d === "}") depth--;
          else if (d === "`") {
            const inner = template(j + 1);
            lines += inner.lines;
            j = inner.end;
            continue;
          } else if (d === '"' || d === "'") {
            j++;
            while (j < n && text[j] !== d) j += text[j] === "\\" ? 2 : 1;
          }
          j++;
        }
        if (depth > 0) throw new JsSyntaxError("unterminated ${…} in a template literal", line);
        exprs.push(text.slice(exprStart, j - 1));
        k = j;
        continue;
      }
      if (c === "\n") lines++;
      quasi += c;
      k++;
    }
    throw new JsSyntaxError("unterminated template literal", line);
  };

  while (i < n) {
    const c = text[i]!;
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r" || c === "﻿") {
      i++;
      continue;
    }
    if (c === "#" && i === 0 && text[1] === "!") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) throw new JsSyntaxError("unterminated comment", line);
      for (let k = i; k < end; k++) if (text[k] === "\n") line++;
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const start = line;
      let k = i + 1;
      let value = "";
      while (k < n && text[k] !== c) {
        if (text[k] === "\n") throw new JsSyntaxError("unterminated string", start);
        if (text[k] === "\\") {
          const next = text[k + 1] ?? "";
          if (next === "\n") line++;
          value += next === "n" ? "\n" : next === "t" ? "\t" : next;
          k += 2;
        } else value += text[k++];
      }
      if (k >= n) throw new JsSyntaxError("unterminated string", start);
      tokens.push({ kind: "str", value, line: start, endLine: line });
      i = k + 1;
      continue;
    }
    if (c === "`") {
      const start = line;
      const t = template(i + 1);
      line += t.lines;
      tokens.push({ kind: "tpl", value: text.slice(i + 1, t.end - 1), line: start, endLine: line, exprs: t.exprs, quasis: t.quasis });
      i = t.end;
      continue;
    }
    if (isIdStart(c)) {
      let k = i + 1;
      while (k < n && isIdPart(text[k]!)) k++;
      tokens.push({ kind: "id", value: text.slice(i, k), line, endLine: line });
      i = k;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(text[i + 1] ?? ""))) {
      let k = i + 1;
      while (k < n && /[0-9A-Za-z_.]/.test(text[k]!)) k++;
      tokens.push({ kind: "num", value: text.slice(i, k), line, endLine: line });
      i = k;
      continue;
    }
    if (c === "/") {
      const prev = last();
      const regex = !prev || (prev.kind === "p" && REGEX_AFTER.has(prev.value)) || (prev.kind === "id" && REGEX_AFTER_WORDS.has(prev.value));
      if (regex) {
        let k = i + 1;
        let inClass = false;
        while (k < n) {
          const d = text[k]!;
          if (d === "\n") throw new JsSyntaxError("unterminated regular expression", line);
          if (d === "\\") k += 2;
          else {
            if (d === "[") inClass = true;
            else if (d === "]") inClass = false;
            else if (d === "/" && !inClass) break;
            k++;
          }
        }
        if (k >= n) throw new JsSyntaxError("unterminated regular expression", line);
        k++;
        while (k < n && /[a-z]/.test(text[k]!)) k++;
        tokens.push({ kind: "re", value: text.slice(i, k), line, endLine: line });
        i = k;
        continue;
      }
    }
    const three = text.slice(i, i + 3);
    const two = text.slice(i, i + 2);
    const punct = PUNCT3.includes(three) ? three : PUNCT2.includes(two) ? two : c;
    tokens.push({ kind: "p", value: punct, line, endLine: line });
    i += punct.length;
  }
  return tokens;
}

// ---- recognition --------------------------------------------------------------------------------------------------

export const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options", "all"] as const;
const METHOD_SET = new Set<string>(HTTP_METHODS);
const NEST_DECORATORS: Record<string, string> = { Get: "get", Post: "post", Put: "put", Patch: "patch", Delete: "delete", Head: "head", Options: "options", All: "all" };

export type Framework = "express" | "fastify" | "koa-router" | "hono" | "nest";

/** The value a path argument has in the source, when it has one. */
export interface PathValue {
  /** The path with each name in it kept as `{name}`. Meaningless when `dynamic` is `unknown`. */
  value: string;
  /** Names that stand in the path and whose values this reader does not know (`/${entity}/list` has `entity`). */
  placeholders: string[];
  /** `known`: only literals; `placeholders`: literals and names; `unknown`: not a string, a template or a `+` of those. */
  resolution: "known" | "placeholders" | "unknown";
  /** The path as written, for citing: it occurs in the cited lines. */
  raw: string;
}

export interface Handler {
  /** What the handler argument is. */
  kind: "inline" | "reference";
  /** For a reference: `ns.name` or `name`. */
  reference?: string;
  /** A call the handler is wrapped in (`catchErrors(…)`), by its callee. */
  wrapper?: string;
  startLine: number;
  endLine: number;
  /** Request properties an inline handler reads: `body.x`, `query.y`, `params.z`. */
  reads: string[];
}

export interface Middleware {
  /** The callee or reference as written: `adminAuth.isValidAuthToken`, `singleStorageUpload(…)`. */
  text: string;
  line: number;
}

export interface RouteSite {
  receiver: string;
  framework: Framework;
  method: string;
  path: PathValue;
  startLine: number;
  endLine: number;
  middleware: Middleware[];
  handler?: Handler;
  /** The route was found in a class decorated `@Controller` (its path already includes the controller's prefix). */
  controller?: string;
}

export interface MountSite {
  receiver: string;
  prefix: PathValue;
  /** Identifier mounted: a local receiver or an imported name. */
  target: string;
  middleware: Middleware[];
  line: number;
}

export interface ImportRef {
  /** The module specifier as written. */
  specifier: string;
  /** For `const { a: b } = require('m')` or `import { a as b }`: the exported name `a`. */
  imported?: string;
}

export interface JsFile {
  receivers: Map<string, { framework: Framework; kind: "app" | "router"; line: number }>;
  routes: RouteSite[];
  mounts: MountSite[];
  imports: Map<string, ImportRef>;
  /** The receiver this module exports as a whole (`module.exports = router`, `export default router`). */
  exports?: string;
  /** Mentions of `app.use(...)`-style mounts or route calls that could not be read, with the reason. */
  unreadable: Array<{ line: number; reason: string }>;
}

const closers: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

/** Index of the token that closes the bracket at `open`, or -1. */
function matching(tokens: Token[], open: number): number {
  const stack: string[] = [];
  for (let i = open; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind !== "p") continue;
    if (closers[t.value]) stack.push(closers[t.value]!);
    else if (t.value === ")" || t.value === "]" || t.value === "}") {
      if (stack.pop() !== t.value) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

/** Splits the tokens between `open` (a bracket) and its closer into top-level, comma-separated ranges `[from, to)`. */
function splitArgs(tokens: Token[], open: number, close: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let depth = 0;
  let from = open + 1;
  for (let i = open + 1; i < close; i++) {
    const t = tokens[i]!;
    if (t.kind === "p" && closers[t.value]) depth++;
    else if (t.kind === "p" && (t.value === ")" || t.value === "]" || t.value === "}")) depth--;
    else if (t.kind === "p" && t.value === "," && depth === 0) {
      if (i > from) out.push([from, i]);
      from = i + 1;
    }
  }
  if (close > from) out.push([from, close]);
  return out;
}

const isP = (t: Token | undefined, v: string) => t?.kind === "p" && t.value === v;
const isId = (t: Token | undefined, v?: string) => t?.kind === "id" && (v === undefined || t.value === v);

/** The value of a path argument made of strings, templates and names joined by `+`. */
function pathValue(tokens: Token[], from: number, to: number): PathValue {
  let value = "";
  let raw = "";
  const placeholders: string[] = [];
  let unknown = false;
  let expectOperand = true;
  for (let i = from; i < to; i++) {
    const t = tokens[i]!;
    if (expectOperand) {
      if (t.kind === "str") {
        value += t.value;
        raw += t.value;
      } else if (t.kind === "tpl") {
        raw += t.value;
        t.quasis!.forEach((q, k) => {
          value += q;
          const e = t.exprs![k];
          if (e !== undefined) {
            const name = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(e)?.[1];
            if (name) {
              value += `{${name}}`;
              placeholders.push(name);
            } else unknown = true;
          }
        });
      } else if (t.kind === "id" && !isP(tokens[i + 1], "(") && !isP(tokens[i + 1], ".")) {
        value += `{${t.value}}`;
        raw += t.value;
        placeholders.push(t.value);
      } else unknown = true;
      expectOperand = false;
    } else if (isP(t, "+")) expectOperand = true;
    else unknown = true;
  }
  if (unknown || expectOperand) return { value: "", placeholders: [], resolution: "unknown", raw: raw || "(expression)" };
  return { value, placeholders: [...new Set(placeholders)], resolution: placeholders.length ? "placeholders" : "known", raw };
}

/** Text of a token range, for citing a middleware or callee. */
function textOf(tokens: Token[], from: number, to: number): string {
  let out = "";
  for (let i = from; i < to; i++) {
    const t = tokens[i]!;
    out += t.kind === "str" ? JSON.stringify(t.value) : t.kind === "tpl" ? `\`${t.value}\`` : t.value;
  }
  return out;
}

/** A dotted reference `a.b.c` (or `a['b']`) occupying exactly `[from, to)`. */
function reference(tokens: Token[], from: number, to: number): string | undefined {
  if (!isId(tokens[from])) return undefined;
  let out = tokens[from]!.value;
  let i = from + 1;
  while (i < to) {
    if ((isP(tokens[i], ".") || isP(tokens[i], "?.")) && isId(tokens[i + 1])) {
      out += `.${tokens[i + 1]!.value}`;
      i += 2;
    } else if (isP(tokens[i], "[") && tokens[i + 1]?.kind === "str" && isP(tokens[i + 2], "]")) {
      out += `.${tokens[i + 1]!.value}`;
      i += 3;
    } else return undefined;
  }
  return out;
}

function classify(tokens: Token[], from: number, to: number): { handler?: Handler; middleware?: Middleware } {
  const first = tokens[from]!;
  const lastLine = tokens[to - 1]!.endLine;
  // An inline function: `(a, b) => …`, `async (a) => …`, `function (a) { … }`, `a => …`.
  const head = isId(first, "async") ? from + 1 : from;
  const isFunction = isId(tokens[head], "function") || (isP(tokens[head], "(") && (() => { const close = matching(tokens, head); return close > 0 && isP(tokens[close + 1], "=>"); })()) || (isId(tokens[head]) && isP(tokens[head + 1], "=>"));
  if (isFunction) {
    const reads = new Set<string>();
    for (let i = from; i + 3 < to; i++) {
      if (isId(tokens[i]) && ["req", "request", "ctx"].includes(tokens[i]!.value) && isP(tokens[i + 1], ".") && isId(tokens[i + 2]) && ["body", "query", "params"].includes(tokens[i + 2]!.value) && isP(tokens[i + 3], ".") && isId(tokens[i + 4])) reads.add(`${tokens[i + 2]!.value}.${tokens[i + 4]!.value}`);
    }
    return { handler: { kind: "inline", startLine: first.line, endLine: lastLine, reads: [...reads].sort() } };
  }
  const ref = reference(tokens, from, to);
  if (ref) return { handler: { kind: "reference", reference: ref, startLine: first.line, endLine: lastLine, reads: [] }, middleware: { text: ref, line: first.line } };
  // A call: `callee(args)`. A wrapper when its one argument is itself a handler (`catchErrors(controller.read)`).
  const open = (() => { for (let i = from; i < to; i++) if (isP(tokens[i], "(")) return i; return -1; })();
  if (open > from && matching(tokens, open) === to - 1) {
    const callee = reference(tokens, from, open);
    const inner = splitArgs(tokens, open, to - 1);
    const text = `${callee ?? textOf(tokens, from, open)}(…)`;
    if (callee && inner.length === 1) {
      const wrapped = classify(tokens, inner[0]![0], inner[0]![1]);
      if (wrapped.handler) return { handler: { ...wrapped.handler, wrapper: callee, startLine: first.line, endLine: lastLine }, middleware: { text, line: first.line } };
    }
    return { middleware: { text, line: first.line } };
  }
  return { middleware: { text: textOf(tokens, from, Math.min(to, from + 6)), line: first.line } };
}

const RECEIVER_FACTORIES: Array<{ framework: Framework; kind: "app" | "router"; match: (t: Token[], i: number) => boolean }> = [
  { framework: "express", kind: "app", match: (t, i) => isId(t[i], "express") && isP(t[i + 1], "(") },
  { framework: "express", kind: "router", match: (t, i) => isId(t[i], "express") && isP(t[i + 1], ".") && isId(t[i + 2], "Router") },
  { framework: "express", kind: "router", match: (t, i) => isId(t[i], "Router") && isP(t[i + 1], "(") },
  { framework: "koa-router", kind: "router", match: (t, i) => isId(t[i], "new") && isId(t[i + 1], "Router") },
  { framework: "fastify", kind: "app", match: (t, i) => (isId(t[i], "fastify") || isId(t[i], "Fastify")) && isP(t[i + 1], "(") },
  { framework: "hono", kind: "app", match: (t, i) => isId(t[i], "new") && isId(t[i + 1], "Hono") }
];

export function readJs(tokens: Token[]): JsFile {
  const file: JsFile = { receivers: new Map(), routes: [], mounts: [], imports: new Map(), unreadable: [] };

  // Imports and receivers first: routes are recognized only on names declared as receivers.
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    // const x = require('m') / const { a, b: c } = require('m') / x = require('m').y
    if (isId(t) && ["const", "let", "var"].includes(t.value)) {
      let j = i + 1;
      const names: Array<{ local: string; imported?: string }> = [];
      if (isP(tokens[j], "{")) {
        const close = matching(tokens, j);
        if (close < 0) continue;
        for (const [a, b] of splitArgs(tokens, j, close)) {
          if (isId(tokens[a]) && isP(tokens[a + 1], ":") && isId(tokens[a + 2])) names.push({ local: tokens[a + 2]!.value, imported: tokens[a]!.value });
          else if (isId(tokens[a]) && b - a === 1) names.push({ local: tokens[a]!.value, imported: tokens[a]!.value });
        }
        j = close + 1;
      } else if (isId(tokens[j])) {
        names.push({ local: tokens[j]!.value });
        j++;
      } else continue;
      while (j < tokens.length && !isP(tokens[j], "=") && !isP(tokens[j], ";")) {
        // a type annotation: `const router: Router = …`
        j++;
        if (j - i > 40) break;
      }
      if (!isP(tokens[j], "=")) continue;
      j++;
      if (isId(tokens[j], "require") && isP(tokens[j + 1], "(") && tokens[j + 2]?.kind === "str") {
        const specifier = tokens[j + 2]!.value;
        for (const n of names) file.imports.set(n.local, { specifier, ...(n.imported ? { imported: n.imported } : {}) });
        // `require('express')()`, `require('fastify')({ … })` and `require('express').Router()` are factories too.
        const local = names.length === 1 && !names[0]!.imported ? names[0]!.local : undefined;
        if (local && isP(tokens[j + 4], "(") && (specifier === "express" || specifier === "fastify")) file.receivers.set(local, { framework: specifier, kind: "app", line: t.line });
        else if (local && isP(tokens[j + 4], ".") && isId(tokens[j + 5], "Router") && specifier === "express") file.receivers.set(local, { framework: "express", kind: "router", line: t.line });
        continue;
      }
      const factory = RECEIVER_FACTORIES.find((f) => f.match(tokens, j));
      if (factory && names.length === 1 && !names[0]!.imported) file.receivers.set(names[0]!.local, { framework: factory.framework, kind: factory.kind, line: t.line });
      continue;
    }
    // import x from 'm' / import { a as b } from 'm' / import * as x from 'm'
    if (isId(t, "import") && i + 1 < tokens.length && !isP(tokens[i + 1], "(") && !isP(tokens[i + 1], ".")) {
      let j = i + 1;
      const names: Array<{ local: string; imported?: string }> = [];
      if (isId(tokens[j]) && !isId(tokens[j], "type")) {
        names.push({ local: tokens[j]!.value, imported: "default" });
        j++;
        if (isP(tokens[j], ",")) j++;
      } else if (isId(tokens[j], "type")) j++;
      if (isP(tokens[j], "*") && isId(tokens[j + 1], "as") && isId(tokens[j + 2])) {
        names.push({ local: tokens[j + 2]!.value });
        j += 3;
      } else if (isP(tokens[j], "{")) {
        const close = matching(tokens, j);
        if (close < 0) continue;
        for (const [a, b] of splitArgs(tokens, j, close)) {
          if (isId(tokens[a], "type")) continue;
          if (isId(tokens[a]) && isId(tokens[a + 1], "as") && isId(tokens[a + 2])) names.push({ local: tokens[a + 2]!.value, imported: tokens[a]!.value });
          else if (isId(tokens[a]) && b - a === 1) names.push({ local: tokens[a]!.value, imported: tokens[a]!.value });
        }
        j = close + 1;
      }
      if (isId(tokens[j], "from") && tokens[j + 1]?.kind === "str") {
        const specifier = tokens[j + 1]!.value;
        for (const n of names) file.imports.set(n.local, { specifier, ...(n.imported ? { imported: n.imported } : {}) });
        if (specifier === "express") for (const n of names) if (n.imported === "Router") file.imports.set("Router", { specifier, imported: "Router" });
      }
      continue;
    }
    // module.exports = x / export default x
    if (isId(t, "module") && isP(tokens[i + 1], ".") && isId(tokens[i + 2], "exports") && isP(tokens[i + 3], "=") && isId(tokens[i + 4]) && !isP(tokens[i + 5], ".") && !isP(tokens[i + 5], "(")) file.exports = tokens[i + 4]!.value;
    if (isId(t, "export") && isId(tokens[i + 1], "default") && isId(tokens[i + 2]) && !isP(tokens[i + 3], "(") && !isP(tokens[i + 3], ".")) file.exports = tokens[i + 2]!.value;
  }
  // `Router` imported from express is a factory: `const r = Router()`.
  if (file.imports.get("Router")?.specifier === "express") {
    for (let i = 0; i + 3 < tokens.length; i++) {
      if (isId(tokens[i]) && ["const", "let", "var"].includes(tokens[i]!.value) && isId(tokens[i + 1]) && isP(tokens[i + 2], "=") && isId(tokens[i + 3], "Router") && isP(tokens[i + 4], "(")) file.receivers.set(tokens[i + 1]!.value, { framework: "express", kind: "router", line: tokens[i]!.line });
    }
  }

  // Routes, route chains and mounts.
  for (let i = 0; i + 3 < tokens.length; i++) {
    const recv = tokens[i]!;
    if (!isId(recv) || !file.receivers.has(recv.value) || !isP(tokens[i + 1], ".") || !isId(tokens[i + 2]) || !isP(tokens[i + 3], "(")) continue;
    if (i > 0 && isP(tokens[i - 1], ".")) continue; // `x.router.get(...)` is not `router.get(...)`
    const { framework } = file.receivers.get(recv.value)!;
    const verb = tokens[i + 2]!.value;
    const open = i + 3;
    const close = matching(tokens, open);
    if (close < 0) {
      file.unreadable.push({ line: recv.line, reason: `unbalanced call ${recv.value}.${verb}(` });
      continue;
    }
    const args = splitArgs(tokens, open, close);

    if (verb === "use") {
      // use([prefix,] ...middleware, target)
      let a = 0;
      let prefix: PathValue = { value: "", placeholders: [], resolution: "known", raw: "" };
      if (args[0] && (tokens[args[0][0]]!.kind === "str" || tokens[args[0][0]]!.kind === "tpl")) {
        prefix = pathValue(tokens, args[0][0], args[0][1]);
        a = 1;
      }
      const rest = args.slice(a);
      const targetArg = rest[rest.length - 1];
      if (!targetArg) continue;
      const target = reference(tokens, targetArg[0], targetArg[1]);
      // `require('./router')` mounted inline
      const inline = isId(tokens[targetArg[0]], "require") && isP(tokens[targetArg[0] + 1], "(") && tokens[targetArg[0] + 2]?.kind === "str" ? tokens[targetArg[0] + 2]!.value : undefined;
      if (!target && !inline) continue;
      const local = inline ? `require(${JSON.stringify(inline)})` : target!;
      if (inline) file.imports.set(local, { specifier: inline });
      if (!file.receivers.has(local) && !file.imports.has(local.split(".")[0]!)) continue; // `app.use(cors())`, `app.use(express.json())`
      if (target && target.includes(".") && !file.imports.has(target.split(".")[0]!)) continue;
      const middleware = rest.slice(0, -1).map(([from, to]) => classify(tokens, from, to).middleware).filter((m): m is Middleware => m !== undefined);
      file.mounts.push({ receiver: recv.value, prefix, target: local, middleware, line: recv.line });
      continue;
    }

    if (verb === "route") {
      // route('/p') then .get(h).post(h)…   |   route({ method, url, handler })
      if (framework === "fastify" || (args.length === 1 && isP(tokens[args[0]![0]], "{"))) {
        const [from, to] = args[0] ?? [0, 0];
        const props = new Map<string, [number, number]>();
        const braceClose = matching(tokens, from);
        if (isP(tokens[from], "{") && braceClose > 0) for (const [a, b] of splitArgs(tokens, from, braceClose)) if (isId(tokens[a]) && isP(tokens[a + 1], ":")) props.set(tokens[a]!.value, [a + 2, b]);
        const methodArg = props.get("method");
        const urlArg = props.get("url") ?? props.get("path");
        const handlerArg = props.get("handler");
        if (methodArg && urlArg && handlerArg && tokens[methodArg[0]]?.kind === "str") {
          const middleware = ["preHandler", "onRequest", "preValidation"].flatMap((k) => (props.has(k) ? [classify(tokens, props.get(k)![0], props.get(k)![1]).middleware] : [])).filter((m): m is Middleware => m !== undefined);
          const h = classify(tokens, handlerArg[0], handlerArg[1]).handler;
          file.routes.push({ receiver: recv.value, framework: "fastify", method: tokens[methodArg[0]]!.value.toLowerCase(), path: pathValue(tokens, urlArg[0], urlArg[1]), startLine: recv.line, endLine: tokens[close]!.endLine, middleware, ...(h ? { handler: h } : {}) });
        } else if (to > from) file.unreadable.push({ line: recv.line, reason: "route({…}) without a literal method, url and handler" });
        continue;
      }
      if (args.length !== 1) continue;
      const path = pathValue(tokens, args[0]![0], args[0]![1]);
      let k = close + 1;
      while (isP(tokens[k], ".") && isId(tokens[k + 1]) && isP(tokens[k + 2], "(")) {
        const name = tokens[k + 1]!.value;
        const cClose = matching(tokens, k + 2);
        if (cClose < 0) break;
        if (METHOD_SET.has(name)) {
          const parts = splitArgs(tokens, k + 2, cClose).map(([a, b]) => classify(tokens, a, b));
          const handler = [...parts].reverse().find((p) => p.handler)?.handler;
          const middleware = parts.filter((p) => !p.handler || p.middleware).map((p) => p.middleware).filter((m): m is Middleware => m !== undefined);
          const mids = handler ? middleware.slice(0, Math.max(0, middleware.length - 1)) : middleware;
          file.routes.push({ receiver: recv.value, framework, method: name, path, startLine: tokens[i]!.line, endLine: tokens[cClose]!.endLine, middleware: mids, ...(handler ? { handler } : {}) });
        }
        k = cClose + 1;
      }
      continue;
    }

    if (METHOD_SET.has(verb)) {
      // `app.get('setting')` reads a setting; a route has a handler.
      if (args.length < 2) continue;
      const first = tokens[args[0]![0]]!;
      if (first.kind !== "str" && first.kind !== "tpl" && first.kind !== "re" && !(first.kind === "id" && args.length >= 2)) continue;
      if (first.kind === "re") {
        file.unreadable.push({ line: recv.line, reason: `${recv.value}.${verb}(/regex/…): a path given as a regular expression is not read` });
        continue;
      }
      const path = pathValue(tokens, args[0]![0], args[0]![1]);
      const parts = args.slice(1).map(([a, b]) => classify(tokens, a, b));
      const handler = [...parts].reverse().find((p) => p.handler)?.handler;
      const handlerIndex = handler ? parts.map((p) => p.handler).lastIndexOf(handler) : -1;
      const middleware = parts.filter((_, idx) => idx !== handlerIndex).map((p) => p.middleware).filter((m): m is Middleware => m !== undefined);
      // `cache.get(key, cb)`-style calls on non-receivers never get here; on a receiver a non-literal first argument is a dynamic path.
      file.routes.push({ receiver: recv.value, framework, method: verb, path, startLine: recv.line, endLine: tokens[close]!.endLine, middleware, ...(handler ? { handler } : {}) });
    }
  }

  // NestJS controllers.
  for (let i = 0; i + 2 < tokens.length; i++) {
    if (!(isP(tokens[i], "@") && isId(tokens[i + 1], "Controller"))) continue;
    let prefix = "";
    let j = i + 2;
    if (isP(tokens[j], "(")) {
      const close = matching(tokens, j);
      if (close < 0) continue;
      const arg = tokens[j + 1];
      if (arg?.kind === "str") prefix = arg.value;
      else if (isP(arg, "{")) for (let k = j + 1; k < close; k++) if (isId(tokens[k], "path") && isP(tokens[k + 1], ":") && tokens[k + 2]?.kind === "str") prefix = tokens[k + 2]!.value;
      j = close + 1;
    }
    while (j < tokens.length && !isId(tokens[j], "class")) {
      if (isP(tokens[j], "@")) {
        // another class decorator
        const next = tokens[j + 2];
        j += isP(next, "(") ? matching(tokens, j + 2) - j + 1 : 2;
      } else j++;
      if (j - i > 200) break;
    }
    if (!isId(tokens[j], "class") || !isId(tokens[j + 1])) continue;
    const className = tokens[j + 1]!.value;
    let body = j + 2;
    while (body < tokens.length && !isP(tokens[body], "{")) body++;
    const bodyClose = matching(tokens, body);
    if (bodyClose < 0) continue;
    for (let k = body + 1; k < bodyClose; k++) {
      if (!(isP(tokens[k], "@") && isId(tokens[k + 1]) && NEST_DECORATORS[tokens[k + 1]!.value])) continue;
      const method = NEST_DECORATORS[tokens[k + 1]!.value]!;
      let sub = "";
      let m = k + 2;
      if (isP(tokens[m], "(")) {
        const close = matching(tokens, m);
        if (close < 0) continue;
        if (tokens[m + 1]?.kind === "str") sub = tokens[m + 1]!.value;
        m = close + 1;
      }
      // skip further decorators, then the method's name
      while (isP(tokens[m], "@")) m += isP(tokens[m + 2], "(") ? matching(tokens, m + 2) - m + 1 : 2;
      while (isId(tokens[m]) && ["public", "private", "protected", "async", "static"].includes(tokens[m]!.value)) m++;
      if (!isId(tokens[m]) || !isP(tokens[m + 1], "(")) continue;
      const joined = `/${[prefix, sub].map((s) => s.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/")}`;
      const endClose = matching(tokens, m + 1);
      file.routes.push({
        receiver: className,
        framework: "nest",
        method,
        path: { value: joined, placeholders: [], resolution: "known", raw: sub || prefix },
        startLine: tokens[k]!.line,
        endLine: tokens[m]!.line,
        middleware: [],
        handler: { kind: "reference", reference: `${className}.${tokens[m]!.value}`, startLine: tokens[m]!.line, endLine: endClose > 0 ? tokens[endClose]!.endLine : tokens[m]!.line, reads: [] },
        controller: className
      });
    }
  }
  file.routes.sort((a, b) => a.startLine - b.startLine || (a.method < b.method ? -1 : 1));
  return file;
}

/** Joins mount prefixes and a route path into one path: `/api` + `/login` = `/api/login`. */
export function joinPaths(...parts: string[]): string {
  const joined = parts.map((p) => p.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
  return `/${joined}`;
}

/** Express path parameters of a path: `:id`, `:settingKey?`. */
export function pathParameters(path: string): Array<{ name: string; optional: boolean }> {
  return [...path.matchAll(/:([A-Za-z_][\w]*)(\?)?/g)].map((m) => ({ name: m[1]!, optional: m[2] === "?" }));
}
