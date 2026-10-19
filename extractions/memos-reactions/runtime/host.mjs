// Hosts memos.reactions.list@1 in the EXISTING Memos AppPort bridge, unmodified, at the extraction's source revision.
//
// The bridge's own modules are loaded from the Memos checkout (MEMOS_REPO), not copied: its capabilities (memos.search,
// memos.get), its kit (startBridge: one AppPort server, trusted-boundary authentication, permissionAuthorizer; and
// callApplication: Memos' HTTP API with the caller's credential) and its entry point (runBridgeMain: environment
// configuration, ready line). This file only adds the extracted capability to the same server, so it is reached by
// the same transport, authentication and authorization as the bridge's own capabilities. The descriptor below is the
// bridge's build() configuration; the behavioral suite checks the composed manifest against the unmodified bridge's.
//
// It also publishes the capability's fulfillment claim (runtime/fulfillment.json, checked against contract.json by
// runtime/declaration.mjs) through the bridge's startBridge extensions and attributes, which the bridge passes to
// AppPort's createApplication from rkendel1/memos e0ce856 on. A declaration that is missing, malformed, mismatched,
// stale or not actually published stops the host with a reason code. APPWORKS_FULFILLMENT_DECLARATION names another
// declaration file (used by the negative tests); it is checked exactly the same way.
//
//   MEMOS_REPO=<checkout> APPPORT_BRIDGE_UPSTREAM=http://127.0.0.1:5230 node --import ./runtime/register.mjs runtime/host.mjs

import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { memoReactionsCapability, CAPABILITY } from "./adapter.mjs";
import { confirmPublished, loadDeclaration } from "./declaration.mjs";

const repo = process.env.MEMOS_REPO;
if (!repo) throw new Error("MEMOS_REPO is not set: it names the Memos checkout whose bridge hosts the capability");
const load = (path) => import(pathToFileURL(join(repo, "appport-bridge", path)).href);
const kit = await load("lib/bridge-kit.mjs");
const bridge = await load("bridge.mjs");

const SCOPE = "memos.read";
const here = dirname(fileURLToPath(import.meta.url));
const declaration = loadDeclaration({
  contractPath: join(here, "..", "contract.json"),
  declarationPath: process.env.APPWORKS_FULFILLMENT_DECLARATION || join(here, "fulfillment.json"),
  provider: CAPABILITY
});

export async function build(config) {
  const upstream = { baseUrl: config.upstream, headers: (credential) => ({ authorization: credential }) };
  const running = await kit.startBridge({
    application: { id: "com.usememos.memos", name: "Memos", version: "appport-bridge-1", description: "Memos notes, read through Memos' own API with the caller's own access token." },
    capabilities: [...bridge.capabilities(upstream), memoReactionsCapability({ callApplication: kit.callApplication, upstream, scope: SCOPE })],
    resources: [{ id: "urn:appport:memos:memos", kind: "collection", owner: "self", description: "Memos stored by this Memos instance." }],
    scopes: [SCOPE],
    publish: config.publish,
    publishCapabilities: [{ name: "memos.search", version: 1, purpose: true }, { name: "memos.get", version: 1, purpose: true }, { name: CAPABILITY.name, version: CAPABILITY.version, purpose: true }],
    host: config.host,
    port: config.port,
    extensions: declaration.extensions,
    attributes: declaration.attributes
  });
  try {
    await confirmPublished(running.url, declaration, CAPABILITY);
  } catch (error) {
    await running.close();
    throw error;
  }
  return running;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await kit.runBridgeMain(build);
