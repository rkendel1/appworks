/**
 * Readiness: what is established about a recipe in one environment, and what is not. It is built from AppPort's and the recipe
 * package's own checks, called with what the environment reports, and invents none of its own:
 *
 * - the recipe's own soundness and its fit to the environment's contracts: `validateRecipe`, with the environment's snapshot;
 * - who resolves each dependency: the environment's resolution (`resolve`, `snapshot`);
 * - whether the consumer is authorized: AppPort's binder, asked through `gateway.access`, which invokes and grants nothing;
 * - whether a contract changed since the last package: `checkRecipeLock` on that package's portable lock;
 * - whether the principal may start it: the environment's `RuntimeAuthority`.
 *
 * A fact the environment cannot establish is reported as `unresolved` and is never counted as success. A valid structure is not
 * a runnable recipe: only `ready` means every checkable fact holds, and `ready-with-unresolved` says what is left unchecked.
 */
import { checkRecipeLock, recipeDependencies, validateRecipe, type RecipeEnvironment, type RecipeFinding, type RecipeSource } from "@appport/recipe";
import type { DependencyAccess } from "@appport/recipe-runtime";
import type { StudioEnvironment } from "./environment.js";
import type { LastPackage } from "./project.js";

export type Verdict =
  /** The recipe has source errors. Nothing about any environment matters yet. */
  | "invalid"
  /** The recipe is sound; no environment was supplied to check it against. */
  | "unassessed"
  /** Sound, but this environment cannot run it as things stand. */
  | "blocked"
  /** Every fact the environment can report holds; some facts it cannot report are listed under `unresolved`. */
  | "ready-with-unresolved"
  | "ready";

export type StudioFindingCode =
  | RecipeFinding["code"]
  | "ENVIRONMENT_UNREACHABLE"
  | "PROVIDER_NONE"
  | "PROVIDER_AMBIGUOUS"
  | "ACCESS_DENIED"
  | "CONTRACT_CHANGED"
  | "RUNTIME_NOT_PERMITTED";

export interface StudioFinding {
  code: StudioFindingCode;
  severity: "error" | "warning";
  scope: "source" | "environment" | "authority";
  /** JSON Pointer into the recipe, when the finding is about a place in it. */
  path?: string;
  step?: string;
  dependency?: string;
  message: string;
  /** What to do about it. */
  action: string;
}

export interface DependencyReadiness {
  id: string;
  contract: string;
  capability: string;
  versionConstraint?: string;
  /** The environment holds this contract, active. */
  contractAvailable: boolean;
  /** How many providers are eligible, or `unknown` when the environment does not say. */
  providers: { eligible: number | "unknown"; state: "resolved" | "none" | "ambiguous" | "unknown" };
  /** This environment's binding. Not part of the recipe and not portable. */
  binding?: { provider: string; capability: { name: string; version: number }; registrationId: string; fulfillment?: string };
  /** AppPort's answer for the runtime consumer, now. `unknown` when the environment cannot answer. */
  authority: DependencyAccess | { state: "unknown"; reason: string };
}

export interface Unresolved {
  subject: string;
  why: string;
}

export interface Readiness {
  verdict: Verdict;
  environment?: string;
  sourceOk: boolean;
  findings: StudioFinding[];
  dependencies: DependencyReadiness[];
  /** What the environment could not tell the Studio. Never read as success. */
  unresolved: Unresolved[];
  /** Always false: a source package has no compiler behind it; running is the runtime's decision, made at start. */
  executable: false;
}

const ADVICE: Partial<Record<StudioFindingCode, string>> = {
  RECIPE_FORMAT: "Open the recipe as an appport.recipe/1 document.",
  RECIPE_STRUCTURE: "Complete the missing or malformed part named by the path.",
  RECIPE_ID_INVALID: "Give the recipe a reverse-domain id such as org.example.recipes.name.",
  TARGET_MISSING: "Point the route at a step that exists, or add that step.",
  CYCLE: "Remove the route that leads back to an earlier step.",
  STEP_UNREACHABLE: "Route to this step from another, or remove it.",
  PATH_UNHANDLED: "Give every outcome of the step a route.",
  UNCERTAIN_UNHANDLED: "Route the uncertain outcome of this consequential step to an end that stops, so it is reconciled rather than repeated.",
  REFERENCE_INVALID: "Correct the data pointer: it must name recipe input or an earlier step's output.",
  REFERENCE_UNAVAILABLE: "Reference only data that exists on every path to this step.",
  MAPPING_INVALID: "Fix the input rule so its source and target both exist.",
  MAPPING_INCOMPLETE: "Map every required field of the capability's input.",
  SCHEMA_MISMATCH: "Make the value the step sends satisfy the capability's declared input, or change the source field.",
  DEPENDENCY_UNDECLARED: "Declare the capability under requires, or point the step at a declared one.",
  DEPENDENCY_UNUSED: "Remove the dependency, or add a step that uses it.",
  VERIFICATION_MISSING: "List every state verification method the contract declares for this capability.",
  APPROVAL_TASK_INVALID: "Point approval at a task step marked approval: true that precedes the invocation on every path.",
  OUTCOME_OUTPUT_MISSING: "Produce every required output on each path that ends completed.",
  ENV_CONTRACT_UNAVAILABLE: "Register and activate the canonical contract in this environment, or open the recipe in an environment that holds it.",
  ENV_CAPABILITY_UNAVAILABLE: "The contract here has no such capability or version: choose one it offers, or use an environment with the revision this recipe was written against.",
  ENV_SCHEMA_INCOMPATIBLE: "The environment's contract no longer accepts or produces what this recipe expects: update the step's expected shapes and mapping to the contract, then revalidate.",
  ENV_EFFECT_MISMATCH: "Declare the effect the contract declares: observation or consequential.",
  ENV_VERIFICATION_WEAKENED: "The contract's verification is weaker than the recipe relies on: change the recipe or the contract.",
  ENV_VERIFICATION_UNKNOWN: "Name only verification methods the contract declares.",
  ENV_APPROVAL_REQUIRED: "The contract requires human approval for this capability: route through an approval task.",
  ENV_UNCERTAIN_UNHANDLED: "Route the uncertain outcome to an explicit end.",
  ENV_PROBE_NOT_OBSERVATION: "Verify through an observation capability, never one with effects.",
  ENV_NO_ELIGIBLE_PROVIDER: "No provider here fulfils this capability: register one whose fulfillment claim is valid for the contract revision.",
  ENV_AMBIGUOUS_PROVIDER: "More than one provider fulfils it: the environment's operator must leave exactly one eligible.",
  ENVIRONMENT_UNREACHABLE: "The environment could not be inspected; fix the environment module or choose another.",
  PROVIDER_NONE: "Register a provider whose fulfillment claim is valid for the locked contract revision.",
  PROVIDER_AMBIGUOUS: "Leave exactly one eligible provider; the Studio does not choose one, because that choice is the environment's.",
  ACCESS_DENIED: "Authority has not been delegated: ask the environment's owner to grant the runtime consumer this capability. The Studio cannot, and a recipe never carries the grant.",
  CONTRACT_CHANGED: "The capability's contract changed since this recipe was last packaged: revalidate the recipe against the current contract, then package again.",
  RUNTIME_NOT_PERMITTED: "This principal may not start this recipe here: ask the environment's owner."
};
const adviceFor = (code: StudioFindingCode): string => ADVICE[code] ?? "See the message.";

const isObject = (v: unknown): v is Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Which step or dependency a JSON Pointer into the recipe falls inside. */
function placeOf(recipe: unknown, path: string): { step?: string; dependency?: string } {
  const [, section, index] = path.split("/");
  const list = isObject(recipe) ? recipe[section ?? ""] : undefined;
  const id = Array.isArray(list) && index !== undefined ? list[Number(index)]?.id : undefined;
  if (typeof id !== "string") return {};
  return section === "steps" ? { step: id } : section === "requires" ? { dependency: id } : {};
}

function fromRecipeFinding(recipe: unknown, f: RecipeFinding): StudioFinding {
  return { code: f.code, severity: f.severity, scope: f.scope, path: f.path, ...placeOf(recipe, f.path), message: f.message, action: adviceFor(f.code) };
}

export async function assess(
  draft: unknown,
  environment: StudioEnvironment | undefined,
  options: { principal?: string; previous?: LastPackage } = {}
): Promise<Readiness> {
  const source = validateRecipe(draft);
  const findings: StudioFinding[] = source.findings.map((f) => fromRecipeFinding(draft, f));
  const base = { sourceOk: source.sourceOk, dependencies: [] as DependencyReadiness[], unresolved: [] as Unresolved[], executable: false as const, ...(environment ? { environment: environment.name } : {}) };
  if (!source.sourceOk) return { ...base, verdict: "invalid", findings };
  const recipe = draft as RecipeSource;
  if (!environment) return { ...base, verdict: "unassessed", findings, unresolved: [{ subject: "environment", why: "no environment was supplied, so nothing about contracts, providers or authority is established" }] };

  const { gateway } = environment;
  const unresolved: Unresolved[] = [];
  let snapshot: RecipeEnvironment;
  try {
    snapshot = await gateway.snapshot(recipe.requires);
  } catch (error) {
    findings.push({ code: "ENVIRONMENT_UNREACHABLE", severity: "error", scope: "environment", message: `the environment could not be inspected: ${(error as Error).message}`, action: adviceFor("ENVIRONMENT_UNREACHABLE") });
    return { ...base, verdict: "blocked", findings, unresolved: [{ subject: "environment", why: "it could not be inspected" }] };
  }

  // The recipe against this environment's contracts: AppPort's compatibility checks, as the recipe package runs them.
  const checked = validateRecipe(recipe, snapshot);
  findings.splice(0, findings.length, ...checked.findings.map((f) => fromRecipeFinding(recipe, f)));

  // Where each dependency stands here: contract, providers, binding, authority.
  const dependencies: DependencyReadiness[] = [];
  for (const d of recipeDependencies(recipe)) {
    const declared = recipe.requires.find((r) => r.id === d.id)!;
    const eligible = snapshot.providers?.[d.id]?.eligible;
    const providers: DependencyReadiness["providers"] = eligible === undefined ? { eligible: "unknown", state: "unknown" } : { eligible, state: eligible === 0 ? "none" : eligible > 1 ? "ambiguous" : "resolved" };
    let binding: DependencyReadiness["binding"];
    if (gateway.resolve && providers.state === "resolved") {
      try {
        const record = (await gateway.resolve([declared]))[d.id];
        if (record) binding = { provider: record.provider.application, capability: record.provider.capability, registrationId: record.provider.registrationId, ...(record.fulfillment ? { fulfillment: record.fulfillment.status } : {}) };
      } catch {
        // Resolution disagreeing with the snapshot is reported by the provider state; there is no binding to show.
      }
    }
    let authority: DependencyReadiness["authority"] = { state: "unknown", reason: "this environment cannot report whether the consumer is authorized" };
    if (gateway.access) authority = (await gateway.access([declared]))[d.id] ?? { state: "unknown", reason: "the environment returned no answer for this dependency" };
    dependencies.push({ id: d.id, contract: d.contract, capability: d.capability, ...(d.versionConstraint ? { versionConstraint: d.versionConstraint } : {}), contractAvailable: Boolean(snapshot.contracts?.[d.contract]), providers, ...(binding ? { binding } : {}), authority });

    if (providers.state === "none" && !findings.some((f) => f.dependency === d.id && f.code === "ENV_NO_ELIGIBLE_PROVIDER")) findings.push({ code: "PROVIDER_NONE", severity: "error", scope: "environment", dependency: d.id, path: `/requires/${recipe.requires.indexOf(declared)}`, message: `no provider here fulfils ${d.capability}`, action: adviceFor("PROVIDER_NONE") });
    if (providers.state === "ambiguous") findings.push({ code: "PROVIDER_AMBIGUOUS", severity: "error", scope: "environment", dependency: d.id, path: `/requires/${recipe.requires.indexOf(declared)}`, message: `${providers.eligible} providers fulfil ${d.capability}; the environment must leave exactly one`, action: adviceFor("PROVIDER_AMBIGUOUS") });
    if (providers.state === "unknown") unresolved.push({ subject: `providers of ${d.id}`, why: "the environment did not report how many providers are eligible" });
    if (authority.state === "denied") findings.push({ code: "ACCESS_DENIED", severity: "error", scope: "authority", dependency: d.id, path: `/requires/${recipe.requires.indexOf(declared)}`, message: `the runtime is not authorized to use ${d.capability} through ${authority.provider}: ${authority.message}`, action: adviceFor("ACCESS_DENIED") });
    if (authority.state === "unknown") unresolved.push({ subject: `authority for ${d.id}`, why: authority.reason });
    if (authority.state === "unresolved" || authority.state === "ambiguous") unresolved.push({ subject: `authority for ${d.id}`, why: `not decided: ${authority.reason}` });
  }

  // A contract that changed since the recipe was last packaged: the lock's own check, against the environment's contracts now.
  if (options.previous) {
    const lock = checkRecipeLock(options.previous.lock, recipe, { contracts: snapshot.contracts ?? {} });
    for (const f of lock.findings.filter((x) => x.code === "LOCK_CONTRACT_CHANGED" || x.code === "LOCK_CAPABILITY_CHANGED")) {
      findings.push({ code: "CONTRACT_CHANGED", severity: "error", scope: "environment", message: `${f.message} (compared with the package made earlier)`, action: adviceFor("CONTRACT_CHANGED") });
    }
  }

  // Who may start it. Roles for human tasks are checked by nobody until a task is created, so they stay unresolved.
  if (environment.authority) {
    const principal = options.principal ?? "(unnamed principal)";
    if (!(await environment.authority.canStart(principal, recipe.id))) findings.push({ code: "RUNTIME_NOT_PERMITTED", severity: "error", scope: "authority", message: `${principal} may not start ${recipe.id} in ${environment.name}`, action: adviceFor("RUNTIME_NOT_PERMITTED") });
  } else unresolved.push({ subject: "who may start this recipe", why: "the environment declares no runtime authority" });
  for (const role of [...new Set(recipe.steps.flatMap((s) => (s.kind === "task" ? [s.assignee.role] : [])))].sort()) {
    unresolved.push({ subject: `role ${role}`, why: "whether this environment's authority defines this role who can answer is not checkable until a task exists; install records it as a requirement" });
  }

  const blocked = findings.some((f) => f.severity === "error");
  return { ...base, verdict: blocked ? "blocked" : unresolved.length ? "ready-with-unresolved" : "ready", findings, dependencies, unresolved };
}
