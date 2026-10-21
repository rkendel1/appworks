import { join } from "node:path";
import { writeFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { main, type CliEnvironment } from "../src/cli.js";
import { cli, studioEnvironment, supplierInvoice, tempDir, useCleanup } from "./support.js";

useCleanup();

async function environment(dir: string, options: Parameters<typeof studioEnvironment>[2] = {}): Promise<CliEnvironment> {
  const { studio } = await studioEnvironment(dir, "env", options);
  return { load: async () => ({ gateway: studio.gateway, authority: studio.authority! }) };
}

describe("appworks studio (the same functions as the page, from a terminal)", () => {
  it("new, import, validate, card and package", async () => {
    const dir = tempDir();
    const projects = join(dir, "projects");
    const env = await environment(dir);
    const created = await cli(main, ["new", "draft", "--dir", projects, "--id", "org.example.recipes.draft", "--name", "Draft", "--objective", "Try it", "--product", "product://example/draft", "--version", "0.1.0"], env);
    expect(created.code, created.err).toBe(0);
    // an empty recipe is not valid: it says so, with what to do, and does not claim anything about the environment
    const empty = await cli(main, ["validate", "draft", "--dir", projects, "--environment", "env.mjs"], env);
    expect(empty.code).toBe(1);
    expect(empty.out).toMatch(/^invalid/);

    const file = join(dir, "recipe.json");
    writeFileSync(file, JSON.stringify(supplierInvoice()));
    expect((await cli(main, ["import", "supplier", file, "--dir", projects], env)).code).toBe(0);
    const validated = await cli(main, ["validate", "supplier", "--dir", projects, "--environment", "env.mjs", "--principal", "alice", "--json"], env);
    expect(validated.code, validated.err).toBe(0);
    expect(JSON.parse(validated.out)).toMatchObject({ verdict: "ready-with-unresolved", executable: false });
    expect((await cli(main, ["validate", "supplier", "--dir", projects], env)).out).toMatch(/^unassessed/); // no environment: nothing established

    expect(JSON.parse((await cli(main, ["card", "supplier", "--dir", projects, "--json"], env)).out).rows).toHaveLength(6);
    const packaged = await cli(main, ["package", "supplier", "--dir", projects, "--environment", "env.mjs", "--json"], env);
    expect(packaged.code, packaged.err).toBe(0);
    expect(JSON.parse(packaged.out)).toMatchObject({ ok: true, executable: false });
    expect(existsSync(join(projects, "supplier", "recipe.package.json"))).toBe(true);
    expect((await cli(main, ["package", "draft", "--dir", projects, "--environment", "env.mjs"], env)).code).toBe(1); // an empty draft cannot be packaged
  });

  it("validate exits non-zero when the environment cannot run the recipe, and names why", async () => {
    const dir = tempDir();
    const env = await environment(dir, { grant: false });
    await cli(main, ["import", "supplier", (writeFileSync(join(dir, "r.json"), JSON.stringify(supplierInvoice())), join(dir, "r.json")), "--dir", join(dir, "p")], env);
    const r = await cli(main, ["validate", "supplier", "--dir", join(dir, "p"), "--environment", "env.mjs"], env);
    expect(r.code).toBe(1);
    expect(r.out).toContain("blocked in env");
    expect(r.out).toContain("ACCESS_DENIED");
  });

  it("serve starts the page on loopback", async () => {
    const dir = tempDir();
    const env = await environment(dir);
    let stop: (() => Promise<void>) | undefined;
    let origin = "";
    const started = new Promise<void>((resolve) => (env.onServing = (o, s) => ((origin = o), (stop = s), resolve())));
    const served = cli(main, ["serve", "--dir", join(dir, "p"), "--environment", "env=env.mjs"], env);
    await started;
    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((await fetch(`${origin}/`)).status).toBe(200);
    await stop!();
    expect((await served).code).toBe(0);
  });

  it("usage errors are usage errors", async () => {
    expect((await cli(main, ["new"], {})).code).toBe(2);
    expect((await cli(main, ["new", "x", "--dir", tempDir()], {})).code).toBe(2);
    expect((await cli(main, ["serve", "--dir", tempDir()], {})).code).toBe(2);
    expect((await cli(main, ["open", "--dir", tempDir()], {})).code).toBe(2);
  });
});
