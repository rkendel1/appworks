/**
 * `appworks package ...`: the whole operator flow through the CLI, against a real AppPort environment and a real channel directory.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main, type CliEnvironment } from "../src/cli.js";
import { canonicalEnvironment, example } from "../../recipe/test/fixtures.js";

let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "package-cli-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const cli = async (args: string[], env: CliEnvironment = {}) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(args, { out: (t) => out.push(t), err: (t) => err.push(t) }, env);
  return { code, out: out.join("\n"), err: err.join("\n") };
};
async function environment(providers?: string[]): Promise<CliEnvironment> {
  const env = await canonicalEnvironment(providers ? { providers } : {});
  const recipe = example();
  return {
    load: async () => ({
      gateway: {
        snapshot: async (requires) => ({ contracts: (await env.snapshot()).contracts, providers: Object.fromEntries(await Promise.all(requires.map(async (d) => [d.id, { eligible: (await env.resolve(recipe, d.id)).kind === "resolved" ? 1 : 0 }]))) }),
        resolve: async () => (await env.records(recipe)) as never
      }
    })
  };
}

describe("appworks package", () => {
  it("keygen, trust, publish, verify, install, list, show: the operator flow, and each refusal names its stage", async () => {
    const recipeFile = join(dir, "recipe.json");
    writeFileSync(recipeFile, JSON.stringify(example()));
    const keys = join(dir, "keys");
    const channel = join(dir, "channel");
    const policy = join(dir, "trust.json");
    const store = join(dir, "installed");
    const env = await environment();

    const keygen = await cli(["package", "keygen", "--publisher", "publisher://example", "--out", keys]);
    expect(keygen.code).toBe(0);
    expect(keygen.out).toContain("document id: sha256:");
    expect(existsSync(join(keys, "private.pem"))).toBe(true);

    const published = await cli(["package", "publish", recipeFile, "--channel", channel, "--product", "product://example/supplier-invoice", "--version", "1.0.0", "--key", keys, "--environment", "env.mjs", "--source-revision", "abc123", "--json"], env);
    expect(published.code).toBe(0);
    const { package: { digest } } = JSON.parse(published.out);
    expect(digest).toMatch(/^sha256:/);
    const again = ["package", "publish", recipeFile, "--channel", channel, "--product", "product://example/supplier-invoice", "--version", "1.0.0", "--key", keys, "--environment", "env.mjs", "--json"];
    expect((await cli([...again, "--source-revision", "abc123"], env)).out).toContain('"status": "unchanged"'); // identical: a no-op
    const changed = await cli([...again, "--source-revision", "def456"], env); // other provenance is another package, and a version never changes
    expect(changed.code).toBe(1);
    expect(changed.err).toContain("already published with different content");

    const common = ["--channel", channel, "--product", "product://example/supplier-invoice", "--version", "1.0.0", "--digest", digest, "--policy", policy];

    // Nothing is trusted yet: refused at `trust`, with no state written.
    writeFileSync(policy, JSON.stringify({ publishers: [], keys: {}, documents: {} }));
    const untrusted = await cli(["package", "install", ...common, "--store", store, "--environment", "env.mjs"], env);
    expect(untrusted.code).toBe(1);
    expect(untrusted.err).toContain("refused at trust");
    expect(existsSync(store)).toBe(false);

    expect((await cli(["package", "trust", "--publisher-document", join(keys, "publisher.json"), "--policy", policy])).code).toBe(0);
    const verified = await cli(["package", "verify", ...common]);
    expect(verified.code).toBe(0);
    expect(verified.out).toContain("installable: true; executable: false");

    const wrong = await cli(["package", "verify", ...common.map((a) => (a === digest ? `sha256:${"0".repeat(64)}` : a))]);
    expect(wrong.err).toContain("refused at binding");

    const installed = await cli(["package", "install", ...common, "--store", store, "--environment", "env.mjs", "--json"], env);
    expect(installed.code).toBe(0);
    expect(JSON.parse(installed.out)).toMatchObject({ ok: true, stage: "installed", record: { authorizes: "nothing" } });
    expect((await cli(["package", "list", "--store", store])).out).toContain("org.example.recipes.supplier-invoice");
    const dirOut = JSON.parse(installed.out).dir as string;
    expect((await cli(["package", "show", dirOut])).out).toContain("intact");
    writeFileSync(join(dirOut, "package.bin"), readFileSync(join(dirOut, "package.bin"), "utf8").replace("Supplier invoice processing", "Supplier invoice PROCESSING"));
    const shown = await cli(["package", "show", dirOut]);
    expect(shown.code).toBe(1);
    expect(shown.out).toContain("NOT intact");

    // An environment that cannot run it refuses, naming `environment` and the findings.
    const bare = await cli(["package", "install", ...common, "--store", join(dir, "installed2"), "--environment", "env.mjs"], await environment([]));
    expect(bare.code).toBe(1);
    expect(bare.err).toContain("refused at environment");
    expect(bare.err).toContain("ENV_NO_ELIGIBLE_PROVIDER");

    expect((await cli(["package", "publish"], env)).code).toBe(2);
    expect((await cli(["package"], env)).code).toBe(2);
  });
});
