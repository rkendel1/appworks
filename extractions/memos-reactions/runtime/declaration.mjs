// The fulfillment declaration the host publishes for memos.reactions.list@1: an AppPort fulfillment claim
// (appport.fulfillment/1, @appport/protocol 1.2.0), in the reviewed file runtime/fulfillment.json.
//
// The declaration is checked against contract.json before it is published, and against the bridge's published manifest
// after: a declaration that is missing, malformed, names another contract or capability, pins a stale contract digest,
// or is not actually published, stops the host with a reason code. Nothing is derived silently or repaired.
//
// A fulfillment claim is a declaration about the provider's interface. It grants no caller any permission: every call
// is still authenticated by the bridge, authorized by AppPort and decided by Memos.

import { readFileSync } from "node:fs";
import { FULFILLMENT_EXTENSION, canonicalize, claimFor, fulfillmentAttributes, fulfillmentClaims, getFulfillment, isCanonicalContract } from "@appport/protocol";

export class DeclarationError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "DeclarationError";
    this.code = code;
  }
}

const read = (path, missing, what) => {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new DeclarationError(missing, `${what} ${path} cannot be read`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new DeclarationError("FULFILLMENT_MALFORMED", `${what} ${path} is not JSON`);
  }
};

/** What `fulfillmentAttributes` produces for exactly one claim of `provider` on the contract's capability. */
export function expectedDeclaration(contract, provider) {
  if (!isCanonicalContract(contract)) throw new DeclarationError("CONTRACT_NOT_CANONICAL", `${contract?.application?.id} does not advertise appport.canonical-contract/1`);
  let claim;
  try {
    claim = claimFor(contract, provider.name, provider.version);
  } catch (error) {
    throw new DeclarationError("CONTRACT_CAPABILITY_MISSING", error.message);
  }
  return fulfillmentAttributes({ capabilities: { [`${provider.name}@${provider.version}`]: [claim] } });
}

/**
 * Loads and checks the declaration. Reason codes: FULFILLMENT_MISSING, FULFILLMENT_MALFORMED, FULFILLMENT_MISMATCH
 * (another contract, capability, version or provider capability, or anything beyond the one claim), FULFILLMENT_STALE
 * (the claim pins a digest other than the contract's current capability digest), CONTRACT_NOT_CANONICAL,
 * CONTRACT_CAPABILITY_MISSING.
 */
export function loadDeclaration({ contractPath, declarationPath, provider }) {
  const contract = read(contractPath, "CONTRACT_MISSING", "contract");
  const expected = expectedDeclaration(contract, provider);
  const declared = read(declarationPath, "FULFILLMENT_MISSING", "fulfillment declaration");
  if (declared === null || typeof declared !== "object" || !Array.isArray(declared.extensions) || !declared.extensions.includes(FULFILLMENT_EXTENSION) || !getFulfillment(declared))
    throw new DeclarationError("FULFILLMENT_MALFORMED", `the declaration does not advertise ${FULFILLMENT_EXTENSION} with a capabilities map`);
  const claims = fulfillmentClaims(declared, provider.name, provider.version);
  if (!claims.length) throw new DeclarationError("FULFILLMENT_MISSING", `the declaration makes no claim for ${provider.name}@${provider.version}`);
  const want = expected.attributes[FULFILLMENT_EXTENSION].capabilities[`${provider.name}@${provider.version}`][0];
  for (const claim of claims) {
    if (claim?.contract !== want.contract || claim.capability !== want.capability || claim.version !== want.version)
      throw new DeclarationError("FULFILLMENT_MISMATCH", `the claim names ${claim?.contract} ${claim?.capability}@${claim?.version}; the contract defines ${want.contract} ${want.capability}@${want.version}`);
    if (claim.digest !== want.digest) throw new DeclarationError("FULFILLMENT_STALE", `the claim pins ${claim.digest}; the contract's capability is now ${want.digest}`);
  }
  if (canonicalize(declared) !== canonicalize(expected)) throw new DeclarationError("FULFILLMENT_MISMATCH", "the declaration contains more than the one claim the contract supports");
  return declared;
}

/**
 * After the bridge starts: its own published manifest must carry the declaration exactly. A bridge that does not
 * publish manifest attributes (appport-bridge before rkendel1/memos e0ce856) fails here instead of serving an
 * undeclared capability.
 */
export async function confirmPublished(bridgeUrl, declared, provider) {
  const response = await fetch(new URL("appport/manifest", bridgeUrl.endsWith("/") ? bridgeUrl : `${bridgeUrl}/`), { redirect: "manual" });
  const manifest = response.ok ? await response.json() : undefined;
  const published = manifest ? fulfillmentClaims(manifest, provider.name, provider.version) : [];
  const want = fulfillmentClaims(declared, provider.name, provider.version);
  if (!manifest?.extensions?.includes(FULFILLMENT_EXTENSION) || canonicalize(published) !== canonicalize(want))
    throw new DeclarationError("FULFILLMENT_UNPUBLISHED", "the bridge did not publish the fulfillment declaration in its manifest (does its startBridge pass manifest attributes?)");
}
