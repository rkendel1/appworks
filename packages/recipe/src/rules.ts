/**
 * Checks recipe rules with AppPort's own mapping lint.
 *
 * A recipe writes into a step input, a transform output or the recipe output with the `appport.mapping/1` rule
 * vocabulary. Each rule is checked by published `lintMapping` from `@appport/integration`, so pointers, types, units,
 * encodings, enum tables, concepts, defaults and required-field coverage are judged by exactly AppPort's rules, not a
 * copy of them.
 *
 * `lintMapping` checks a whole mapping artifact between two published capability schemas. The recipe's sources are
 * many (its input and the outputs of earlier steps), so the adapter presents them as one synthetic source record with a
 * property per referenced recipe pointer, each with the schema at that pointer and whether it is present on every path.
 * Artifact-level findings that do not apply to a recipe rule set are dropped: the declaration of unmapped source fields
 * as lost (`lossy`), which a recipe cannot make; and the schema-digest pin, which the adapter sets itself.
 *
 * Once AppPort publishes `lintRule` (merged on AppPort `main`), the per-rule half can be called directly
 * (docs/compatibility.md §3).
 */
import type { AppPortManifest, JSONSchema, JsonValue } from "@appport/protocol";
import { lintMapping, schemaIdentity, type MappingArtifact, type Rule } from "@appport/integration";

export interface RuleSource {
  schema: JSONSchema;
  /** The value is present on every path to the rule. */
  required: boolean;
}

export interface RuleIssue {
  level: "error" | "warning";
  /** Index of the rule, or undefined for findings about the rule set (required coverage). */
  rule?: number;
  /** `to`, `from`, `value`, `default` or `table`, when the issue is about one member of the rule. */
  member?: string;
  message: string;
}

const APP = "org.appworks.recipe-rules";
const FROM = "rules.source";
const TO = "rules.target";
const KEY = (i: number) => `__appworks_source_${i}__`;

/**
 * Lints `rules` writing into `target`. `sources` gives, for each rule, the schema of the value it reads, or undefined
 * when the rule reads nothing (`const`) or its source could not be resolved (the caller has reported that).
 * `written` lists further target pointers produced by rules outside the mapping vocabulary (`compute`), with the
 * schema they write, so required-field coverage counts them.
 */
export function lintRecipeRules(rules: readonly Rule[], sources: ReadonlyArray<RuleSource | undefined>, target: JSONSchema, written: ReadonlyArray<{ to: string; schema: JSONSchema }> = []): RuleIssue[] {
  const properties: Record<string, JsonValue> = {};
  const required: string[] = [];
  const renamed = new Map<string, string>();
  const mapped: Rule[] = [];
  const positions: number[] = [];
  rules.forEach((rule, index) => {
    if (rule.op === "const") {
      mapped.push(rule);
      positions.push(index);
      return;
    }
    const source = sources[index];
    if (!source) return;
    const key = KEY(index);
    properties[key] = source.schema as unknown as JsonValue;
    if (source.required) required.push(key);
    renamed.set(`/${key}`, rule.from);
    mapped.push({ ...rule, from: `/${key}` });
    positions.push(index);
  });
  written.forEach((write, i) => {
    const key = KEY(rules.length + i);
    properties[key] = write.schema as unknown as JsonValue;
    required.push(key);
    mapped.push({ op: "copy", from: `/${key}`, to: write.to });
    positions.push(-1);
  });

  const source: JSONSchema = { type: "object", properties: properties as Record<string, JSONSchema>, required };
  const manifest = (name: string, side: "input" | "output", schema: JSONSchema): AppPortManifest => {
    const definition = { version: 1, kind: "request" as const, inputSchema: side === "input" ? schema : { type: "object" }, outputSchema: side === "output" ? schema : { type: "object" }, authorization: [] };
    return {
      protocol: "appport/1",
      application: { id: APP, name: APP, version: "0.0.0" },
      capabilities: [{ name, versions: [1], latestVersion: 1, ...definition, definitions: [definition] }],
      events: [],
      transports: []
    } as unknown as AppPortManifest;
  };
  const artifact: MappingArtifact = {
    format: "appport.mapping/1",
    kind: "declarative",
    id: "urn:appworks:recipe-rules",
    version: 1,
    origin: "provider",
    from: { application: APP, capability: `${FROM}@1`, side: "output", schemaDigest: schemaIdentity(source) },
    to: { application: APP, capability: `${TO}@1`, side: "input", schemaDigest: schemaIdentity(target) },
    rules: mapped,
    lossy: [],
    vectors: []
  } as MappingArtifact;

  const restore = (text: string) => text.replace(/\/__appworks_source_\d+__/g, (key) => renamed.get(key) ?? key);
  const issues: RuleIssue[] = [];
  for (const issue of lintMapping(artifact, { from: manifest(FROM, "output", source), to: manifest(TO, "input", target) }, { requireConcepts: false })) {
    if (issue.path === "lossy" || issue.path.startsWith("lossy[")) continue;
    const match = /^rules\[(\d+)\](?:\.(\w+))?$/.exec(issue.path);
    if (match) {
      const position = positions[Number(match[1])]!;
      issues.push({ level: issue.level, ...(position >= 0 ? { rule: position } : {}), ...(match[2] ? { member: match[2] } : {}), message: restore(issue.message) });
    } else {
      issues.push({ level: issue.level, message: restore(issue.message) });
    }
  }
  return issues;
}
