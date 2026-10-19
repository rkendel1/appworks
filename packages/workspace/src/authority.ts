/**
 * Who may do what. The workspace asks an authority before every read and every mutation and never decides by itself;
 * the default is a small, local policy (principal → permitted actions) for a single-operator CLI and a loopback web
 * workspace. An AuthBoundry deployment (an HTTP authority) can stand behind the same port: AppWorks defines no
 * authorization semantics of its own beyond naming its actions.
 *
 * Authority and approval are separate. Being permitted to execute an extraction is not having approved it: the action
 * boundary requires both (`workflow.ts`).
 */
import { WorkspaceError, type CredentialReference, type Principal } from "./model.js";

/**
 * Actions: `project.read`, `project.create`, `project.advance` (workflow steps), `project.cancel`, `approval.grant:<action>`
 * (granting an approval for one action class), `action:<action>` (performing an approved action) and `github:<capability>`
 * (a @appport/github capability, e.g. `github:github.repository.read`).
 */
export interface Authority {
  decide(principal: Principal, action: string, resource: { project?: string }): Promise<{ allowed: boolean; reason?: string }>;
}

/** A static policy: each principal's permitted actions, where `prefix*` matches by prefix and `*` matches everything. */
export function localAuthority(policy: Record<string, string[]>): Authority {
  return {
    async decide(principal, action) {
      const granted = policy[principal.id] ?? [];
      const allowed = granted.some((g) => g === action || g === "*" || (g.endsWith("*") && action.startsWith(g.slice(0, -1))));
      return allowed ? { allowed } : { allowed, reason: `${principal.id} is not permitted ${action}` };
    }
  };
}

export async function requireAllowed(authority: Authority, principal: Principal, action: string, resource: { project?: string } = {}): Promise<void> {
  const decision = await authority.decide(principal, action, resource);
  if (!decision.allowed) throw new WorkspaceError("UNAUTHORIZED", decision.reason ?? `${principal.id} is not permitted ${action}`, { action });
}

/**
 * Resolves a credential reference to its value at the moment of use. Values are never returned to callers that persist
 * or log, never written to FeltDB, artifacts or run records, and never put in a command line.
 */
export interface CredentialResolver {
  resolve(reference: CredentialReference, purpose: { capability: string; project?: string }): Promise<string>;
}

/** Environment-variable references (`env:GITHUB_TOKEN`). The secret stays in the process environment it came from. */
export function environmentCredentials(env: NodeJS.ProcessEnv = process.env): CredentialResolver {
  return {
    async resolve(reference) {
      if (reference.provider !== "env") throw new WorkspaceError("CREDENTIAL_UNAVAILABLE", `credential provider ${reference.provider} is not supported`);
      const value = env[reference.secretId];
      if (!value) throw new WorkspaceError("CREDENTIAL_UNAVAILABLE", `the credential ${reference.provider}:${reference.secretId} is not set`);
      return value;
    }
  };
}

/** `env:NAME` → a reference. Anything that looks like a secret value rather than a name is refused. */
export function parseCredentialReference(text: string): CredentialReference {
  const m = /^env:([A-Z_][A-Z0-9_]{0,63})$/.exec(text);
  if (!m) throw new WorkspaceError("INVALID_INPUT", "a credential is given by reference only, as env:NAME (an environment variable name), never as a value");
  return { provider: "env", secretId: m[1]! };
}
