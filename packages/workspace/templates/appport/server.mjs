// The AppPort integration of {{REPOSITORY}}, added by AppWorks. It publishes AppPort discovery for the
// application; capabilities are added here as they are extracted, each with its contract, adapter and verification.
// It listens on loopback only. APPPORT_PORT overrides the port (0 picks a free one).
import { createApplication, createServer, permissionAuthorizer } from "@appport/sdk";
import { serve } from "@appport/sdk/node";

export const capabilities = [];

const application = createApplication({
  application: {{APPLICATION}},
  capabilities,
  authorizer: permissionAuthorizer()
});
const server = createServer({ application, publication: { public: true, applicationDescription: true, capabilities: capabilities.map((c) => ({ name: c.name, version: c.version })) } });
const running = await serve({ server, host: "127.0.0.1", port: Number(process.env.APPPORT_PORT ?? {{PORT}}), websocket: false });
console.log(`AppPort for {{APPLICATION_ID}} on ${running.url}`);
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => void running.close().then(() => process.exit(0)));
