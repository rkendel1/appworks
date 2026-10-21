"use strict";
// The Studio page. Every value reaches the DOM through textContent: nothing from a recipe or an environment is parsed as HTML.
const state = { slug: null, project: null, environment: null, environments: [], tab: "card", selected: null };
const $ = (id) => document.getElementById(id);

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, String(v));
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

async function api(path, options = {}) {
  const sep = path.includes("?") ? "&" : "?";
  const url = `/api${path}${state.environment ? `${sep}environment=${encodeURIComponent(state.environment)}` : ""}`;
  const res = await fetch(url, { method: options.method || "GET", headers: { "content-type": "application/json", "x-appworks-request": "studio" }, body: options.body ? JSON.stringify(options.body) : undefined });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ? body.error.message : `request failed (${res.status})`);
  return body;
}

function say(text, bad) { const n = $("notice"); n.textContent = text || ""; n.className = bad ? "bad" : ""; }
async function guard(fn) { try { say(""); await fn(); } catch (e) { say(e.message, true); } }

async function edit(edits, release) {
  const p = state.project;
  state.project = await api(`/projects/${p.slug}/edit`, { method: "POST", body: { revision: p.revision, edits, ...(release ? { release } : {}) } });
  say(`saved revision ${state.project.revision}`);
  await render();
}

async function loadProject(slug) {
  state.slug = slug;
  state.project = slug ? await api(`/projects/${slug}`) : null;
  await render();
}

async function refreshProjects(select) {
  const list = await api("/projects");
  const sel = $("project");
  sel.replaceChildren(h("option", { value: "" }, list.length ? "choose…" : "no recipes yet"), ...list.map((p) => h("option", { value: p.slug }, `${p.name || p.slug} (${p.slug})`)));
  if (select) sel.value = select;
}

const TABS = [["card", "Recipe card"], ["define", "Define"], ["steps", "Steps"], ["ready", "Readiness"], ["package", "Package"], ["source", "Source"]];

async function render() {
  const main = $("main");
  if (!state.project) { main.replaceChildren(h("p", { class: "mute" }, "Create a recipe or import one. A recipe is the portable business definition; providers, grants and trust belong to an environment and are never saved with it.")); return; }
  const tabs = h("nav", { class: "tabs" }, TABS.map(([id, label]) => h("button", { class: state.tab === id ? "on" : "", onclick: () => { state.tab = id; render(); } }, label)));
  const body = h("div", {});
  main.replaceChildren(tabs, body);
  await guard(async () => { await views[state.tab](body); });
}

const views = {
  async card(body) {
    const { card, reason } = await api(`/projects/${state.slug}/card`);
    if (!card) return body.append(h("p", { class: "sev-error" }, reason));
    const n = 2 + card.columns.length;
    const rows = card.rows.length ? card.rows : [null];
    const grid = rows.map((row, r) => h("tr", {},
      row ? h("td", { class: "name" }, row.name, h("small", {}, `${row.type}${row.required ? "" : " (optional)"}`)) : h("td", { class: "name mute" }, "no inputs"),
      h("td", {}, row ? row.prep : ""),
      card.columns.map((c) => {
        if (r < c.from || r > c.to) return h("td", {});
        if (r > c.from) return null;
        return h("td", { class: `step kind-${c.kind}`, rowspan: c.to - c.from + 1, title: c.step }, c.action, h("small", {}, c.step), c.next.length ? h("small", {}, c.next.map((x) => `${x.label}→${x.target}`).join(" · ")) : null);
      })));
    body.append(h("div", { class: "scroll" }, h("table", { class: "card" },
      h("tr", {}, h("th", { colspan: n }, card.title, " ", h("span", { class: "mute" }, `(${card.purpose})`))),
      card.setup.map((s) => h("tr", {}, h("td", { class: "wide", colspan: n }, s))),
      grid,
      h("tr", {}, h("td", { class: "wide", colspan: n }, h("b", {}, "Finish: "), card.finish.produces.join(", ") || "no outputs", card.finish.verifies.map((v) => h("small", {}, `verified: ${v}`)))),
      card.finish.ends.map((e) => h("tr", {}, h("td", { class: "wide", colspan: n }, `${e.step} → ${e.outcome}`, e.note ? h("small", {}, e.note) : null))))));
    body.append(h("p", { class: "mute" }, "The card is the portable recipe only. It names no provider and carries no authority."));
  },

  async define(body) {
    const r = state.project.recipe;
    const meta = {};
    const field = (key, label, value, area) => h("div", { class: "row" }, h("label", {}, label, area ? h("textarea", { rows: 2, onchange: (e) => (meta[key] = e.target.value) }, value || "") : h("input", { value: value || "", size: 48, onchange: (e) => (meta[key] = e.target.value) })));
    const release = state.project.release || {};
    const rel = { ...release };
    body.append(h("div", { class: "panel" }, h("h2", {}, "Recipe"),
      field("name", "Name", r.name), field("id", "Identity (reverse-domain)", r.id), field("objective", "Purpose", r.objective, true), field("description", "Description", r.description, true),
      h("h2", {}, "Intended release"), h("p", { class: "mute" }, "A recipe has no version; a release does. This is what you intend to publish it as. Distribution refuses to publish a different package under a version already published."),
      h("div", { class: "row" }, h("label", {}, "Product ", h("input", { value: release.product || "", placeholder: "product://namespace/slug", size: 36, onchange: (e) => (rel.product = e.target.value) })), h("label", {}, "Version ", h("input", { value: release.version || "", placeholder: "1.0.0", size: 10, onchange: (e) => (rel.version = e.target.value) }))),
      h("button", { class: "primary", onclick: () => guard(() => edit([{ op: "meta", ...meta }], rel)) }, "Save")));
    const fields = (where) => {
      const schema = r[where] || {}; const props = schema.properties || {}; const req = new Set(schema.required || []);
      const add = { name: "", type: "string", required: true, enum: "" };
      return h("div", { class: "panel" }, h("h2", {}, where === "inputs" ? "Inputs (what a run is started with)" : "Outputs (what a completed run produces)"),
        h("table", { class: "plain" }, Object.entries(props).map(([name, s]) => h("tr", {}, h("td", {}, name), h("td", {}, Array.isArray(s.type) ? s.type.join("|") : s.type || "any", s.enum ? ` (${s.enum.join(", ")})` : ""), h("td", {}, req.has(name) ? "required" : "optional"), h("td", {}, h("button", { onclick: () => guard(() => edit([{ op: "removeField", where, name }])) }, "Remove"))))),
        h("div", { class: "row" }, h("input", { placeholder: "field name", onchange: (e) => (add.name = e.target.value) }),
          h("select", { onchange: (e) => (add.type = e.target.value) }, ["string", "number", "integer", "boolean", "object", "array"].map((t) => h("option", {}, t))),
          h("input", { placeholder: "allowed values, comma separated", onchange: (e) => (add.enum = e.target.value) }),
          h("label", {}, h("input", { type: "checkbox", checked: true, onchange: (e) => (add.required = e.target.checked) }), " required"),
          h("button", { onclick: () => guard(() => edit([{ op: "field", where, name: add.name, required: add.required, schema: { type: add.type, ...(add.enum ? { enum: add.enum.split(",").map((x) => x.trim()) } : {}) } }])) }, "Add field")));
    };
    body.append(h("div", { class: "split" }, fields("inputs"), fields("outputs")));
  },

  async steps(body) {
    const r = state.project.recipe;
    const { capabilities, available } = await api("/catalog");
    const add = { step: "", cap: "", success: "", failure: "", uncertain: "" };
    const options = capabilities.flatMap((c) => c.versions.map((v) => ({ key: `${c.contract}|${c.capability}|${v.version}`, label: `${c.capability} @${v.version} (${v.effect}) — ${c.contract}` })));
    body.append(h("div", { class: "panel" }, h("h2", {}, "Add a step from a capability"),
      available ? null : h("p", { class: "sev-warning" }, "This environment does not list capabilities; steps can still be edited as JSON below."),
      h("div", { class: "row" }, h("select", { onchange: (e) => (add.cap = e.target.value) }, h("option", { value: "" }, "capability…"), options.map((o) => h("option", { value: o.key }, o.label))),
        h("input", { placeholder: "step id", onchange: (e) => (add.step = e.target.value) }), h("input", { placeholder: "on success →", onchange: (e) => (add.success = e.target.value) }), h("input", { placeholder: "on failure →", onchange: (e) => (add.failure = e.target.value) }), h("input", { placeholder: "on uncertain →", onchange: (e) => (add.uncertain = e.target.value) }),
        h("button", { class: "primary", onclick: () => guard(() => { const [contract, capability, version] = add.cap.split("|"); return edit([{ op: "addCapability", step: add.step, contract, capability, version: Number(version), on: { success: add.success, failure: add.failure, ...(add.uncertain ? { uncertain: add.uncertain } : {}) } }]); }) }, "Add")),
      h("p", { class: "mute" }, "The dependency, expected shapes, effect and declared verification come from the contract; same-named inputs are wired for you. Routes, other mappings and anything else are yours.")));
    const list = h("table", { class: "plain" }, h("tr", {}, h("th", {}, "Step"), h("th", {}, "Kind"), h("th", {}, "")), (r.steps || []).map((s) => h("tr", {}, h("td", {}, s.id, r.start === s.id ? " (start)" : ""), h("td", {}, s.kind), h("td", {}, h("button", { onclick: () => { state.selected = s.id; render(); } }, "Inspect")))));
    const detail = h("div", { class: "panel" }, h("h2", {}, state.selected ? `Step ${state.selected}` : "Select a step"));
    body.append(h("div", { class: "split" }, h("div", { class: "panel" }, h("h2", {}, "Steps"), list, h("div", { class: "row" }, h("label", {}, "Start at ", h("select", { onchange: (e) => guard(() => edit([{ op: "start", id: e.target.value }])) }, (r.steps || []).map((s) => h("option", { value: s.id, selected: r.start === s.id }, s.id)))))), detail));
    if (!state.selected) return;
    const step = (r.steps || []).find((s) => s.id === state.selected);
    if (!step) return;
    let text = JSON.stringify(step, null, 2);
    const ins = await api(`/projects/${state.slug}/steps/${state.selected}`).catch((e) => ({ error: e.message }));
    if (ins.error) detail.append(h("p", { class: "sev-warning" }, `Not inspectable yet: ${ins.error}`));
    else {
      if (ins.needs) detail.append(h("p", {}, h("b", {}, "Needs: "), ins.needs.map((f) => h("div", { class: f.required && !f.mapped ? "sev-error" : "" }, `${f.name} (${f.type}${f.required ? ", required" : ""}) ← ${f.mapped ? f.from : f.required ? "NOT MAPPED" : "not mapped"}`))));
      if (ins.reads.inputs.length || ins.reads.steps.length) detail.append(h("p", {}, h("b", {}, "Reads: "), [...ins.reads.inputs.map((x) => `input ${x}`), ...ins.reads.steps.map((x) => `output of ${x}`)].join(", ")));
      if (ins.produces) detail.append(h("p", {}, h("b", {}, "Produces: "), ins.produces.map((f) => `${f.name} (${f.type})`).join(", ")));
      if (ins.assignee) detail.append(h("p", {}, h("b", {}, "Asks: "), ins.assignee));
      if (ins.routes.length) detail.append(h("p", {}, h("b", {}, "Routes: "), ins.routes.map((x) => `${x.label} → ${x.target}`).join(" · ")));
      if (ins.declaredAuthority) { const a = ins.declaredAuthority; detail.append(h("p", {}, h("b", {}, "Declared authority: "), `${a.effect}; scopes ${a.scopes.join(", ") || (a.contractKnown ? "none" : "unknown here")}${a.approvalRequiredByContract ? "; contract requires approval" : ""}`, h("small", { class: "mute" }, " (what the contract says it requires; whether it has been granted is under Readiness)"))); }
    }
    detail.append(h("textarea", { rows: 14, onchange: (e) => (text = e.target.value) }, text),
      h("div", { class: "row" }, h("button", { class: "primary", onclick: () => guard(() => edit([{ op: "step", step: JSON.parse(text) }])) }, "Save step"), h("button", { onclick: () => guard(async () => { state.selected = null; await edit([{ op: "removeStep", id: step.id }]); }) }, "Remove step")));
  },

  async ready(body) {
    const a = await api(`/projects/${state.slug}/assessment`);
    const label = { invalid: "Not valid: the recipe has source errors.", unassessed: "Valid structure; no environment checked it.", blocked: "Blocked: this environment cannot run it as things stand.", "ready-with-unresolved": "Everything checkable holds; some facts could not be established (below).", ready: "Every checkable fact holds in this environment." }[a.verdict];
    body.append(h("div", { class: `verdict ${a.verdict}` }, h("b", {}, a.verdict), ` — ${label}`, h("div", { class: "mute" }, "A valid structure is not an executable recipe. Nothing here says the business outcome will occur; only a run, verified, can.")));
    body.append(h("div", { class: "panel" }, h("h2", {}, `Findings (${a.findings.length})`), a.findings.length ? h("table", { class: "plain" }, a.findings.map((f) => h("tr", {}, h("td", { class: `sev-${f.severity}` }, f.code), h("td", {}, f.step ? `step ${f.step}` : f.dependency ? `dependency ${f.dependency}` : f.path || ""), h("td", {}, f.message, h("small", { class: "mute" }, ` → ${f.action}`))))) : h("p", { class: "mute" }, "none")));
    body.append(h("div", { class: "panel" }, h("h2", {}, `This environment: ${a.environment || "none"}`), h("p", { class: "mute" }, "Bindings and authority belong to the environment. They are read live, are not saved with the recipe and are not in its package. Open the recipe in another environment and these change; the recipe does not."),
      a.dependencies.length ? h("table", { class: "plain" }, h("tr", {}, ["Dependency", "Contract", "Providers", "Bound to", "Authority"].map((x) => h("th", {}, x))), a.dependencies.map((d) => h("tr", {}, h("td", {}, d.id, h("small", { class: "mute" }, ` ${d.capability}`)), h("td", { class: d.contractAvailable ? "" : "sev-error" }, d.contractAvailable ? "available" : "missing"), h("td", { class: d.providers.state === "resolved" ? "" : "sev-error" }, `${d.providers.state} (${d.providers.eligible})`), h("td", {}, d.binding ? d.binding.provider : "—"), h("td", { class: d.authority.state === "granted" ? "" : d.authority.state === "denied" ? "sev-error" : "unresolved" }, d.authority.state === "granted" ? "granted" : d.authority.state === "denied" ? "NOT delegated" : `unresolved: ${d.authority.reason}`)))) : null));
    if (a.unresolved.length) body.append(h("div", { class: "panel" }, h("h2", {}, "Could not be established"), a.unresolved.map((u) => h("div", { class: "unresolved" }, `${u.subject}: ${u.why}`))));
  },

  async package(body) {
    const last = state.project.lastPackage;
    const out = h("div", {});
    body.append(h("div", { class: "panel" }, h("h2", {}, "Package"), h("p", {}, "Makes the canonical package with the same code `appworks package publish` uses, so this digest is the one that command will publish. It signs and publishes nothing: that needs your key and policy, and the existing commands check everything again."),
      last ? h("p", {}, `Last package ${last.digest}, ${last.packagedAt}${last.stale ? " — the recipe has been edited since" : ""}`) : null,
      h("div", { class: "row" }, h("button", { class: "primary", onclick: () => guard(async () => { const r = await api(`/projects/${state.slug}/package`, { method: "POST", body: {} }); out.replaceChildren(r.ok ? h("div", {}, h("p", {}, `Package ${r.digest}`, h("small", { class: "mute" }, `${r.size} bytes → ${r.file}; executable: ${r.executable}`)), h("p", { class: "mute" }, "Carry it on with the existing commands:"), h("pre", {}, r.next.join("\n"))) : h("div", {}, h("p", { class: "sev-error" }, `Not packaged (${r.stage}):`), r.reasons.map((x) => h("div", { class: "sev-error" }, x)))); if (r.ok) state.project = await api(`/projects/${state.slug}`); }) }, "Make package"),
        h("button", { onclick: () => guard(async () => { const c = await api(`/projects/${state.slug}/package/check`); out.replaceChildren(h("p", { class: c.ok ? "" : "sev-error" }, c.ok ? `The package file is intact (${c.digest})${c.stale ? "; the recipe was edited after it was made" : ""}.` : `Not intact: ${c.findings.join("; ")}`)); }) }, "Check package file")), out));
  },

  async source(body) {
    let text = JSON.stringify(state.project.recipe, null, 2);
    body.append(h("div", { class: "panel" }, h("h2", {}, "Canonical recipe (appport.recipe/1)"), h("p", { class: "mute" }, "This is the file `recipe.json`, exactly. Saving it can grant nothing: a recipe has no place to hold authority."),
      h("textarea", { rows: 28, onchange: (e) => (text = e.target.value) }, text),
      h("div", { class: "row" }, h("button", { class: "primary", onclick: () => guard(async () => { state.project = await api(`/projects/${state.slug}`, { method: "PUT", body: { revision: state.project.revision, recipe: JSON.parse(text) } }); say(`saved revision ${state.project.revision}`); await render(); }) }, "Save source"))));
  }
};

$("project").addEventListener("change", (e) => guard(() => loadProject(e.target.value || null)));
$("environment").addEventListener("change", (e) => { state.environment = e.target.value; render(); });
$("new").addEventListener("click", () => guard(async () => {
  const slug = prompt("Project name (lowercase, digits, hyphens)"); if (!slug) return;
  const id = prompt("Recipe identity (reverse-domain, e.g. org.example.recipes.thing)"); if (!id) return;
  const name = prompt("Recipe name") || slug; const objective = prompt("Purpose: the business objective") || "";
  await api("/projects", { method: "POST", body: { slug, id, name, objective } }); await refreshProjects(slug); await loadProject(slug);
}));
$("import").addEventListener("click", () => guard(async () => {
  const slug = prompt("Project name for the imported recipe"); if (!slug) return;
  const text = prompt("Paste an appport.recipe/1 JSON document"); if (!text) return;
  await api("/projects", { method: "POST", body: { slug, recipe: JSON.parse(text) } }); await refreshProjects(slug); await loadProject(slug);
}));

guard(async () => {
  state.environments = await api("/environments");
  state.environment = state.environments[0] ? state.environments[0].name : null;
  $("environment").replaceChildren(...state.environments.map((e) => h("option", { value: e.name }, e.name)));
  await refreshProjects(); await render();
});
