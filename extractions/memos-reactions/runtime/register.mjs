// Lets the Memos bridge modules, loaded in place from the Memos checkout (MEMOS_REPO), resolve their published
// @appport/* imports from this package's installed copies (the exact versions the bridge's package-lock.json pins),
// instead of from a node_modules inside the checkout. Nothing is installed into, copied from or written to the checkout.
import { register } from "node:module";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const repo = process.env.MEMOS_REPO;
if (repo) register("./resolve-hooks.mjs", import.meta.url, { data: { bridge: pathToFileURL(realpathSync(repo)).href + "/appport-bridge/", base: import.meta.url } });
