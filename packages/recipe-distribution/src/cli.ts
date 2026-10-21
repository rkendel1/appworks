#!/usr/bin/env node
/**
 * `appworks package ...` (spec/distribution-1.md §7): keygen, trust, publish, verify, install, list, show. Every refusal names the
 * stage that refused it. Installing is not authorizing, and no command here runs a recipe (`appworks recipe run --package` does).
 *
 *   package keygen  --publisher <publisher://id> --out <dir> [--key-id key-1]
 *   package trust   --publisher-document <publisher.json> --policy <file>
 *   package publish <recipe.json> --channel <dir> --product <product://ns/slug> --version <semver> --key <dir> --environment <module> [--name <text>] [--source-revision <rev>]
 *   package verify  --channel <dir> --product <id> --version <v> --digest <sha256:…> --policy <file> [--recipe <id>]
 *   package install --channel <dir> --product <id> --version <v> --digest <sha256:…> --policy <file> --store <dir> --environment <module>
 *   package list    --store <dir>
 *   package show    <installed-dir>
 *
 * Exit status: 0 done, 1 refused or error (the stage is printed), 2 usage.
 */
import { mkdirSync, readFileSync, realpathSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createPrivateKey } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPublisherDocument, createTrustPolicy, documentIdOf, exportPublicKey, generatePublisherKeypair, signPublisherDocument } from "@distribution-protocol/protocol";
import type { RecipeSource } from "@appport/recipe";
import { FileChannel, type PublisherEnvelope } from "./channel.js";
import { packageForPublish, publishRecipePackage } from "./publish.js";
import { acquireRecipePackage } from "./acquire.js";
import { InstallStore, installRecipePackage, readInstalledPackage, type InstallEnvironment } from "./install.js";

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
}
export interface LoadedEnvironment {
  gateway: InstallEnvironment;
}
export interface CliEnvironment {
  load?(modulePath: string, context: { home: string }): Promise<LoadedEnvironment>;
  now?: () => Date;
}

const USAGE = `usage:
  appworks package keygen  --publisher <publisher://id> --out <dir> [--key-id key-1]
  appworks package trust   --publisher-document <publisher.json> --policy <file>
  appworks package publish <recipe.json> --channel <dir> --product <product://ns/slug> --version <semver> --key <dir> --environment <module> [--name <text>] [--source-revision <rev>]
  appworks package verify  --channel <dir> --product <id> --version <v> --digest <sha256:…> --policy <file> [--recipe <id>]
  appworks package install --channel <dir> --product <id> --version <v> --digest <sha256:…> --policy <file> --store <dir> --environment <module>
  appworks package list    --store <dir>
  appworks package show    <installed-dir>
  (add --json for machine output)`;

function parse(args: string[]): { positional: string[]; options: Record<string, string | true> } {
  const positional: string[] = [];
  const options: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--")) positional.push(a);
    else {
      const next = args[i + 1];
      if (a === "--json" || next === undefined || next.startsWith("--")) options[a.slice(2)] = true;
      else {
        options[a.slice(2)] = next;
        i++;
      }
    }
  }
  return { positional, options };
}

async function defaultLoad(modulePath: string, context: { home: string }): Promise<LoadedEnvironment> {
  const loaded = (await import(pathToFileURL(resolve(modulePath)).href)) as { default?: (c: { home: string }) => LoadedEnvironment | Promise<LoadedEnvironment> };
  if (typeof loaded.default !== "function") throw new Error(`${modulePath} must default-export a function returning { gateway }`);
  return loaded.default(context);
}

class Usage extends Error {}
const need = (options: Record<string, string | true>, name: string): string => {
  const v = options[name];
  if (typeof v !== "string") throw new Usage(`--${name} is required`);
  return v;
};

export async function main(argv: string[], io: CliIO = { out: (t) => process.stdout.write(`${t}\n`), err: (t) => process.stderr.write(`${t}\n`) }, environment: CliEnvironment = {}): Promise<number> {
  const args = argv[0] === "package" ? argv.slice(1) : argv;
  const [command, ...rest] = args;
  const { positional, options } = parse(rest);
  const json = options["json"] === true;
  const say = (human: string[], machine: unknown) => io.out(json ? JSON.stringify(machine, null, 2) : human.join("\n"));
  const load = async () => (environment.load ?? defaultLoad)(need(options, "environment"), { home: resolve(String(options["home"] ?? ".")) });
  try {
    switch (command) {
      case "keygen": {
        const publisher = need(options, "publisher");
        const keyId = typeof options["key-id"] === "string" ? options["key-id"] : "key-1";
        const out = resolve(need(options, "out"));
        const { publicKey, privateKey } = generatePublisherKeypair();
        const envelope = signPublisherDocument(createPublisherDocument({ publisher, keys: [{ id: keyId, algorithm: "ed25519", publicKey: exportPublicKey(publicKey), notBefore: new Date(Date.now() - 86_400_000).toISOString().replace(/\.\d+Z$/, "Z"), notAfter: new Date(Date.now() + 5 * 365 * 86_400_000).toISOString().replace(/\.\d+Z$/, "Z") }] }), privateKey, { keyId });
        mkdirSync(out, { recursive: true });
        writeFileSync(join(out, "private.pem"), (privateKey as { export(o: object): string }).export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
        writeFileSync(join(out, "publisher.json"), `${JSON.stringify([envelope], null, 2)}\n`);
        const documentId = documentIdOf(envelope.document);
        say([`publisher ${publisher}, key ${keyId}`, `  private key: ${join(out, "private.pem")} (keep it; it signs your releases)`, `  document:    ${join(out, "publisher.json")}`, `  document id: ${documentId}  (consumers anchor trust on this)`], { publisher, keyId, documentId });
        return 0;
      }
      case "trust": {
        const lineage = JSON.parse(readFileSync(resolve(need(options, "publisher-document")), "utf8")) as PublisherEnvelope[];
        const head = lineage.at(-1)!;
        const publisher = head.document.publisher.id as string;
        const file = resolve(need(options, "policy"));
        const current = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as ReturnType<typeof createTrustPolicy>) : createTrustPolicy();
        const documents = { ...current.documents, [publisher]: [{ documentId: documentIdOf(head.document), sequence: head.document.sequence ?? 1 }] };
        const policy = createTrustPolicy({ publishers: [...new Set([...current.publishers, publisher])], keys: current.keys, documents });
        writeFileSync(file, `${JSON.stringify(policy, null, 2)}\n`);
        say([`trusting ${publisher}, anchored on document ${documentIdOf(head.document)}`], { publisher, documentId: documentIdOf(head.document) });
        return 0;
      }
      case "publish": {
        const recipeFile = positional[0];
        if (!recipeFile) throw new Usage("a recipe file is required");
        const recipe = JSON.parse(readFileSync(resolve(recipeFile), "utf8")) as RecipeSource;
        const keyDir = resolve(need(options, "key"));
        const lineage = JSON.parse(readFileSync(join(keyDir, "publisher.json"), "utf8")) as PublisherEnvelope[];
        const head = lineage.at(-1)!;
        const loaded = await load();
        // The portable lock pins the contract revisions of the publisher's own environment; it carries no provider and grants nothing.
        const snapshot = await loaded.gateway.snapshot(recipe.requires);
        const pkg = packageForPublish(recipe, snapshot, { file: recipeFile, ...(typeof options["source-revision"] === "string" ? { revision: options["source-revision"] } : {}) });
        const result = publishRecipePackage({
          channel: new FileChannel(resolve(need(options, "channel"))), package: pkg,
          product: { id: need(options, "product"), name: typeof options["name"] === "string" ? options["name"] : recipe.name, version: need(options, "version") },
          signer: { publisher: head.document.publisher.id, keyId: head.signature.keyId!, privateKey: createPrivateKey(readFileSync(join(keyDir, "private.pem"), "utf8")), lineage },
          interfaces: [{ id: "recipe", type: "library" }]
        });
        say([`${result.status}: ${result.releaseId}`, `  package digest:  ${result.package.digest}   (tell consumers this, out of band; they pin it)`, `  artifact digest: ${result.artifact.digest}`], result);
        return 0;
      }
      case "verify":
      case "install": {
        const policy = JSON.parse(readFileSync(resolve(need(options, "policy")), "utf8")) as unknown;
        const acquired = await acquireRecipePackage({ channel: new FileChannel(resolve(need(options, "channel"))), product: need(options, "product"), version: need(options, "version"), expect: { digest: need(options, "digest"), ...(typeof options["recipe"] === "string" ? { recipe: options["recipe"] } : {}) }, trust: { policy }, ...(environment.now ? { now: environment.now } : {}) });
        if (!acquired.ok) {
          io.err(json ? JSON.stringify({ ok: false, stage: acquired.stage, reason: acquired.reason }) : `refused at ${acquired.stage}: ${acquired.reason}`);
          return 1;
        }
        if (command === "verify") {
          say([`verified ${acquired.receipt!["release"]}`, `  package ${acquired.package!.digest} (${acquired.package!.recipe.id})`, `  publisher trust: ${acquired.publisherTrust}; installable: ${acquired.installable}; executable: false`], { ok: true, stage: "accepted", installable: acquired.installable, receipt: acquired.receipt });
          return 0;
        }
        const loaded = await load();
        const store = new InstallStore(resolve(need(options, "store")));
        const installed = await installRecipePackage({ store, acquired, environment: loaded.gateway, ...(environment.now ? { now: environment.now } : {}) });
        if (!installed.ok) {
          io.err(json ? JSON.stringify({ ok: false, stage: installed.stage, reason: installed.reason, findings: installed.findings }) : [`refused at ${installed.stage}: ${installed.reason}`, ...((installed.findings as unknown[] | undefined) ?? []).map((f) => `  ${typeof f === "string" ? f : `${(f as { code: string }).code} ${(f as { path: string }).path}`}`)].join("\n"));
          return 1;
        }
        say([`${installed.stage}: ${installed.record!.release.id}`, `  ${installed.dir}`, `  authorizes nothing: grants are the environment's`, `  run it: appworks recipe run --package ${installed.dir} --input … --environment …`], { ok: true, stage: installed.stage, dir: installed.dir, record: installed.record });
        return 0;
      }
      case "list": {
        const records = new InstallStore(resolve(need(options, "store"))).list();
        say(records.length ? records.map((r) => `${r.release.id}  ${r.package.recipe}  ${r.package.digest}`) : ["nothing installed"], records);
        return 0;
      }
      case "show": {
        const dir = positional[0];
        if (!dir) throw new Usage("an installed directory is required");
        const read = readInstalledPackage(resolve(dir));
        say([read.ok ? "intact" : "NOT intact", ...read.findings.map((f) => `  ${f}`), ...(read.record ? [`  ${read.record.release.id}  ${read.record.package.digest}`] : [])], read);
        return read.ok ? 0 : 1;
      }
      default:
        io.err(USAGE);
        return 2;
    }
  } catch (error) {
    if (error instanceof Usage) {
      io.err(`${error.message}\n${USAGE}`);
      return 2;
    }
    io.err(`error: ${(error as Error).message}`);
    return 1;
  }
}

const invoked = process.argv[1]
  ? (() => {
      try {
        return realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url));
      } catch {
        return false;
      }
    })()
  : false;
if (invoked) void main(process.argv.slice(2)).then((code) => (process.exitCode = code));
