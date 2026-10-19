// Adapter: the AppPort capability memos.reactions.list@1 over Memos' MemoService.ListMemoReactions.
//
// It is one capability definition for the EXISTING Memos AppPort bridge (appport-bridge/, trusted-boundary mode). The
// invocation goes to Memos' own HTTP API, GET /api/{parent}/reactions, through the bridge kit's callApplication with the
// CALLER's own Memos credential. Memos' handler, its read-access check (checkMemoReadAccess) and its store answer every
// call; this module decides nothing about access, reads no database, stores nothing and has no credential of its own.
//
// Mapping (contract.json, extraction-plan.json): input fields pass through unchanged as query parameters; output fields
// are copied by name. An answer that does not have the shape the contract promises is an error, never a partial success.

import { AppPortError, defineCapability, s } from "@appport/sdk";

export const ADAPTER = Object.freeze({ name: "memos-reactions-adapter", version: "1.0.0" });
export const CAPABILITY = Object.freeze({ name: "memos.reactions.list", version: 1 });

/** Memo resource names, exactly as the bridge's memos.get accepts them. */
export const MEMO_NAME_PATTERN = "^memos/[A-Za-z0-9_-]{1,64}$";
const INT32 = { minimum: -2147483648, maximum: 2147483647 };

const Reaction = s.object({
  name: s.string({ description: "memos/{memo}/reactions/{reaction}" }),
  creator: s.string({ description: "users/{user}" }),
  reactionType: s.string(),
  createTime: s.string({ format: "date-time" })
});

const malformed = (what) => new AppPortError("INTERNAL_ERROR", `the application answered with an unexpected shape (${what})`);
const text = (value, what) => {
  if (typeof value !== "string") throw malformed(what);
  return value;
};

/**
 * Maps Memos' ListMemoReactionsResponse (proto3 JSON, as Memos' gateway writes it) to the capability output. Absent
 * repeated and string fields mean their proto3 defaults ([] and ""); any other deviation is refused.
 */
export function toCapabilityOutput(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw malformed("not an object");
  const reactions = body.reactions ?? [];
  if (!Array.isArray(reactions)) throw malformed("reactions is not a list");
  return {
    reactions: reactions.map((r, i) => {
      if (r === null || typeof r !== "object" || Array.isArray(r)) throw malformed(`reactions[${i}]`);
      return {
        name: text(r.name, `reactions[${i}].name`),
        creator: text(r.creator, `reactions[${i}].creator`),
        reactionType: text(r.reactionType, `reactions[${i}].reactionType`),
        createTime: text(r.createTime, `reactions[${i}].createTime`)
      };
    }),
    nextPageToken: text(body.nextPageToken ?? "", "nextPageToken")
  };
}

/**
 * @param {object} o
 * @param {Function} o.callApplication  the bridge kit's callApplication (lib/bridge-kit.mjs at the source revision)
 * @param {object} o.upstream           the bridge's upstream: { baseUrl, headers(credential) }
 * @param {string} o.scope              the bridge's scope (memos.read)
 */
export function memoReactionsCapability({ callApplication, upstream, scope }) {
  return defineCapability({
    name: CAPABILITY.name,
    version: CAPABILITY.version,
    description: "List the reactions on one memo, if Memos lets the caller read that memo.",
    input: s.object({
      parent: s.string({ pattern: MEMO_NAME_PATTERN, description: "Memo resource name, e.g. memos/AbC123" }),
      pageSize: s.optional(s.integer(INT32)),
      pageToken: s.optional(s.string())
    }),
    output: s.object({ reactions: s.array(Reaction), nextPageToken: s.string() }),
    effect: "observation",
    authorization: [scope],
    authorizationContract: { required: true, scopes: [scope] },
    integration: {
      purpose: "List the reactions on a memo the caller may read.",
      authority: "urn:appport:memos",
      approval: { required: false },
      access: [{ resource: "urn:appport:memos:memos", mode: "reads" }]
    },
    handler: async ({ parent, pageSize, pageToken }, ctx) => {
      // parent is pattern-checked by the contract before this runs: memos/<uid>, no path separators.
      const body = await callApplication(ctx, upstream, { path: `/api/${parent}/reactions`, query: { pageSize, pageToken } });
      return toCapabilityOutput(body);
    }
  });
}
