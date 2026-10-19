/**
 * A static reader for Protocol Buffers definitions (proto3, and proto2 syntax where it overlaps): packages, services and
 * their methods with `google.api.http` bindings, messages, fields with `google.api.field_behavior`, and enums. Options
 * other than those two are skipped; extensions, groups and custom option values are not interpreted
 * (spec/assessment-1.md §5.1).
 */
import { SourceSyntaxError } from "./go.js";

interface Tok {
  kind: "ident" | "string" | "number" | "punct";
  value: string;
  line: number;
}

function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let line = 1;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "\n") {
      line++;
      i++;
    } else if (/\s/.test(c)) {
      i++;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) throw new SourceSyntaxError("unterminated block comment", line);
      for (let k = i; k < end; k++) if (text[k] === "\n") line++;
      i = end + 2;
    } else if (c === '"' || c === "'") {
      let k = i + 1;
      let value = "";
      while (k < text.length && text[k] !== c) {
        if (text[k] === "\n") throw new SourceSyntaxError("unterminated string literal", line);
        if (text[k] === "\\") {
          value += text[k + 1] ?? "";
          k += 2;
        } else value += text[k++];
      }
      if (k >= text.length) throw new SourceSyntaxError("unterminated string literal", line);
      out.push({ kind: "string", value, line });
      i = k + 1;
    } else if (/[A-Za-z_]/.test(c)) {
      let k = i + 1;
      while (k < text.length && /[A-Za-z0-9_.]/.test(text[k]!)) k++;
      out.push({ kind: "ident", value: text.slice(i, k), line });
      i = k;
    } else if (/[0-9-]/.test(c) || (c === "." && /[0-9]/.test(text[i + 1] ?? ""))) {
      let k = i + 1;
      while (k < text.length && /[0-9A-Za-z_.+]/.test(text[k]!)) k++;
      out.push({ kind: "number", value: text.slice(i, k), line });
      i = k;
    } else {
      out.push({ kind: "punct", value: c, line });
      i++;
    }
  }
  return out;
}

export interface HttpRule {
  method: "get" | "put" | "post" | "delete" | "patch" | "custom";
  path: string;
  body?: string;
  line: number;
}

export interface ProtoMethod {
  name: string;
  /** Type references as written. */
  input: string;
  output: string;
  clientStreaming: boolean;
  serverStreaming: boolean;
  http?: HttpRule;
  /** Additional `google.api.http` bindings are counted, not interpreted. */
  additionalBindings: number;
  startLine: number;
  endLine: number;
}

export interface ProtoService {
  name: string;
  fullName: string;
  methods: ProtoMethod[];
  startLine: number;
  endLine: number;
}

export interface ProtoField {
  name: string;
  /** `json_name` if declared, else the proto3 JSON lowerCamelCase name. */
  jsonName: string;
  number: number;
  type: string;
  label: "singular" | "optional" | "repeated" | "required";
  map?: { key: string; value: string };
  oneof?: string;
  behaviors: string[];
  line: number;
}

export interface ProtoMessage {
  name: string;
  fullName: string;
  fields: ProtoField[];
  startLine: number;
  endLine: number;
}

export interface ProtoEnum {
  name: string;
  fullName: string;
  values: string[];
  startLine: number;
  endLine: number;
}

export interface ProtoFile {
  syntax?: string;
  packageName: string;
  imports: string[];
  services: ProtoService[];
  messages: ProtoMessage[];
  enums: ProtoEnum[];
}

/** proto3 JSON field name: underscores removed, following letter upper-cased. */
export const jsonName = (name: string) => name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

export function parseProto(source: string): ProtoFile {
  const t = tokenize(source);
  const file: ProtoFile = { packageName: "", imports: [], services: [], messages: [], enums: [] };
  let i = 0;
  const peek = (k = 0) => t[i + k];
  const isP = (v: string, k = 0) => peek(k)?.kind === "punct" && peek(k)!.value === v;
  const fail = (message: string): never => {
    throw new SourceSyntaxError(message, peek()?.line ?? t.at(-1)?.line ?? 0);
  };
  const expect = (v: string) => {
    if (!isP(v)) fail(`expected "${v}"`);
    return t[i++]!;
  };
  const ident = () => {
    if (peek()?.kind !== "ident") fail("expected an identifier");
    return t[i++]!;
  };
  /** A type reference, keeping a leading `.` (fully qualified). */
  const typeName = () => (isP(".") ? (i++, `.${ident().value}`) : ident().value);
  /** Skips a balanced `{…}`, `[…]` or `(…)` starting at the current token. */
  const skipBalanced = () => {
    const open = peek()!.value;
    const close = open === "{" ? "}" : open === "[" ? "]" : ")";
    let depth = 0;
    do {
      if (!peek()) fail(`unbalanced "${open}"`);
      if (isP(open)) depth++;
      else if (isP(close)) depth--;
      i++;
    } while (depth > 0);
  };
  /** Skips to and past the next `;` at this level. */
  const skipStatement = () => {
    while (peek() && !isP(";")) {
      if (isP("{") || isP("[") || isP("(")) skipBalanced();
      else i++;
    }
    if (isP(";")) i++;
  };

  /** Parses an option value `{ key: value … }` into flat string pairs, counting nested blocks by key. */
  const optionObject = () => {
    const pairs: Array<{ key: string; value: string; line: number }> = [];
    const nested: string[] = [];
    expect("{");
    while (!isP("}")) {
      if (!peek()) fail("unterminated option value");
      if (isP(",") || isP(";")) {
        i++;
        continue;
      }
      const key = ident();
      if (isP(":")) i++;
      if (isP("{")) {
        nested.push(key.value);
        skipBalanced();
      } else {
        const v = t[i++]!;
        pairs.push({ key: key.value, value: v.value, line: v.line });
      }
    }
    i++;
    return { pairs, nested };
  };

  const scopeName = (scope: string, name: string) => (scope ? `${scope}.${name}` : name);

  const enumBody = (scope: string) => {
    const start = ident().line;
    const name = ident().value;
    const e: ProtoEnum = { name, fullName: scopeName(scope, name), values: [], startLine: start, endLine: start };
    expect("{");
    while (!isP("}")) {
      if (!peek()) fail("unterminated enum");
      if (isP(";")) {
        i++;
        continue;
      }
      const head = peek()!;
      if (head.kind === "ident" && (head.value === "option" || head.value === "reserved")) {
        skipStatement();
        continue;
      }
      e.values.push(ident().value);
      skipStatement();
    }
    e.endLine = t[i++]!.line;
    file.enums.push(e);
  };

  const fieldOptions = (): { behaviors: string[]; jsonName?: string } => {
    const behaviors: string[] = [];
    let json: string | undefined;
    if (!isP("[")) return { behaviors };
    const close = (() => {
      let depth = 0;
      for (let k = i; k < t.length; k++) {
        if (t[k]!.kind === "punct" && t[k]!.value === "[") depth++;
        else if (t[k]!.kind === "punct" && t[k]!.value === "]" && --depth === 0) return k;
      }
      return fail("unbalanced \"[\"");
    })();
    for (let k = i; k < close; k++) {
      const a = t[k]!;
      if (a.kind === "ident" && a.value === "google.api.field_behavior" && t[k + 1]?.value === ")" && t[k + 2]?.value === "=") {
        const v = t[k + 3];
        if (v?.kind === "ident") behaviors.push(v.value);
      }
      if (a.kind === "ident" && a.value === "json_name" && t[k + 1]?.value === "=" && t[k + 2]?.kind === "string") json = t[k + 2]!.value;
    }
    i = close + 1;
    return { behaviors, jsonName: json };
  };

  const field = (msg: ProtoMessage, oneof?: string) => {
    const first = peek()!;
    let label: ProtoField["label"] = "singular";
    if (first.kind === "ident" && ["repeated", "optional", "required"].includes(first.value)) {
      label = first.value as ProtoField["label"];
      i++;
    }
    let type: string;
    let map: ProtoField["map"];
    if (peek()?.kind === "ident" && peek()!.value === "map" && isP("<", 1)) {
      i += 2;
      const key = ident().value;
      expect(",");
      const value = ident().value;
      expect(">");
      map = { key, value };
      type = `map<${key}, ${value}>`;
    } else {
      type = typeName();
    }
    const name = ident();
    expect("=");
    const number = Number(t[i++]?.value);
    const options = fieldOptions();
    expect(";");
    msg.fields.push({
      name: name.value,
      jsonName: options.jsonName ?? jsonName(name.value),
      number,
      type,
      label,
      ...(map ? { map } : {}),
      ...(oneof ? { oneof } : {}),
      behaviors: options.behaviors.sort(),
      line: name.line
    });
  };

  const messageBody = (scope: string) => {
    const start = ident().line;
    const name = ident().value;
    const msg: ProtoMessage = { name, fullName: scopeName(scope, name), fields: [], startLine: start, endLine: start };
    expect("{");
    while (!isP("}")) {
      const head = peek();
      if (!head) fail("unterminated message");
      if (isP(";")) {
        i++;
        continue;
      }
      switch (head!.value) {
        case "message":
          messageBody(msg.fullName);
          break;
        case "enum":
          enumBody(msg.fullName);
          break;
        case "oneof": {
          i++;
          const group = ident().value;
          expect("{");
          while (!isP("}")) {
            if (!peek()) fail("unterminated oneof");
            if (peek()!.value === "option") skipStatement();
            else if (isP(";")) i++;
            else field(msg, group);
          }
          i++;
          break;
        }
        case "option":
        case "reserved":
        case "extensions":
          skipStatement();
          break;
        case "extend":
          i++;
          ident();
          skipBalanced();
          break;
        default:
          field(msg);
      }
    }
    msg.endLine = t[i++]!.line;
    file.messages.push(msg);
  };

  const serviceBody = () => {
    const start = ident().line;
    const name = ident().value;
    const service: ProtoService = { name, fullName: scopeName(file.packageName, name), methods: [], startLine: start, endLine: start };
    expect("{");
    while (!isP("}")) {
      const head = peek();
      if (!head) fail("unterminated service");
      if (isP(";")) {
        i++;
        continue;
      }
      if (head!.value !== "rpc") {
        skipStatement();
        continue;
      }
      const rpcLine = t[i++]!.line;
      const methodName = ident().value;
      expect("(");
      let clientStreaming = false;
      if (peek()?.value === "stream" && (peek(1)?.kind === "ident" || isP(".", 1))) {
        clientStreaming = true;
        i++;
      }
      const input = typeName();
      expect(")");
      if (peek()?.value !== "returns") fail("expected \"returns\"");
      i++;
      expect("(");
      let serverStreaming = false;
      if (peek()?.value === "stream" && (peek(1)?.kind === "ident" || isP(".", 1))) {
        serverStreaming = true;
        i++;
      }
      const output = typeName();
      expect(")");
      const method: ProtoMethod = { name: methodName, input, output, clientStreaming, serverStreaming, additionalBindings: 0, startLine: rpcLine, endLine: rpcLine };
      if (isP("{")) {
        i++;
        while (!isP("}")) {
          if (!peek()) fail("unterminated rpc options");
          if (peek()!.value === "option" && isP("(", 1) && peek(2)?.value === "google.api.http" && isP(")", 3) && isP("=", 4)) {
            i += 5;
            const { pairs, nested } = optionObject();
            const verb = pairs.find((p) => ["get", "put", "post", "delete", "patch"].includes(p.key));
            const body = pairs.find((p) => p.key === "body");
            if (verb) method.http = { method: verb.key as HttpRule["method"], path: verb.value, ...(body ? { body: body.value } : {}), line: verb.line };
            else if (nested.includes("custom")) method.http = { method: "custom", path: "", line: rpcLine };
            method.additionalBindings = nested.filter((n) => n === "additional_bindings").length;
            if (isP(";")) i++;
          } else skipStatement();
        }
        method.endLine = t[i++]!.line;
      } else expect(";");
      service.methods.push(method);
    }
    service.endLine = t[i++]!.line;
    file.services.push(service);
  };

  while (i < t.length) {
    const head = peek()!;
    if (isP(";")) {
      i++;
      continue;
    }
    switch (head.value) {
      case "syntax":
      case "edition":
        i += 2;
        file.syntax = peek()?.value;
        skipStatement();
        break;
      case "package":
        i++;
        file.packageName = ident().value;
        expect(";");
        break;
      case "import":
        i++;
        if (peek()?.value === "public" || peek()?.value === "weak") i++;
        file.imports.push(t[i++]!.value);
        expect(";");
        break;
      case "option":
        skipStatement();
        break;
      case "message":
        messageBody(file.packageName);
        break;
      case "enum":
        enumBody(file.packageName);
        break;
      case "service":
        serviceBody();
        break;
      case "extend":
        i++;
        ident();
        skipBalanced();
        break;
      default:
        fail(`unexpected "${head.value}"`);
    }
  }
  return file;
}

/** Resolves a type reference as written inside `scope` (a package or message full name), per protobuf scoping rules. */
export function resolveProtoType(reference: string, scope: string, known: (fullName: string) => boolean): string | undefined {
  if (reference.startsWith(".")) return known(reference.slice(1)) ? reference.slice(1) : undefined;
  const parts = scope ? scope.split(".") : [];
  for (let k = parts.length; k >= 0; k--) {
    const candidate = [...parts.slice(0, k), reference].join(".");
    if (known(candidate)) return candidate;
  }
  return undefined;
}
