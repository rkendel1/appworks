import { createApplication, createServer, defineCapability, permissionAuthorizer, s } from "@appport/sdk";
import { serve } from "@appport/sdk/node";
import { claimFor, type AppPortManifest } from "@appport/protocol";

/** A real AppPort application, served over HTTP with public discovery, that counts invocations. */
export async function application(options: { claimAgainst?: AppPortManifest } = {}) {
  let invoked = 0;
  // AppPort 1.4 reserves the application attribute `appport.fulfillment/1`: a claim is declared on the capability it is made for (`fulfills`).
  const claim = options.claimAgainst ? claimFor(options.claimAgainst, "note.get", 1) : undefined;
  const get = defineCapability({
    name: "note.get",
    version: 1,
    description: "Read a note.",
    input: s.object({ name: s.string() }),
    output: s.object({ name: s.string(), body: s.string() }),
    effect: "observation",
    authorization: ["notes.read"],
    ...(claim ? { fulfills: [claim] } : {}),
    handler: async ({ name }: { name: string }) => {
      invoked++;
      return { name, body: "" };
    }
  } as never);
  const app = createApplication({ application: { id: "com.example.notes", name: "Notes", version: "1.0.0" }, capabilities: [get], authorizer: permissionAuthorizer() });
  const server = createServer({ application: app, publication: { public: true, applicationDescription: true, capabilities: [{ name: "note.get", version: 1 }] } } as never);
  const running = await serve({ server, host: "127.0.0.1", port: 0, websocket: false } as never);
  const url = (running as { url: string }).url.replace(/\/$/, "");
  // The authoritative manifest, as any client reads it.
  const manifest = async () => {
    const wellKnown = (await (await fetch(`${url}/.well-known/appport`)).json()) as { manifest: string };
    return (await (await fetch(new URL(wellKnown.manifest, url))).json()) as AppPortManifest;
  };
  return { url, close: () => (running as { close(): Promise<void> }).close(), invocations: () => invoked, manifest };
}

