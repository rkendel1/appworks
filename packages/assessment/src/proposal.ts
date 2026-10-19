/**
 * Proposed AppPort shapes for a candidate: a capability name that satisfies AppPort's naming rule (`isValidName`) and
 * input/output JSON Schemas derived from Protocol Buffers declarations by the proto3 JSON mapping. Proposals are
 * starting points for a contract author; they register nothing and authorize nothing (spec/assessment-1.md §9).
 */
import { isValidName, JSON_SCHEMA_DIALECT, type JSONSchema } from "@appport/protocol";
import type { ProtoEnum, ProtoField, ProtoMessage } from "./proto.js";
import { resolveProtoType } from "./proto.js";

/**
 * `GetMemo` → `memo.get`, `ListMemoComments` → `memo.comments.list`, `BatchGetLinkMetadata` → `link.metadata.batchget`.
 * The first word is the operation; the rest, the namespace. Undefined when the result is not a valid AppPort name.
 */
export function proposeCapabilityName(method: string): string | undefined {
  const words = method.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z0-9]+/g)?.map((w) => w.toLowerCase()) ?? [];
  if (words.length < 2) return undefined;
  let verb = words.shift()!;
  if (verb === "batch" && words.length > 1) verb += words.shift()!;
  const name = [...words, verb].join(".");
  return isValidName(name) ? name : undefined;
}

const INT64 = new Set(["int64", "uint64", "sint64", "fixed64", "sfixed64"]);
const INT32 = new Set(["int32", "uint32", "sint32", "fixed32", "sfixed32"]);
const WRAPPERS: Record<string, JSONSchema> = {
  "google.protobuf.StringValue": { type: ["string", "null"] },
  "google.protobuf.BytesValue": { type: ["string", "null"] },
  "google.protobuf.BoolValue": { type: ["boolean", "null"] },
  "google.protobuf.Int32Value": { type: ["integer", "null"] },
  "google.protobuf.UInt32Value": { type: ["integer", "null"] },
  "google.protobuf.Int64Value": { type: ["string", "null"], pattern: "^-?[0-9]+$" },
  "google.protobuf.UInt64Value": { type: ["string", "null"], pattern: "^[0-9]+$" },
  "google.protobuf.FloatValue": { type: ["number", "null"] },
  "google.protobuf.DoubleValue": { type: ["number", "null"] }
};
/** proto3 JSON representations of well-known types. */
const WELL_KNOWN: Record<string, JSONSchema> = {
  "google.protobuf.Timestamp": { type: "string", format: "date-time" },
  "google.protobuf.Duration": { type: "string", pattern: "^-?[0-9]+(\\.[0-9]+)?s$" },
  "google.protobuf.FieldMask": { type: "string" },
  "google.protobuf.Empty": { type: "object", properties: {} },
  "google.protobuf.Struct": { type: "object" },
  "google.protobuf.Value": {},
  "google.protobuf.ListValue": { type: "array" },
  "google.protobuf.Any": { type: "object", required: ["@type"], properties: { "@type": { type: "string" } } },
  ...WRAPPERS
};

export interface ProtoIndex {
  messages: Map<string, ProtoMessage>;
  enums: Map<string, ProtoEnum>;
}

/** Resolves a field's type reference from within its message. */
export function fieldTypeName(index: ProtoIndex, type: string, scope: string): string | undefined {
  const known = (n: string) => index.messages.has(n) || index.enums.has(n) || n in WELL_KNOWN;
  return resolveProtoType(type, scope, known);
}

function scalar(type: string): JSONSchema | undefined {
  if (type === "string") return { type: "string" };
  if (type === "bytes") return { type: "string", contentEncoding: "base64" } as JSONSchema;
  if (type === "bool") return { type: "boolean" };
  if (type === "double" || type === "float") return { type: "number" };
  if (INT32.has(type)) return { type: "integer" };
  if (INT64.has(type)) return { type: "string", pattern: type.startsWith("u") || type === "fixed64" ? "^[0-9]+$" : "^-?[0-9]+$" };
  return undefined;
}

/**
 * The JSON Schema of a message under the proto3 JSON mapping: lowerCamelCase (or `json_name`) members, 64-bit integers
 * as strings, enums as their value names, well-known types as their JSON forms, nested messages under `$defs`.
 * `required` lists fields declared `REQUIRED` by `google.api.field_behavior`, a declaration, not proof of enforcement;
 * `OUTPUT_ONLY` fields are left out of an input schema and `INPUT_ONLY` fields out of an output schema. Unresolvable type references become `{}` and are returned.
 */
export function messageSchema(index: ProtoIndex, fullName: string, use: "input" | "output"): { schema: JSONSchema; unresolved: string[] } {
  const defs: Record<string, JSONSchema> = {};
  const unresolved = new Set<string>();
  const pending: string[] = [];
  const reference = (name: string): JSONSchema => {
    if (name in WELL_KNOWN) return { ...WELL_KNOWN[name]! };
    if (index.enums.has(name)) return { type: "string", enum: [...index.enums.get(name)!.values] };
    if (!(name in defs)) {
      defs[name] = {};
      pending.push(name);
    }
    return { $ref: `#/$defs/${name}` };
  };
  const fieldSchema = (field: ProtoField, scope: string): JSONSchema => {
    const one = (type: string): JSONSchema => {
      const s = scalar(type);
      if (s) return s;
      const resolved = fieldTypeName(index, type, scope);
      if (!resolved) {
        unresolved.add(type);
        return {};
      }
      return reference(resolved);
    };
    if (field.map) return { type: "object", additionalProperties: one(field.map.value) };
    if (field.label === "repeated") return { type: "array", items: one(field.type) };
    return one(field.type);
  };
  const objectOf = (name: string): JSONSchema => {
    const message = index.messages.get(name)!;
    const properties: Record<string, JSONSchema> = {};
    const required: string[] = [];
    for (const field of message.fields) {
      if (field.behaviors.includes(use === "input" ? "OUTPUT_ONLY" : "INPUT_ONLY")) continue;
      properties[field.jsonName] = fieldSchema(field, message.fullName);
      if (field.behaviors.includes("REQUIRED")) required.push(field.jsonName);
    }
    return { type: "object", properties, ...(required.length ? { required } : {}) };
  };
  if (fullName in WELL_KNOWN) return { schema: { $schema: JSON_SCHEMA_DIALECT, ...WELL_KNOWN[fullName]! }, unresolved: [] };
  const root: JSONSchema = { $schema: JSON_SCHEMA_DIALECT, ...objectOf(fullName) };
  while (pending.length) {
    const name = pending.shift()!;
    defs[name] = objectOf(name);
  }
  const sortedDefs = Object.fromEntries(Object.keys(defs).sort().map((k) => [k, defs[k]!]));
  return { schema: Object.keys(defs).length ? { ...root, $defs: sortedDefs } : root, unresolved: [...unresolved].sort() };
}
