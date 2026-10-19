/**
 * The workspace pages: one HTML document per page, inlining the vendored stack-ui static release (tokens, core styles,
 * the stateless DOM build), the workspace's own styles and its page script, exactly as AppPort Services renders its
 * management pages. The page script builds every node with stack-ui's DOM helpers and `createElement`/`textContent`;
 * it never parses markup. The vendored files are checked against the release's SHA256SUMS before they are served.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
export const STACK_UI_FILES = ["tokens.css", "core.css", "stack-ui-core-stateless.js", "stack-ui-core.js"] as const;

/** Every vendored file against the release's checksums; a modified or missing file stops the pages from rendering. */
export function verifyVendoredStackUi(): { version: string; files: Record<string, string> } {
  const sums = Object.fromEntries(
    read("vendor/stack-ui/SHA256SUMS")
      .trim()
      .split("\n")
      .map((line) => line.split(/\s+/))
      .map(([hash, file]) => [file!, hash!])
  );
  for (const file of STACK_UI_FILES) {
    const actual = createHash("sha256").update(readFileSync(new URL(`../vendor/stack-ui/${file}`, import.meta.url))).digest("hex");
    if (sums[file] !== actual) throw new Error(`vendor/stack-ui/${file} does not match the stack-ui release's SHA256SUMS`);
  }
  return { version: read("vendor/stack-ui/VERSION").trim(), files: sums };
}

let assets: { style: string; designSystem: string; page: string; version: string } | undefined;
function loadAssets() {
  if (assets) return assets;
  const { version } = verifyVendoredStackUi();
  assets = {
    style: [read("vendor/stack-ui/tokens.css"), read("vendor/stack-ui/core.css"), read("ui/workspace.css")].join("\n"),
    // The stateless build: these pages keep nothing in browser storage.
    designSystem: read("vendor/stack-ui/stack-ui-core-stateless.js"),
    page: read("ui/workspace.js"),
    version
  };
  return assets;
}

/** JSON that is safe inside a <script> element: no `<`, and no line separators. */
const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
const escapeText = (value: string) => value.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const hash = (text: string) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

export interface PageDescription {
  page: "projects" | "project";
  project?: string;
  principal: string;
}

export function renderPage(description: PageDescription): string {
  const { style, designSystem, page } = loadAssets();
  const title = description.page === "projects" ? "AppWorks workspace" : `AppWorks · ${description.project}`;
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${escapeText(title)}</title><style>${style}</style></head><body>` +
    '<noscript><p class="appworks-noscript">The AppWorks workspace needs JavaScript. The same information is available from <code>appworks project show</code>.</p></noscript>' +
    `<script type="application/json" id="appworks-page">${scriptJson(description)}</script>` +
    `<script>${designSystem}</script><script>${page}</script>` +
    "</body></html>"
  );
}

/** A content security policy that admits exactly the inlined scripts and styles, and requests to this server only. */
export function pageSecurityHeaders(): Record<string, string> {
  const { style, designSystem, page } = loadAssets();
  return {
    "content-security-policy": `default-src 'none'; script-src ${hash(designSystem)} ${hash(page)}; style-src ${hash(style)}; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store"
  };
}
