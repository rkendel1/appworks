/**
 * Existing-application assessment: reads a repository statically and produces an `appport.application-assessment/1`
 * artifact (spec/assessment-1.md). Reads only; never writes, executes or fetches.
 */
import { randomUUID } from "node:crypto";
import { basename, posix } from "node:path";
import { isValidName, type CapabilityEffect } from "@appport/protocol";
import {
  ASSESSMENT_FORMAT,
  BLOCKING_CONCERNS,
  SCANNER_VERSION,
  TOOL_NAME,
  TOOL_VERSION,
  assessmentDigest,
  evidenceId,
  type ApplicationAssessment,
  type AssessmentConfiguration,
  type Candidate,
  type Coverage,
  type CriterionResult,
  type Evidence,
  type Finding,
  type Inventory,
  type Location,
  type MessageShape,
  type Question,
  type ReadinessClass,
  type Recommendation
} from "./artifact.js";
import { DEFAULT_EXCLUDED_DIRECTORIES, DEFAULT_MAX_FILE_BYTES, gitIdentity, readRepositoryFile, repositoryRoot, walkRepository, type SkipReason } from "./files.js";
import { SourceSyntaxError, bodyFacts, isGeneratedGo, parseGo, signatureTypes, type BodyFacts, type GoFile, type GoFunction, type GoType, type Token } from "./go.js";
import { messageSchema, proposeCapabilityName, type ProtoIndex } from "./proposal.js";
import { parseProto, type ProtoService } from "./proto.js";

export interface AssessOptions {
  maxFileBytes?: number;
  excludedDirectories?: readonly string[];
  maxCallDepth?: number;
  maxReachableFunctions?: number;
  smallSurface?: { maxHandlerLines: number; maxReachableFunctions: number };
  /** Volatile metadata sources, for tests. They do not affect the digest. */
  now?: () => Date;
  id?: () => string;
}

export const DEFAULTS = {
  maxCallDepth: 12,
  maxReachableFunctions: 400,
  smallSurface: { maxHandlerLines: 80, maxReachableFunctions: 60 }
} as const;

/** Source languages the assessment recognizes by extension. Only `go` and `protobuf` are analyzed. */
const LANGUAGES: Record<string, string> = {
  ".go": "go", ".proto": "protobuf", ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript", ".js": "javascript",
  ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".py": "python", ".java": "java", ".kt": "kotlin", ".rb": "ruby", ".rs": "rust",
  ".php": "php", ".cs": "csharp", ".swift": "swift", ".scala": "scala", ".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp", ".hpp": "cpp",
  ".vue": "vue", ".svelte": "svelte", ".dart": "dart", ".ex": "elixir", ".exs": "elixir"
};
const SUPPORTED = new Set(["go", "protobuf"]);

export const LIMITATIONS: ReadonlyArray<{ code: string; description: string }> = [
  { code: "static-only", description: "Nothing in the target was built, executed or contacted; behavior is described from source text, never observed at run time." },
  { code: "languages", description: "Only Go and Protocol Buffers are analyzed. go.mod and package.json are read as manifests. Files in other languages are counted and reported, not analyzed." },
  { code: "generated-code", description: "Files marked `Code generated … DO NOT EDIT.` are skipped. Dispatch from generated stubs to handwritten handlers is not traced; it is inferred from method name and request type." },
  { code: "middleware", description: "Interceptors, middleware and server options that wrap handlers (authentication, rate limits, logging) are not attributed to candidates." },
  { code: "dynamic-dispatch", description: "Calls through local variables, closures, function-typed fields, reflection and method values are counted, not followed. Interface calls are attributed to same-name methods, in the interface's package or packages importing it, whose parameter and result types match textually; full method sets are not compared, and implementations elsewhere are not found." },
  { code: "persistence", description: "Persistence is recognized by SQL string literals that begin with a statement keyword. ORMs, query builders, key-value stores and statements assembled without such a literal are not recognized." },
  { code: "field-behavior", description: "`google.api.field_behavior` REQUIRED and OUTPUT_ONLY are declarations; whether a handler enforces them is not established." },
  { code: "names", description: "Names and comments link declarations (RPC to handler, test to method) and nothing more; they are never evidence of what code does." },
  { code: "ignore-rules", description: "Only the repository's root .gitignore is read, and only a subset of its syntax; patterns outside the subset are reported and not applied." }
];

interface FuncRef {
  key: string;
  dir: string;
  path: string;
  symbol: string;
  fn: GoFunction;
  file: GoFile;
}

interface GoPackage {
  dir: string;
  name: string;
  functions: Map<string, FuncRef>;
  types: Map<string, { type: GoType; path: string }>;
  importers: Set<string>;
}

interface FunctionFacts {
  denials: string[];
  rejections: string[];
  persistence: Array<{ operation: "read" | "write" | "unknown"; statement: string; evidence: string }>;
  outboundHttp: string[];
  async: string[];
}

const CODE_PACKAGES: Record<string, { denial: string[]; rejection: string[] }> = {
  "google.golang.org/grpc/codes": { denial: ["Unauthenticated", "PermissionDenied"], rejection: ["InvalidArgument"] },
  "connectrpc.com/connect": { denial: ["CodeUnauthenticated", "CodePermissionDenied"], rejection: ["CodeInvalidArgument"] },
  "net/http": { denial: ["StatusUnauthorized", "StatusForbidden"], rejection: ["StatusBadRequest", "StatusUnprocessableEntity"] }
};
const HTTP_CLIENT = new Set(["Get", "Post", "Head", "PostForm", "NewRequest", "NewRequestWithContext"]);
const SQL = /^\s*(SELECT|INSERT|UPDATE|DELETE|REPLACE|UPSERT|MERGE|WITH)\s/;

const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const uniqueSorted = (values: Iterable<string>) => [...new Set(values)].sort(order);
const dirOf = (path: string) => posix.dirname(path);

/** Assesses the repository at `path`. Throws `RepositoryError` for a path that is not a readable directory. */
export function assessRepository(path: string, options: AssessOptions = {}): ApplicationAssessment {
  const root = repositoryRoot(path);
  const configuration: AssessmentConfiguration = {
    scanner: SCANNER_VERSION,
    maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    excludedDirectories: [...(options.excludedDirectories ?? DEFAULT_EXCLUDED_DIRECTORIES)].sort(order),
    maxCallDepth: options.maxCallDepth ?? DEFAULTS.maxCallDepth,
    maxReachableFunctions: options.maxReachableFunctions ?? DEFAULTS.maxReachableFunctions,
    smallSurface: { ...(options.smallSurface ?? DEFAULTS.smallSurface) }
  };
  const walk = walkRepository(root, { maxFileBytes: configuration.maxFileBytes, excludedDirectories: configuration.excludedDirectories });

  // ---- evidence ----
  const evidence = new Map<string, Evidence>();
  const record = (e: Omit<Evidence, "id">): string => {
    const clean = Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0))) as Omit<Evidence, "id">;
    const id = evidenceId(clean);
    if (!evidence.has(id)) evidence.set(id, { id, ...clean });
    return id;
  };
  const at = (path: string, startLine: number, endLine = startLine): Location => ({ path, startLine, endLine });
  const findings: Finding[] = [];
  const skipped: Array<{ path: string; reason: SkipReason }> = [...walk.skipped];
  const malformed: Coverage["malformed"] = [];
  const languageCounts = new Map<string, number>();

  // ---- read sources ----
  const read = (path: string): string | undefined => {
    try {
      return readRepositoryFile(root, path);
    } catch {
      skipped.push({ path, reason: "unreadable" });
      return undefined;
    }
  };
  const goFiles: Array<{ path: string; file: GoFile; test: boolean }> = [];
  const protoFiles: Array<{ path: string; file: ReturnType<typeof parseProto> }> = [];
  const modules: Array<{ path: string; module: string; dir: string }> = [];
  const manifests: Inventory["manifests"] = [];
  const integrations: Inventory["integrations"] = [];
  let analyzed = 0;
  let targetName: { name: string; source: ApplicationAssessment["target"]["nameSource"] } | undefined;

  for (const { path } of walk.files) {
    const name = posix.basename(path);
    const extension = posix.extname(path);
    const language = LANGUAGES[extension];
    if (language) languageCounts.set(language, (languageCounts.get(language) ?? 0) + 1);
    if (name === "go.mod") {
      const text = read(path);
      if (text === undefined) continue;
      analyzed++;
      const lines = text.split("\n");
      const moduleLine = lines.findIndex((l) => /^module\s+\S+/.test(l));
      if (moduleLine < 0) {
        malformed.push({ path, line: 1, message: "no module directive" });
        continue;
      }
      const module = lines[moduleLine]!.trim().split(/\s+/)[1]!.replace(/^"|"$/g, "");
      const moduleEvidence = record({ class: "observed", kind: "go.module", location: at(path, moduleLine + 1), subject: module, observation: `go.mod declares module ${module}`, method: "manifest-parse" });
      modules.push({ path, module, dir: dirOf(path) });
      manifests.push({ path, kind: "go.mod", name: module, evidence: [moduleEvidence] });
      if (dirOf(path) === "." && !targetName) targetName = { name: module.split("/").pop()!, source: "go.mod" };
      let block = false;
      lines.forEach((raw, k) => {
        const l = raw.replace(/\/\/.*$/, "").trim();
        const indirect = raw.includes("// indirect");
        if (/^require\s*\($/.test(l)) block = true;
        else if (block && l === ")") block = false;
        else {
          const m = block ? l.match(/^(\S+)\s+(\S+)$/) : l.match(/^require\s+(\S+)\s+(\S+)$/);
          if (m && !indirect)
            integrations.push({ kind: "module-dependency", subject: `${m[1]}@${m[2]}`, evidence: [record({ class: "observed", kind: "go.require", location: at(path, k + 1), subject: m[1]!, observation: `go.mod requires ${m[1]} ${m[2]}`, method: "manifest-parse" })] });
        }
      });
      continue;
    }
    if (name === "package.json") {
      const text = read(path);
      if (text === undefined) continue;
      try {
        const manifest = JSON.parse(text) as { name?: unknown };
        analyzed++;
        const lineNo = text.split("\n").findIndex((l) => /"name"\s*:/.test(l));
        const pkgName = typeof manifest.name === "string" ? manifest.name : undefined;
        const ev = pkgName && lineNo >= 0 ? [record({ class: "observed", kind: "npm.package", location: at(path, lineNo + 1), subject: pkgName, observation: `package.json names the package ${pkgName}`, method: "manifest-parse" })] : [];
        manifests.push({ path, kind: "package.json", ...(pkgName ? { name: pkgName } : {}), evidence: ev });
        if (dirOf(path) === "." && pkgName && !targetName) targetName = { name: pkgName, source: "package.json" };
      } catch (error) {
        malformed.push({ path, line: 1, message: `invalid JSON: ${(error as Error).message.split("\n")[0]}` });
      }
      continue;
    }
    if (language === "go") {
      const text = read(path);
      if (text === undefined) continue;
      if (isGeneratedGo(text)) {
        skipped.push({ path, reason: "generated" });
        continue;
      }
      try {
        goFiles.push({ path, file: parseGo(text), test: name.endsWith("_test.go") });
        analyzed++;
      } catch (error) {
        if (!(error instanceof SourceSyntaxError)) throw error;
        malformed.push({ path, line: error.line, message: error.message });
      }
    } else if (language === "protobuf") {
      const text = read(path);
      if (text === undefined) continue;
      try {
        protoFiles.push({ path, file: parseProto(text) });
        analyzed++;
      } catch (error) {
        if (!(error instanceof SourceSyntaxError)) throw error;
        malformed.push({ path, line: error.line, message: error.message });
      }
    }
  }

  // ---- Go index ----
  const packages = new Map<string, GoPackage>();
  const tests: Array<{ path: string; fn: GoFunction; file: GoFile; facts: BodyFacts }> = [];
  for (const { path, file, test } of goFiles) {
    if (test) {
      for (const fn of file.functions) if (fn.body && /^Test/.test(fn.name) && /testing\.T\b/.test(fn.params)) tests.push({ path, fn, file, facts: bodyFacts(file.tokens, fn.body) });
      continue;
    }
    const dir = dirOf(path);
    const pkg = packages.get(dir) ?? { dir, name: file.packageName, functions: new Map(), types: new Map(), importers: new Set() };
    packages.set(dir, pkg);
    for (const fn of file.functions) {
      const local = fn.receiverType ? `${fn.receiverType}.${fn.name}` : fn.name;
      const key = `${dir}#${local}`;
      // A duplicate key (build-tagged variants) keeps the first in path order; both are real declarations.
      if (!pkg.functions.has(local)) pkg.functions.set(local, { key, dir, path, symbol: `${dir}:${local}`, fn, file });
    }
    for (const type of file.types) if (!pkg.types.has(type.name)) pkg.types.set(type.name, { type, path });
  }
  const importDir = (importPath: string): string | undefined => {
    for (const m of modules) {
      if (importPath === m.module) return m.dir;
      if (importPath.startsWith(`${m.module}/`)) {
        const dir = posix.join(m.dir, importPath.slice(m.module.length + 1));
        return packages.has(dir) ? dir : undefined;
      }
    }
    return undefined;
  };
  const importPathOf = (dir: string): string | undefined => {
    for (const m of modules) {
      if (dir === m.dir) return m.module;
      if (m.dir === ".") return `${m.module}/${dir}`;
      if (dir.startsWith(`${m.dir}/`)) return `${m.module}/${dir.slice(m.dir.length + 1)}`;
    }
    return undefined;
  };
  for (const { path, file, test } of goFiles) {
    if (test) continue;
    for (const imp of file.imports) {
      const dir = importDir(imp.path);
      if (dir) packages.get(dir)!.importers.add(dirOf(path));
    }
  }
  const functionEvidence = (ref: FuncRef) =>
    record({ class: "observed", kind: "go.function", location: at(ref.path, ref.fn.startLine, ref.fn.endLine), subject: ref.fn.name, observation: `${ref.fn.receiverType ? `method ${ref.fn.receiverType}.` : "function "}${ref.fn.name} is declared`, method: "go-static" });
  const importEvidence = (path: string, file: GoFile, importPath: string) => {
    const imp = file.imports.find((i) => i.path === importPath)!;
    return record({ class: "observed", kind: "go.import", location: at(path, imp.line), subject: importPath, observation: `imports ${importPath}`, method: "go-static" });
  };

  // ---- call resolution ----
  type Resolution = { kind: "internal"; targets: FuncRef[]; via: "direct" | "interface" } | { kind: "external"; importPath: string } | { kind: "unresolved"; interface?: string };
  const methodOn = (dir: string, type: string, method: string) => packages.get(dir)?.functions.get(`${type}.${method}`);
  /**
   * Methods that may implement interface method `iface.method` of package `dir`: same-name methods, in that package or
   * one importing it, whose parameter and result types equal the interface method's once the interface package's
   * qualifier is removed. Full method sets are not compared.
   */
  const implementations = (dir: string, iface: GoType, method: string): FuncRef[] => {
    const pkg = packages.get(dir)!;
    const signature = iface.signatures.find((m) => m.name === method);
    if (!signature) return [];
    const importPath = importPathOf(dir);
    const want = [signatureTypes(signature.params), signatureTypes(signature.results)].map((t) => t.join(";")).join("->");
    const out: FuncRef[] = [];
    for (const d of [dir, ...pkg.importers].sort(order)) {
      for (const [local, ref] of packages.get(d)?.functions ?? []) {
        if (!ref.fn.receiverType || ref.fn.receiverType === iface.name || local !== `${ref.fn.receiverType}.${method}`) continue;
        const alias = d === dir ? undefined : ref.file.imports.find((i) => i.path === importPath)?.name;
        const qualifier = alias ? new RegExp(`(?<![\\w.])${alias}\\.`, "g") : undefined;
        const strip = (types: string[]) => types.map((t) => (qualifier ? t.replace(qualifier, "") : t)).join(";");
        if ([strip(signatureTypes(ref.fn.params)), strip(signatureTypes(ref.fn.results))].join("->") === want) out.push(ref);
      }
    }
    return [...new Set(out)].sort((a, b) => order(a.key, b.key));
  };
  /** Resolves a type expression as written in `ref`'s file to a package dir and type name. */
  const typeTarget = (ref: FuncRef, typeText: string): { dir: string; type: string } | { external: string } | undefined => {
    const t = typeText.replace(/^[*&]+/, "").replace(/\[.*$/, "");
    const parts = t.split(".");
    if (parts.length === 1 && /^\w+$/.test(parts[0]!)) return { dir: ref.dir, type: parts[0]! };
    if (parts.length === 2) {
      const imp = ref.file.imports.find((i) => i.name === parts[0]);
      if (!imp) return undefined;
      const dir = importDir(imp.path);
      return dir ? { dir, type: parts[1]! } : { external: imp.path };
    }
    return undefined;
  };
  const methodOrInterface = (dir: string, type: string, method: string): Resolution => {
    const direct = methodOn(dir, type, method);
    if (direct) return { kind: "internal", targets: [direct], via: "direct" };
    const decl = packages.get(dir)?.types.get(type);
    if (decl?.type.kind === "interface" && decl.type.methods.includes(method)) {
      const impls = implementations(dir, decl.type, method);
      return impls.length ? { kind: "internal", targets: impls, via: "interface" } : { kind: "unresolved", interface: `${dir}:${type}.${method}` };
    }
    return { kind: "unresolved" };
  };
  const resolve = (ref: FuncRef, chain: string[]): Resolution => {
    const pkg = packages.get(ref.dir)!;
    const [head, second, third] = chain;
    if (chain.length === 1) {
      const target = pkg.functions.get(head!);
      return target ? { kind: "internal", targets: [target], via: "direct" } : { kind: "unresolved" };
    }
    if (ref.fn.receiverName && head === ref.fn.receiverName && ref.fn.receiverType) {
      const receiver = pkg.types.get(ref.fn.receiverType)?.type;
      if (chain.length === 2) {
        const direct = methodOn(ref.dir, ref.fn.receiverType, second!);
        if (direct) return { kind: "internal", targets: [direct], via: "direct" };
        // A method promoted from an embedded field.
        for (const field of receiver?.fields.filter((f) => f.embedded) ?? []) {
          const target = typeTarget(ref, field.type);
          if (target && "external" in target) continue;
          if (target) {
            const r = methodOrInterface(target.dir, target.type, second!);
            if (r.kind === "internal") return r;
          }
        }
        return { kind: "unresolved" };
      }
      if (chain.length === 3) {
        const field = receiver?.fields.find((f) => f.name === second);
        if (!field) return { kind: "unresolved" };
        const target = typeTarget(ref, field.type);
        if (!target) return { kind: "unresolved" };
        if ("external" in target) return { kind: "external", importPath: target.external };
        return methodOrInterface(target.dir, target.type, third!);
      }
      return { kind: "unresolved" };
    }
    const imp = ref.file.imports.find((i) => i.name === head);
    if (imp) {
      const dir = importDir(imp.path);
      if (!dir) return { kind: "external", importPath: imp.path };
      if (chain.length === 2) {
        const target = packages.get(dir)!.functions.get(second!);
        return target ? { kind: "internal", targets: [target], via: "direct" } : { kind: "unresolved" };
      }
    }
    return { kind: "unresolved" };
  };

  // ---- per-function facts (cached) ----
  const factsCache = new Map<string, FunctionFacts>();
  const bodyCache = new Map<string, BodyFacts>();
  const body = (ref: FuncRef) => {
    if (!bodyCache.has(ref.key)) bodyCache.set(ref.key, ref.fn.body ? bodyFacts(ref.file.tokens, ref.fn.body) : { calls: [], selectors: [], strings: [], goStatements: [] });
    return bodyCache.get(ref.key)!;
  };
  const owner = (ref: FuncRef) => `${ref.fn.receiverType ? `${ref.fn.receiverType}.` : ""}${ref.fn.name}`;
  const factsOf = (ref: FuncRef): FunctionFacts => {
    const cached = factsCache.get(ref.key);
    if (cached) return cached;
    const facts: FunctionFacts = { denials: [], rejections: [], persistence: [], outboundHttp: [], async: [] };
    const b = body(ref);
    for (const s of [...b.selectors, ...b.calls.filter((c) => c.chain.length === 2)]) {
      const imp = ref.file.imports.find((i) => i.name === s.chain[0]);
      const codes = imp && CODE_PACKAGES[imp.path];
      const member = s.chain[1]!;
      if (codes?.denial.includes(member)) facts.denials.push(record({ class: "observed", kind: "go.status-code", location: at(ref.path, s.line), subject: member, observation: `${owner(ref)} uses ${imp!.path} ${member}, an authentication or authorization failure code`, method: "go-static" }));
      if (codes?.rejection.includes(member)) facts.rejections.push(record({ class: "observed", kind: "go.status-code", location: at(ref.path, s.line), subject: member, observation: `${owner(ref)} uses ${imp!.path} ${member}, an invalid-input failure code`, method: "go-static" }));
    }
    for (const c of b.calls) {
      const imp = ref.file.imports.find((i) => i.name === c.chain[0]);
      if (imp?.path === "net/http" && ((c.chain.length === 2 && HTTP_CLIENT.has(c.chain[1]!)) || (c.chain.length === 3 && c.chain[1] === "DefaultClient")))
        facts.outboundHttp.push(record({ class: "observed", kind: "go.http-client", location: at(ref.path, c.line), subject: c.chain.at(-1)!, observation: `${owner(ref)} calls net/http ${c.chain.slice(1).join(".")}`, method: "go-static" }));
    }
    for (const s of b.strings) {
      const m = s.value.match(SQL);
      if (!m) continue;
      const keyword = m[1]!;
      const operation = keyword === "SELECT" ? "read" : keyword === "WITH" ? "unknown" : "write";
      facts.persistence.push({ operation, statement: keyword, evidence: record({ class: "observed", kind: "sql.statement", location: at(ref.path, s.line, s.endLine), subject: keyword, observation: `${owner(ref)} contains a SQL ${keyword} statement literal`, method: "go-static" }) });
    }
    for (const line of b.goStatements) facts.async.push(record({ class: "observed", kind: "go.goroutine", location: at(ref.path, line), subject: "go", observation: `${owner(ref)} starts a goroutine`, method: "go-static" }));
    factsCache.set(ref.key, facts);
    return facts;
  };

  // ---- proto index ----
  const index: ProtoIndex = { messages: new Map(), enums: new Map() };
  const protoPath = new Map<string, string>();
  for (const { path, file } of protoFiles) {
    for (const m of file.messages) if (!index.messages.has(m.fullName)) (index.messages.set(m.fullName, m), protoPath.set(m.fullName, path));
    for (const e of file.enums) if (!index.enums.has(e.fullName)) (index.enums.set(e.fullName, e), protoPath.set(e.fullName, path));
  }
  const shape = (reference: string, scope: string): { shape: MessageShape; schema?: ReturnType<typeof messageSchema> } => {
    const known = (n: string) => index.messages.has(n) || index.enums.has(n) || n.startsWith("google.protobuf.");
    const parts = scope.split(".");
    let full: string | undefined;
    if (reference.startsWith(".")) full = reference.slice(1);
    else for (let k = parts.length; k >= 0 && !full; k--) if (known([...parts.slice(0, k), reference].join("."))) full = [...parts.slice(0, k), reference].join(".");
    const message = full ? index.messages.get(full) : undefined;
    if (!full || (!message && !full.startsWith("google.protobuf."))) {
      return { shape: { message: reference, resolved: false, fields: [], unresolvedTypes: [reference], evidence: [] } };
    }
    if (!message) {
      const schema = messageSchema(index, full, "input");
      return { shape: { message: full, resolved: true, fields: [], unresolvedTypes: [], evidence: [] }, schema };
    }
    const path = protoPath.get(full)!;
    const messageEvidence = record({ class: "observed", kind: "proto.message", location: at(path, message.startLine, message.endLine), subject: message.name, observation: `message ${full} is declared with ${message.fields.length} fields`, method: "proto-static" });
    const fields = message.fields.map((f) => ({
      name: f.name,
      jsonName: f.jsonName,
      type: f.type,
      label: f.label,
      behaviors: f.behaviors,
      ...(f.oneof ? { oneof: f.oneof } : {}),
      evidence: [record({ class: "observed", kind: "proto.field", location: at(path, f.line), subject: f.name, observation: `field ${f.name} = ${f.number} of type ${f.type}${f.behaviors.length ? ` declared ${f.behaviors.join(", ")}` : ""}`, method: "proto-static" })]
    }));
    const input = messageSchema(index, full, "input");
    const output = messageSchema(index, full, "output");
    return { shape: { message: full, resolved: true, fields, unresolvedTypes: uniqueSorted([...input.unresolved, ...output.unresolved]), evidence: [messageEvidence] }, schema: input };
  };

  // ---- policy references: string literals naming a full RPC method ----
  const services: Array<{ path: string; service: ProtoService; packageName: string }> = protoFiles.flatMap(({ path, file }) => file.services.map((service) => ({ path, service, packageName: file.packageName })));
  const fullMethods = new Set(services.flatMap(({ service }) => service.methods.map((m) => `/${service.fullName}/${m.name}`)));
  const policyRefs = new Map<string, string[]>();
  const policyDecls = new Map<string, { path: string; decl: string; evidence: string[] }>();
  const tokenOwner = (file: GoFile, k: number): string | undefined => {
    const value = file.values.find((v) => v.range[0] <= k && k <= v.range[1]);
    if (value) return `${value.keyword} ${value.name}`;
    const fn = file.functions.find((f) => f.body && f.body[0] <= k && k <= f.body[1]);
    return fn ? `func ${fn.receiverType ? `${fn.receiverType}.` : ""}${fn.name}` : undefined;
  };
  for (const { path, file, test } of goFiles) {
    if (test || !fullMethods.size) continue;
    file.tokens.forEach((t: Token, k) => {
      if (t.kind !== "string" || !fullMethods.has(t.value)) return;
      const decl = tokenOwner(file, k);
      const id = record({ class: "observed", kind: "go.method-reference", location: at(path, t.line), subject: t.value, observation: `the literal ${t.value} appears in ${decl ?? "a top-level declaration"}`, method: "go-static" });
      policyRefs.set(t.value, [...(policyRefs.get(t.value) ?? []), id]);
      if (decl) {
        const key = `${path}#${decl}`;
        const entry = policyDecls.get(key) ?? { path, decl, evidence: [] };
        entry.evidence.push(id);
        policyDecls.set(key, entry);
      }
    });
  }

  // ---- configuration keys ----
  const configuration_: Inventory["configuration"] = [];
  const firstString = (tokens: Token[], open: number, skipArgs: number): Token | undefined => {
    let depth = 0;
    let arg = 0;
    for (let k = open; k < tokens.length; k++) {
      const t = tokens[k]!;
      if (t.kind === "punct" && ["(", "[", "{"].includes(t.value)) depth++;
      else if (t.kind === "punct" && [")", "]", "}"].includes(t.value)) {
        if (--depth === 0) return undefined;
      } else if (depth === 1 && t.kind === "punct" && t.value === ",") arg++;
      else if (depth === 1 && arg === skipArgs && t.kind === "string") return tokens[k - 1]?.value === "(" || tokens[k - 1]?.value === "," ? t : undefined;
    }
    return undefined;
  };
  for (const { path, file, test } of goFiles) {
    if (test) continue;
    const alias = (p: string) => file.imports.find((i) => i.path === p)?.name;
    const os = alias("os");
    const viper = alias("github.com/spf13/viper");
    const tokens = file.tokens;
    for (let k = 0; k + 3 < tokens.length; k++) {
      const [a, dot, b, open] = [tokens[k]!, tokens[k + 1]!, tokens[k + 2]!, tokens[k + 3]!];
      if (dot.value !== "." || b.kind !== "ident" || open.value !== "(") continue;
      let source: "env" | "flag" | "viper" | undefined;
      let skip = 0;
      if (os && a.value === os && (b.value === "Getenv" || b.value === "LookupEnv")) source = "env";
      else if (viper && a.value === viper && /^(Get\w*|SetDefault|BindEnv|IsSet)$/.test(b.value)) source = "viper";
      else if (a.value === ")" && /^(Persistent)?Flags$/.test(tokens[k - 2]?.value ?? "") && /^(String|Bool|Int|Int64|Uint|Duration|StringSlice|Float64)(Var)?P?$/.test(b.value)) {
        source = "flag";
        skip = b.value.includes("Var") ? 1 : 0;
      }
      if (!source) continue;
      const key = firstString(tokens, k + 3, skip);
      if (!key || !key.value) continue;
      configuration_.push({ source, key: key.value, evidence: [record({ class: "observed", kind: `config.${source}`, location: at(path, key.line), subject: key.value, observation: `${source === "env" ? "environment variable" : source === "flag" ? "command-line flag" : "configuration key"} ${key.value} is read`, method: "go-static" })] });
    }
  }

  // ---- candidates ----
  const constructs: Inventory["constructs"] = {
    protoServices: services.length,
    protoMethods: services.reduce((n, s) => n + s.service.methods.length, 0),
    goPackages: packages.size,
    goFunctions: [...packages.values()].reduce((n, p) => n + p.functions.size, 0),
    goTestFunctions: tests.length,
    httpRoutes: services.reduce((n, s) => n + s.service.methods.filter((m) => m.http).length, 0)
  };
  const allMethods = [...packages.values()].flatMap((p) => [...p.functions.values()]).filter((r) => r.fn.receiverType);
  const candidates: Candidate[] = [];
  const questions: Question[] = [];
  let truncatedCount = 0;
  let unlinkedCount = 0;

  for (const { path, service, packageName } of services) {
    for (const method of service.methods) {
      const fullMethod = `/${service.fullName}/${method.name}`;
      const id = `cand-${service.fullName}.${method.name}`;
      const rpcEvidence = record({ class: "observed", kind: "proto.rpc", location: at(path, method.startLine, method.endLine), subject: method.name, observation: `service ${service.fullName} declares rpc ${method.name}(${method.input}) returns (${method.output})`, method: "proto-static" });
      const entryPoints: Candidate["entryPoints"] = [{ kind: "proto-rpc", subject: fullMethod, evidence: [rpcEvidence] }];
      if (method.http) {
        entryPoints.push({ kind: "http-binding", subject: `${method.http.method.toUpperCase()} ${method.http.path}`, evidence: [record({ class: "observed", kind: "proto.http-rule", location: at(path, method.http.line), subject: method.http.path || method.http.method, observation: `google.api.http binds rpc ${method.name} to ${method.http.method.toUpperCase()} ${method.http.path}${method.http.body ? ` with body "${method.http.body}"` : ""}`, method: "proto-static" })] });
      }
      const unknowns: string[] = [];
      const candidateEvidence = new Set<string>([rpcEvidence]);

      // Implementation: a method with the RPC's name taking the request type.
      const inputSimple = method.input.split(".").pop()!;
      const named = allMethods.filter((r) => r.fn.name === method.name);
      // The request type as a direct pointer parameter (`*pb.Req`), not as a type argument of a wrapper (`*connect.Request[pb.Req]`).
      const typed = named.filter((r) => new RegExp(`\\*(\\w+\\.)?${inputSimple}\\b(?!\\])`).test(r.fn.params));
      let implementation: Candidate["implementation"];
      let handler: FuncRef | undefined;
      if (typed.length === 1 || (typed.length === 0 && named.length === 1)) {
        handler = typed[0] ?? named[0]!;
        const fnEvidence = functionEvidence(handler);
        const link = typed.length === 1 ? "name-and-request-type" : "name-only";
        const linkEvidence = record({
          class: "inferred",
          kind: "link.rpc-handler",
          subject: fullMethod,
          observation: `rpc ${method.name} is implemented by ${handler.symbol}: ${link === "name-and-request-type" ? `it is the only method named ${method.name} that takes ${inputSimple}` : `it is the only method named ${method.name}; its parameters do not mention ${inputSimple}`}`,
          method: "derivation",
          basis: [rpcEvidence, fnEvidence],
          limitations: ["Dispatch through generated service registration is not traced."]
        });
        implementation = { symbol: handler.symbol, location: at(handler.path, handler.fn.startLine, handler.fn.endLine), link, evidence: [fnEvidence, linkEvidence] };
        candidateEvidence.add(linkEvidence);
      } else {
        unlinkedCount++;
        unknowns.push(
          record({
            class: "unknown",
            kind: "unknown.implementation",
            subject: fullMethod,
            observation: typed.length > 1 || named.length > 1 ? `${Math.max(typed.length, named.length)} methods named ${method.name} could implement rpc ${method.name}; none was chosen` : `no handwritten Go method named ${method.name} was found`,
            method: "derivation"
          })
        );
      }

      // Reachability.
      const reachable: Candidate["dependencies"]["reachableFunctions"] = [];
      const external = new Map<string, string>();
      const facts: FunctionFacts = { denials: [], rejections: [], persistence: [], outboundHttp: [], async: [] };
      const interfaceGaps = new Set<string>();
      let unresolvedCalls = 0;
      let truncated = false;
      if (handler) {
        const seen = new Set<string>([handler.key]);
        const queue: Array<{ ref: FuncRef; depth: number }> = [{ ref: handler, depth: 0 }];
        while (queue.length) {
          const { ref, depth } = queue.shift()!;
          const f = factsOf(ref);
          facts.denials.push(...f.denials);
          facts.rejections.push(...f.rejections);
          facts.persistence.push(...f.persistence);
          facts.outboundHttp.push(...f.outboundHttp);
          facts.async.push(...f.async);
          for (const call of body(ref).calls) {
            const r = resolve(ref, call.chain);
            if (r.kind === "external") {
              if (!external.has(r.importPath)) external.set(r.importPath, importEvidence(ref.path, ref.file, r.importPath));
              continue;
            }
            if (r.kind === "unresolved") {
              unresolvedCalls++;
              if (r.interface) interfaceGaps.add(r.interface);
              continue;
            }
            for (const target of r.targets) {
              if (seen.has(target.key)) continue;
              if (depth + 1 > configuration.maxCallDepth || seen.size >= configuration.maxReachableFunctions) {
                truncated = true;
                continue;
              }
              seen.add(target.key);
              const site = record({ class: "observed", kind: "go.call", location: at(ref.path, call.line), subject: call.chain.at(-1)!, observation: `${owner(ref)} calls ${call.chain.join(".")}(…)`, method: "go-static" });
              const decl = functionEvidence(target);
              const link = record({
                class: "inferred",
                kind: r.via === "interface" ? "link.interface-call" : "link.call",
                subject: target.symbol,
                observation: r.via === "interface" ? `${call.chain.join(".")} is an interface call that may dispatch to ${target.symbol}` : `${call.chain.join(".")} resolves to ${target.symbol}`,
                method: "derivation",
                basis: [site, decl]
              });
              reachable.push({ symbol: target.symbol, path: target.path, depth: depth + 1, evidence: [link] });
              queue.push({ ref: target, depth: depth + 1 });
            }
          }
        }
        if (truncated) truncatedCount++;
        if (unresolvedCalls)
          unknowns.push(record({ class: "unknown", kind: "unknown.calls", subject: fullMethod, observation: `${unresolvedCalls} call sites in the implementation and its reachable functions could not be resolved statically`, method: "derivation" }));
        for (const gap of [...interfaceGaps].sort(order)) unknowns.push(record({ class: "unknown", kind: "unknown.interface-implementation", subject: gap, observation: `no implementation of interface method ${gap} was found in the repository`, method: "derivation" }));
      }
      reachable.sort((a, b) => a.depth - b.depth || order(a.symbol, b.symbol));

      // Inputs and outputs.
      const scope = packageName;
      const input = shape(method.input, scope);
      const output = shape(method.output, scope);
      for (const s of [input.shape, output.shape]) {
        if (!s.resolved) unknowns.push(record({ class: "unknown", kind: "unknown.message", subject: s.message, observation: `message ${s.message} is not declared in the analyzed .proto files`, method: "derivation" }));
        for (const t of s.unresolvedTypes) if (s.resolved) unknowns.push(record({ class: "unknown", kind: "unknown.type", subject: t, observation: `type ${t} used by ${s.message} is not declared in the analyzed .proto files`, method: "derivation" }));
      }

      // Tests that call a method with the RPC's name and construct its request type.
      const related: Candidate["tests"] = [];
      for (const test of tests) {
        const call = test.facts.calls.find((c) => c.chain.length >= 2 && c.chain.at(-1) === method.name);
        const request = [...test.facts.selectors, ...test.facts.calls].find((s) => s.chain.length === 2 && s.chain[1] === inputSimple);
        if (!call || !request) continue;
        const decl = record({ class: "observed", kind: "go.test-function", location: at(test.path, test.fn.startLine, test.fn.endLine), subject: test.fn.name, observation: `test function ${test.fn.name} is declared`, method: "go-static" });
        const site = record({ class: "observed", kind: "go.call", location: at(test.path, call.line), subject: method.name, observation: `${test.fn.name} calls ${call.chain.join(".")}(…)`, method: "go-static" });
        const link = record({ class: "inferred", kind: "link.test", subject: test.fn.name, observation: `${test.fn.name} exercises rpc ${method.name}: it calls a method of that name and constructs ${inputSimple}`, method: "derivation", basis: [decl, site] });
        related.push({ symbol: test.fn.name, path: test.path, evidence: [link] });
      }
      related.sort((a, b) => order(a.path, b.path) || order(a.symbol, b.symbol));

      const denials = uniqueSorted(facts.denials);
      const rejections = uniqueSorted(facts.rejections);
      const persistence = [...new Map(facts.persistence.map((p) => [p.evidence, p])).values()].sort((a, b) => order(a.evidence, b.evidence)).map((p) => ({ operation: p.operation, statement: p.statement, evidence: [p.evidence] }));
      const outboundHttp = uniqueSorted(facts.outboundHttp);
      const async = uniqueSorted(facts.async);
      const policyReferences = uniqueSorted(policyRefs.get(fullMethod) ?? []);
      const permissions = record({ class: "unknown", kind: "unknown.permissions", subject: fullMethod, observation: `the permissions a caller of ${method.name} must hold are not established by static reading`, method: "derivation" });
      unknowns.push(permissions);

      // Readiness.
      const handlerLines = handler ? handler.fn.endLine - handler.fn.startLine + 1 : 0;
      const criteria: CriterionResult[] = [
        { criterion: "entry-point", satisfied: true, reason: method.http ? "rpc-with-http-binding" : "rpc-declared", evidence: entryPoints.flatMap((e) => e.evidence) },
        { criterion: "implementation", satisfied: implementation?.link === "name-and-request-type", reason: implementation ? `handler-matched-by-${implementation.link}` : "handler-not-found", evidence: implementation?.evidence ?? unknowns.slice(0, 1) },
        { criterion: "io-schema", satisfied: input.shape.resolved && output.shape.resolved && !input.shape.unresolvedTypes.length && !output.shape.unresolvedTypes.length, reason: input.shape.resolved && output.shape.resolved ? (input.shape.unresolvedTypes.length || output.shape.unresolvedTypes.length ? "nested-types-unresolved" : "messages-resolved") : "message-unresolved", evidence: [...input.shape.evidence, ...output.shape.evidence] },
        { criterion: "validation", satisfied: rejections.length > 0, reason: rejections.length ? "invalid-input-code-reachable" : "no-invalid-input-code-reachable", evidence: rejections },
        { criterion: "authorization", satisfied: denials.length > 0, reason: denials.length ? "denial-code-reachable" : "no-denial-code-reachable", evidence: denials },
        { criterion: "tests", satisfied: related.length > 0, reason: related.length ? "tests-call-handler-with-request-type" : "no-related-tests", evidence: related.flatMap((t) => t.evidence) },
        { criterion: "reachability-complete", satisfied: Boolean(handler) && !truncated, reason: !handler ? "no-handler" : truncated ? "call-graph-truncated" : "call-graph-within-limits", evidence: implementation?.evidence ?? [] },
        {
          criterion: "small-surface",
          satisfied: Boolean(handler) && handlerLines <= configuration.smallSurface.maxHandlerLines && reachable.length <= configuration.smallSurface.maxReachableFunctions,
          reason: !handler ? "no-handler" : handlerLines > configuration.smallSurface.maxHandlerLines ? "handler-too-long" : reachable.length > configuration.smallSurface.maxReachableFunctions ? "too-many-reachable-functions" : "within-thresholds",
          evidence: implementation?.evidence ?? []
        }
      ];
      const writes = persistence.filter((p) => p.operation !== "read");
      const concerns: Candidate["readiness"]["concerns"] = [];
      if (outboundHttp.length) concerns.push({ concern: "outbound-http", evidence: outboundHttp });
      if (async.length) concerns.push({ concern: "async-work", evidence: async });
      if (writes.length) concerns.push({ concern: "writes-state", evidence: writes.flatMap((w) => w.evidence) });
      if (interfaceGaps.size) concerns.push({ concern: "unresolved-interface", evidence: unknowns.filter((u) => evidence.get(u)!.kind === "unknown.interface-implementation") });
      const all = criteria.every((c) => c.satisfied);
      const blocked = concerns.some((c) => BLOCKING_CONCERNS.includes(c.concern));
      const readinessClass: ReadinessClass = all && !blocked ? "exposure-candidate" : implementation ? "investigate" : "insufficient-evidence";

      // AppPort exposure proposal.
      const httpWrite = method.http && method.http.method !== "get";
      const effect: CapabilityEffect = writes.length || outboundHttp.length || async.length || httpWrite ? "consequential" : "observation";
      const effectReasons = [
        ...(writes.length ? ["sql-write-reachable"] : []),
        ...(outboundHttp.length ? ["outbound-http-reachable"] : []),
        ...(async.length ? ["goroutine-reachable"] : []),
        ...(httpWrite ? [`http-${method.http!.method}-binding`] : []),
        ...(effect === "observation" ? ["no-write-evidence"] : [])
      ];
      const name = proposeCapabilityName(method.name);
      const streaming = method.clientStreaming || method.serverStreaming;
      const exposure: Candidate["exposure"] = {
        status: "proposed",
        authoritative: false,
        ...(name && input.schema && output.schema && isValidName(name)
          ? {
              capability: {
                name,
                version: 1,
                kind: method.serverStreaming ? "stream" : "request",
                inputSchema: input.schema.schema,
                outputSchema: messageSchema(index, output.shape.message, "output").schema,
                effect
              }
            }
          : {}),
        effectBasis: { effect, reasons: effectReasons, evidence: uniqueSorted([...writes.flatMap((w) => w.evidence), ...outboundHttp, ...async, ...(httpWrite ? entryPoints[1]!.evidence : [])]) },
        missing: ["permissions", "fulfillment-claim", "verification-method", "contract-tests", ...(name ? [] : ["capability-name"]), ...(streaming ? ["streaming-semantics"] : [])]
      };

      for (const ids of [entryPoints.flatMap((e) => e.evidence), implementation?.evidence ?? [], denials, rejections, outboundHttp, async, policyReferences, persistence.flatMap((p) => p.evidence), related.flatMap((t) => t.evidence)]) for (const e of ids) candidateEvidence.add(e);
      const candidate: Candidate = {
        id,
        name: `${service.name}.${method.name}`,
        description: `rpc ${method.name} of service ${service.fullName}${method.http ? `, bound to ${method.http.method.toUpperCase()} ${method.http.path}` : ""}`,
        operation: { kind: "rpc", service: service.fullName, method: method.name, fullMethod, streaming },
        entryPoints,
        ...(implementation ? { implementation } : {}),
        inputs: input.shape,
        outputs: output.shape,
        dependencies: { reachableFunctions: reachable, externalPackages: [...external.entries()].sort(([a], [b]) => order(a, b)).map(([importPath, ev]) => ({ importPath, evidence: [ev] })), unresolvedCalls, truncated },
        sideEffects: { persistence, outboundHttp, async },
        authorization: { denials, policyReferences },
        validation: { rejections },
        tests: related,
        evidence: uniqueSorted(candidateEvidence),
        confidence: implementation?.link === "name-and-request-type" ? "linked" : implementation ? "weakly-linked" : "unlinked",
        readiness: { class: readinessClass, criteria, concerns },
        unknowns: uniqueSorted(unknowns),
        exposure
      };
      candidates.push(candidate);
      if (policyReferences.length)
        questions.push({ id: `q-policy-${id.slice(5)}`, candidate: id, question: `${method.name} is named in a method list (${uniqueSorted(policyReferences.map((e) => evidence.get(e)!.observation.replace(/^.* appears in /, ""))).join(", ")}). What access does that list grant or deny?`, evidence: policyReferences });
    }
  }
  candidates.sort((a, b) => order(a.id, b.id));

  // ---- ranking and recommendation ----
  const CLASS_RANK: Record<ReadinessClass, number> = { "exposure-candidate": 0, investigate: 1, "insufficient-evidence": 2 };
  const RANKING_RULES = ["readiness-class", "more-criteria-satisfied", "fewer-concerns", "observation-before-consequential", "fewer-reachable-functions", "candidate-id"];
  const rankKey = (c: Candidate) => [CLASS_RANK[c.readiness.class], -c.readiness.criteria.filter((x) => x.satisfied).length, c.readiness.concerns.length, c.exposure.effectBasis.effect === "observation" ? 0 : 1, c.dependencies.reachableFunctions.length] as const;
  const ranked = [...candidates].sort((a, b) => {
    const ka = rankKey(a);
    const kb = rankKey(b);
    for (let k = 0; k < ka.length; k++) if (ka[k] !== kb[k]) return ka[k]! - kb[k]!;
    return order(a.id, b.id);
  });
  const exposureCandidates = ranked.filter((c) => c.readiness.class === "exposure-candidate");
  let recommendation: Recommendation | null = null;
  const top = exposureCandidates[0];
  if (top) {
    const beforeExposure = [...top.unknowns];
    const permissionQuestion: Question = { id: `q-permissions-${top.id.slice(5)}`, candidate: top.id, question: `Which permissions must a caller hold to invoke ${top.operation.kind === "rpc" ? top.operation.method : top.name}, and is anonymous access ever allowed?`, evidence: top.authorization.denials };
    questions.push(permissionQuestion);
    beforeExposure.push(permissionQuestion.id, ...questions.filter((q) => q.candidate === top.id && q.id !== permissionQuestion.id).map((q) => q.id));
    recommendation = {
      candidate: top.id,
      readiness: "exposure-candidate",
      reasons: [...top.readiness.criteria.filter((c) => c.satisfied).map((c) => `${c.criterion}:${c.reason}`), `effect:${top.exposure.effectBasis.effect}`, ...top.readiness.concerns.map((c) => `concern:${c.concern}`)],
      ranking: { rules: RANKING_RULES, position: 1, of: exposureCandidates.length, alternatives: exposureCandidates.slice(1, 4).map((c) => c.id) },
      beforeExposure: uniqueSorted(beforeExposure)
    };
  }
  for (const [, decl] of [...policyDecls.entries()].sort(([a], [b]) => order(a, b)))
    questions.push({ id: `q-policy-list-${decl.path}#${decl.decl.replace(/^\w+ /, "")}`, question: `${decl.decl} in ${decl.path} lists ${decl.evidence.length} RPC methods. What does membership in it mean for authentication and authorization?`, evidence: uniqueSorted(decl.evidence) });
  questions.sort((a, b) => order(a.id, b.id));

  // ---- coverage and findings ----
  const languages = [...languageCounts.entries()].sort(([a], [b]) => order(a, b)).map(([language, files]) => ({ language, files, supported: SUPPORTED.has(language) }));
  const unsupported = languages.filter((l) => !l.supported);
  skipped.sort((a, b) => order(a.path, b.path) || order(a.reason, b.reason));
  malformed.sort((a, b) => order(a.path, b.path));
  const partialReasons = [
    ...(malformed.length ? ["malformed-files"] : []),
    ...(skipped.some((s) => s.reason === "unreadable") ? ["unreadable-files"] : []),
    ...(skipped.some((s) => s.reason === "too-large") ? ["too-large-files"] : []),
    ...(unsupported.length ? ["unsupported-languages"] : []),
    ...(walk.unsupportedIgnorePatterns.length ? ["unsupported-ignore-patterns"] : []),
    ...(truncatedCount ? ["call-graph-truncated"] : [])
  ];
  for (const m of malformed) findings.push({ code: "FILE_MALFORMED", severity: "warning", message: `${m.path}:${m.line}: ${m.message}; the file was not analyzed`, path: m.path });
  for (const s of skipped.filter((s) => s.reason === "unreadable" || s.reason === "too-large")) findings.push({ code: s.reason === "unreadable" ? "FILE_UNREADABLE" : "FILE_TOO_LARGE", severity: "warning", message: `${s.path} was not read (${s.reason})`, path: s.path });
  for (const s of skipped.filter((s) => s.reason === "symlink")) findings.push({ code: "SYMLINK_SKIPPED", severity: "info", message: `${s.path} is a symbolic link and was not followed`, path: s.path });
  for (const l of unsupported) findings.push({ code: "LANGUAGE_UNSUPPORTED", severity: "info", message: `${l.files} ${l.language} files were counted, not analyzed` });
  for (const p of walk.unsupportedIgnorePatterns) findings.push({ code: "IGNORE_PATTERN_UNSUPPORTED", severity: "info", message: `.gitignore pattern ${JSON.stringify(p)} was not applied` });
  if (!candidates.length) findings.push({ code: "NO_ENTRY_POINTS", severity: "warning", message: "no supported entry points (Protocol Buffers services) were found" });
  if (unlinkedCount) findings.push({ code: "IMPLEMENTATION_UNLINKED", severity: "info", message: `${unlinkedCount} of ${candidates.length} candidates have no linked implementation` });
  if (truncatedCount) findings.push({ code: "CALL_GRAPH_TRUNCATED", severity: "info", message: `${truncatedCount} candidates reached the call-graph limits (depth ${configuration.maxCallDepth}, ${configuration.maxReachableFunctions} functions)` });
  if (candidates.length && !top) findings.push({ code: "NO_EXPOSURE_CANDIDATE", severity: "warning", message: "no candidate satisfies every readiness criterion; nothing is recommended" });
  const identity = gitIdentity(root);
  if (!identity.revision) findings.push({ code: "REVISION_UNKNOWN", severity: "info", message: "no git revision could be read; the assessment is not tied to a revision" });
  findings.sort((a, b) => order(a.code, b.code) || order(a.path ?? "", b.path ?? "") || order(a.message, b.message));

  const coverage: Coverage = {
    filesSeen: walk.files.length,
    filesAnalyzed: analyzed,
    languages,
    skipped,
    malformed,
    unsupportedIgnorePatterns: walk.unsupportedIgnorePatterns,
    partial: partialReasons.length > 0,
    partialReasons
  };
  const inventory: Inventory = {
    manifests: manifests.sort((a, b) => order(a.path, b.path)),
    constructs,
    entryPoints: candidates.flatMap((c) => c.entryPoints.map((e) => ({ candidate: c.id, kind: e.kind, subject: e.subject, evidence: e.evidence }))),
    persistence: uniqueSorted(candidates.flatMap((c) => c.sideEffects.persistence.flatMap((p) => p.evidence))).map((id) => {
      const e = evidence.get(id)!;
      const keyword = e.subject!;
      return { operation: keyword === "SELECT" ? ("read" as const) : keyword === "WITH" ? ("unknown" as const) : ("write" as const), path: e.location!.path, evidence: [id] };
    }),
    integrations: [
      ...integrations,
      ...uniqueSorted(candidates.flatMap((c) => c.sideEffects.outboundHttp)).map((id) => ({ kind: "outbound-http" as const, subject: `${evidence.get(id)!.location!.path}:${evidence.get(id)!.location!.startLine}`, evidence: [id] }))
    ].sort((a, b) => order(a.kind, b.kind) || order(a.subject, b.subject)),
    configuration: [...new Map(configuration_.map((c) => [`${c.source}:${c.key}:${c.evidence[0]}`, c])).values()].sort((a, b) => order(a.source, b.source) || order(a.key, b.key) || order(a.evidence[0]!, b.evidence[0]!)),
    authorization: [
      ...[...policyRefs.entries()].map(([subject, ids]) => ({ kind: "policy-reference" as const, subject, evidence: uniqueSorted(ids) })),
      ...uniqueSorted(candidates.flatMap((c) => c.authorization.denials)).map((id) => ({ kind: "denial" as const, subject: `${evidence.get(id)!.location!.path}:${evidence.get(id)!.location!.startLine}`, evidence: [id] }))
    ].sort((a, b) => order(a.kind, b.kind) || order(a.subject, b.subject)),
    tests: { files: new Set(tests.map((t) => t.path)).size, functions: tests.length }
  };

  const name = targetName ?? { name: basename(root), source: "directory" as const };
  const sortedEvidence = [...evidence.values()].sort((a, b) => order(a.location?.path ?? "~", b.location?.path ?? "~") || (a.location?.startLine ?? 0) - (b.location?.startLine ?? 0) || order(a.id, b.id));
  const artifact: Omit<ApplicationAssessment, "digest"> = {
    format: ASSESSMENT_FORMAT,
    assessment: { id: (options.id ?? randomUUID)(), createdAt: (options.now?.() ?? new Date()).toISOString() },
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    target: { name: name.name, nameSource: name.source, ...identity },
    configuration,
    coverage,
    evidence: sortedEvidence,
    inventory,
    candidates,
    recommendation,
    findings,
    limitations: [...LIMITATIONS],
    questions,
    scope: { grantsAuthority: false, verifiesBehavior: false, modifiesTarget: false }
  };
  return { ...artifact, digest: assessmentDigest(artifact) };
}

