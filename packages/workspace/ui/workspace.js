// The AppWorks project workspace, rendered with the shared Stack design system (vendor/stack-ui's stateless build,
// loaded before this script as `window.StackUI`). The pages store nothing in the browser.
//
// The server sends one page description (`#appworks-page`); everything else is read from the workspace API, which
// returns the same project view `appworks project show --json` prints. This script renders that view and sends
// actions back; it holds no state of its own beyond what is on screen, and it never decides whether an action is
// allowed: the workflow, its authority and its approvals do, and their refusals are shown as they come.
// It builds nodes with createElement and textContent only: it never parses markup.
'use strict';
(function () {
  const S = window.StackUI;
  const config = JSON.parse(document.getElementById('appworks-page').textContent);

  // ---- Requests -------------------------------------------------------------------------------------------------

  async function request(path, method, body) {
    let response;
    try {
      response = await fetch(path, {
        method: method || 'GET',
        headers: method && method !== 'GET' ? { 'content-type': 'application/json', 'x-appworks-request': '1' } : {},
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      const error = new Error('Result unknown: the request did not get an answer. Check the current state.');
      error.code = 'NO_RESPONSE';
      throw error;
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = payload && payload.error;
      const error = new Error((detail && detail.message) || 'The request failed with status ' + response.status + '.');
      error.code = (detail && detail.code) || 'HTTP_' + response.status;
      throw error;
    }
    return payload;
  }

  // ---- Small builders -------------------------------------------------------------------------------------------

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs || {})) {
      if (value === null || value === undefined || value === false) continue;
      node.setAttribute(name, value === true ? '' : String(value));
    }
    for (const child of [].concat(children === undefined ? [] : children).flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      node.append(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
    }
    return node;
  }
  const when = (value) => (value ? el('time', { datetime: value }, S.formatTime(value)) : undefined);
  const code = (value) => (value === undefined || value === null || value === '' ? undefined : el('code', {}, String(value)));
  const status = (s) => S.dom.StatusIndicator({ tone: s.tone, label: s.label, ...(s.detail ? { detail: s.detail } : {}) });
  const tone = (value, map) => status({ tone: map[value] || 'unknown', label: String(value).replace(/-/g, ' ') });
  const section = (id, title, children, description) => el('section', { 'aria-labelledby': id + '-title', id }, [
    el('h2', { id: id + '-title' }, title),
    description ? el('p', { class: 'appworks-muted' }, description) : null,
    ...[].concat(children),
  ]);
  const table = (label, columns, rows, empty) => S.dom.DataTable({ label, columns, rows, emptyTitle: empty || 'Nothing recorded' });
  const pending = (title, body) => S.dom.EmptyState({ title, body, headingLevel: 3 });

  const MATCH = { confirmed: 'positive', probable: 'progress', ambiguous: 'attention', unresolved: 'neutral' };
  const RUN = { running: 'progress', succeeded: 'positive', failed: 'critical', abandoned: 'attention', 'not-applied': 'attention' };
  const APPROVAL = { requested: 'attention', granted: 'progress', consumed: 'positive', revoked: 'neutral' };
  const EXPOSURE = { exposed: 'positive', 'possibly-exposed': 'attention', 'not-exposed': 'neutral', unknown: 'unknown' };

  // ---- Projects page --------------------------------------------------------------------------------------------

  async function projectsPage(main) {
    const listSlot = el('div', { class: 'appworks-list' });
    const report = el('div', { class: 'appworks-outcome' });
    async function refresh() {
      listSlot.replaceChildren(S.dom.DataTable({ label: 'Projects', columns: [], rows: [], loading: true, loadingWhat: 'projects' }));
      try {
        const projects = await request('/api/projects');
        listSlot.replaceChildren(table('Projects', [
          { id: 'repository', header: 'Repository' }, { id: 'ref', header: 'Ref' }, { id: 'sha', header: 'Pinned commit' },
          { id: 'stage', header: 'Stage' }, { id: 'condition', header: 'Condition' }, { id: 'updated', header: 'Updated' },
        ], projects.map((p) => ({
          key: p.id,
          cells: {
            repository: S.dom.ResourceIdentity({ kind: p.provider, name: p.repository, href: '/projects/' + encodeURIComponent(p.id), id: p.id }),
            ref: code(p.ref),
            sha: p.sha ? S.dom.ResourceIdentity({ id: p.sha }) : 'not pinned',
            stage: p.stage,
            condition: tone(p.activeRun ? 'running' : p.condition, { running: 'progress', active: 'neutral', partial: 'attention', failed: 'critical', cancelled: 'neutral' }),
            updated: when(p.updatedAt),
          },
        })), 'No projects yet'));
      } catch (error) {
        listSlot.replaceChildren(S.dom.ErrorPanel({ title: 'Projects could not be read', message: error.message, code: error.code, onRetry: refresh }));
      }
    }
    const form = S.dom.Form({
      id: 'create-project',
      label: 'Select a repository',
      submitLabel: 'Create project',
      children: [
        S.dom.Select({ id: 'create-provider', name: 'provider', label: 'Provider', value: 'github', options: [{ value: 'github', label: 'GitHub (@appport/github)' }, { value: 'git', label: 'Git remote or local mirror' }] }),
        S.dom.TextField({ id: 'create-repository', name: 'repository', label: 'Repository', required: true, placeholder: 'owner/name or https://github.com/owner/name' }),
        S.dom.TextField({ id: 'create-ref', name: 'ref', label: 'Branch, tag or commit (optional)', hint: 'Leave empty for the repository\'s default branch. Resolved to one commit and pinned when the repository is acquired.' }),
        S.dom.TextField({ id: 'create-read', name: 'readCredential', label: 'Read credential (optional)', placeholder: 'env:GITHUB_TOKEN', hint: 'A reference to an environment variable, never the token itself. Public repositories need none.' }),
        S.dom.TextField({ id: 'create-write', name: 'writeCredential', label: 'Write credential (optional)', placeholder: 'env:GITHUB_WRITE_TOKEN', hint: 'Used only by an approved pull request. Kept separate from the read credential.' }),
        S.dom.TextField({ id: 'create-fetch', name: 'fetchFrom', label: 'Fetch from (git only, optional)', hint: 'A local mirror of the repository; the identity stays the GitHub URL.' }),
      ],
      onSubmit: async (event) => {
        const values = Object.fromEntries(new FormData(event.target));
        for (const key of Object.keys(values)) if (values[key] === '') delete values[key];
        report.replaceChildren();
        try {
          const created = await request('/api/projects', 'POST', values);
          location.assign('/projects/' + encodeURIComponent(created.id));
        } catch (error) {
          report.replaceChildren(S.dom.ErrorPanel({ title: 'Not created', message: error.message, code: error.code }));
        }
      },
    });
    main.append(
      S.dom.PageHeader({ title: 'Projects', eyebrow: 'AppWorks', description: 'Each project pins one repository revision and carries it through discovery, assessment, reconciliation, extraction and verification. State is held in FeltDB; this page only shows it.' }),
      section('projects', 'Projects', listSlot),
      section('create', 'New project', [form, report]),
    );
    await refresh();
  }

  // ---- Project page ---------------------------------------------------------------------------------------------

  let latest = 0;
  let timer = null;

  async function projectPage(main) {
    const id = config.project;
    const slot = el('div', { class: 'appworks-project' });
    const outcome = el('div', { class: 'appworks-outcome', role: 'status', 'aria-live': 'polite' });
    main.append(outcome, slot);

    async function refresh() {
      const mine = ++latest;
      try {
        const [view, agent] = await Promise.all([
          request('/api/projects/' + encodeURIComponent(id)),
          request('/api/projects/' + encodeURIComponent(id) + '/agent').catch((error) => ({ unavailable: error })),
        ]);
        if (mine !== latest) return;
        slot.replaceChildren(...render(view, agent));
        clearTimeout(timer);
        const agentRunning = agent && agent.current && agent.current.run.status === 'running' && !agent.current.run.interrupted;
        if ((view.project.activeRun && !view.project.activeRun.expired) || agentRunning) timer = setTimeout(refresh, 2000);
      } catch (error) {
        if (mine !== latest) return;
        slot.replaceChildren(S.dom.ErrorPanel({ title: 'The project could not be read', message: error.message, code: error.code, onRetry: refresh }));
      }
    }

    async function act(action, input) {
      outcome.replaceChildren();
      const result = await request('/api/projects/' + encodeURIComponent(id) + '/actions/' + action, 'POST', input || {});
      outcome.replaceChildren(el('p', { class: 'appworks-outcome__ok' }, result && result.run ? 'Started ' + action + ' (' + result.run + ').' : 'Done: ' + action + '.'));
      await refresh();
    }

    async function onAction(next) {
      try {
        if (next.action === 'approve') {
          const subject = (next.inputs || []).find((i) => i.name === 'subject');
          const actionInput = (next.inputs || []).find((i) => i.name === 'action');
          await S.confirmAction({
            id: 'approve-action',
            title: 'Approve ' + (actionInput ? actionInput.value : 'action') + '?',
            description: next.reason,
            consequences: ['Approves exactly subject ' + (subject && subject.value) + '. If the plan, revision or assessment changes, this approval no longer applies.', 'Approval is not authority, and a verified result is not approval for production.'],
            confirmLabel: 'Approve',
            action: () => act('approve', { action: actionInput && actionInput.value, subject: subject && subject.value }),
          });
          return;
        }
        if (next.inputs && next.inputs.length) {
          await S.formDialog({
            id: 'action-' + next.action,
            title: next.label,
            description: next.reason,
            submitLabel: next.label,
            fields: next.inputs.map((input) => ({ name: input.name, label: input.label, required: input.required, ...(input.hint ? { hint: input.hint } : {}), ...(input.value ? { value: input.value } : {}) })),
            action: async (values) => {
              for (const key of Object.keys(values)) if (values[key] === '') delete values[key];
              await act(next.action, values);
            },
          });
          return;
        }
        await act(next.action, {});
      } catch (error) {
        outcome.replaceChildren(S.dom.ErrorPanel({ title: next.label + ' was refused', message: error.message, code: error.code }));
      }
    }

    async function agentAct(action, input) {
      outcome.replaceChildren();
      try {
        const result = await request('/api/projects/' + encodeURIComponent(id) + '/agent/' + action, 'POST', input || {});
        outcome.replaceChildren(el('p', { class: 'appworks-outcome__ok' }, result && result.run && action !== 'stop' ? 'Agent ' + action + ': ' + result.run + '.' : 'Stop requested.'));
      } catch (error) {
        outcome.replaceChildren(S.dom.ErrorPanel({ title: 'Agent ' + action + ' was refused', message: error.message, code: error.code }));
      }
      await refresh();
    }

    const AGENT = { running: 'progress', paused: 'attention', completed: 'positive', blocked: 'attention', exhausted: 'attention', failed: 'critical', cancelled: 'neutral', interrupted: 'attention' };
    const TURN = { executing: 'progress', succeeded: 'positive', failed: 'critical', refused: 'attention', invalid: 'critical', paused: 'attention', asked: 'attention', answered: 'neutral', finished: 'neutral', interrupted: 'attention' };
    const describe = (a) => a.provider + (a.model ? ' ' + a.model : '') + ' (' + a.implementation + ')';

    function renderAgent(a) {
      if (!a || a.unavailable) return section('agent', 'Agent', S.dom.Unavailable({ status: 'unavailable', title: 'No agent runtime', reason: a && a.unavailable ? a.unavailable.message : 'The agent view could not be read.' }));
      const children = [];
      const configured = a.configured.error
        ? S.dom.Unavailable({ status: 'unavailable', title: 'No agent configured', reason: a.configured.error.message })
        : S.dom.MetadataList({ items: [
          { label: 'Configured agent', value: a.configured.provider + (a.configured.model ? ' · ' + a.configured.model : '') },
          { label: 'Implementation', value: a.configured.implementation, mono: true },
          { label: 'Limits', value: a.configured.limits.maxTurns + ' turns · ' + Math.round(a.configured.limits.decisionTimeoutMs / 1000) + 's per decision · ' + a.configured.limits.maxRetries + ' retries' },
          ...(a.configured.key ? [{ label: 'Key', value: a.configured.key.variable + (a.configured.key.set ? ' is set' : ' is NOT set') }] : []),
        ] });
      children.push(configured);
      const c = a.current;
      const r = c && c.run;
      const buttons = [];
      const holding = r && (r.status === 'running' || r.status === 'paused');
      if (!holding && !a.configured.error) buttons.push(S.dom.Button({ label: 'Run agent', variant: 'primary', attrs: { 'data-agent': 'start' }, onClick: () => agentAct('start', {}) }));
      if (r && r.status === 'running' && !r.interrupted && !r.cancelRequested) buttons.push(S.dom.Button({ label: 'Stop agent', variant: 'ghost', attrs: { 'data-agent': 'stop' }, onClick: () => agentAct('stop', { run: r.id, reason: 'stopped from the web workspace' }) }));
      if (r && (r.status === 'paused' || r.interrupted) && !a.configured.error) {
        const switching = r.agent.provider !== a.configured.provider || (r.agent.model || '') !== (a.configured.model || '');
        buttons.push(S.dom.Button({ label: switching ? 'Resume with ' + a.configured.provider : 'Resume agent', variant: 'primary', attrs: { 'data-agent': 'resume' }, onClick: async () => {
          if (r.pause && r.pause.kind === 'question') {
            await S.formDialog({ id: 'agent-answer', title: 'Answer the agent', description: r.pause.question, submitLabel: 'Answer and resume', fields: [{ name: 'answer', label: 'Answer', required: true }], action: (values) => agentAct('resume', { run: r.id, answer: values.answer, switchAgent: switching }) });
            return;
          }
          if (switching) {
            await S.confirmAction({ id: 'agent-switch', title: 'Switch the agent?', description: 'This run was carried by ' + describe(r.agent) + '. The configured agent is ' + a.configured.provider + (a.configured.model ? ' ' + a.configured.model : '') + '.', consequences: ['The switch is recorded on the run.', 'The new agent decides from the same recorded history.'], confirmLabel: 'Switch and resume', action: () => agentAct('resume', { run: r.id, switchAgent: true }) });
            return;
          }
          await agentAct('resume', { run: r.id });
        } }));
        if (r.status === 'paused' || r.interrupted) buttons.push(S.dom.Button({ label: 'Stop agent', variant: 'ghost', attrs: { 'data-agent': 'stop' }, onClick: () => agentAct('stop', { run: r.id, reason: 'stopped from the web workspace' }) }));
      }
      if (buttons.length) children.push(el('div', { class: 'appworks-action' }, buttons));
      if (!r) {
        children.push(pending('No agent run yet', 'Running the agent carries this project through the workflow, one validated decision at a time, until a blocker or an approval only a person can grant.'));
        return section('agent', 'Agent', children, a.note);
      }
      children.push(S.dom.MetadataList({ items: [
        { label: 'Run', value: r.id, mono: true },
        { label: 'Status', value: status({ tone: AGENT[r.interrupted ? 'interrupted' : r.status] || 'unknown', label: r.interrupted ? 'interrupted' : r.status + (r.cancelRequested ? ' (stop requested)' : '') }) },
        { label: 'Agent', value: describe(r.agent) },
        { label: 'Turns', value: r.turns + ' of ' + r.limits.maxTurns },
        ...(r.usage && r.usage.inputTokens ? [{ label: 'Tokens', value: r.usage.inputTokens + ' in · ' + r.usage.outputTokens + ' out' }] : []),
        { label: 'Started', value: when(r.startedAt) },
        ...(r.outcome ? [{ label: 'Outcome', value: r.outcome.reason + ' · project at ' + r.outcome.stage + ' (' + r.outcome.condition + ')' }] : []),
      ] }));
      for (const sw of r.switches || []) children.push(el('p', { class: 'appworks-muted' }, 'Agent switched after turn ' + sw.afterTurn + ' by ' + sw.by + ': ' + describe(sw.from) + ' → ' + describe(sw.to) + '.'));
      if (r.pause && r.pause.kind === 'approval') children.push(S.dom.Unavailable({ status: 'partial', title: 'Waiting for approval: ' + r.pause.approval, reason: r.pause.action + ' needs a person\'s ' + r.pause.approval + ' approval' + (r.pause.subject ? ' of subject ' + r.pause.subject : '') + '. Approve it under Next actions, then resume the agent.' }));
      if (r.pause && r.pause.kind === 'question') children.push(S.dom.Unavailable({ status: 'partial', title: 'The agent asks', reason: r.pause.question }));
      if (r.interrupted) children.push(S.dom.Unavailable({ status: 'partial', title: 'Interrupted', reason: 'The worker carrying this run stopped renewing its lease. Resuming reconciles the last action from the workflow\'s records; nothing is repeated blindly.' }));
      if (r.error) children.push(S.dom.ErrorPanel({ title: 'The agent run failed', message: r.error.message, code: r.error.code }));
      for (const b of (r.outcome && r.outcome.blockers) || []) children.push(S.dom.Unavailable({ status: 'partial', title: 'Blocker (reported by the agent)', reason: b }));
      children.push(table('Agent turns', [{ id: 'turn', header: '#' }, { id: 'status', header: 'Status' }, { id: 'decision', header: 'Decision' }, { id: 'rationale', header: 'Agent\'s rationale (not evidence)' }, { id: 'result', header: 'Recorded result' }], c.turns.slice().reverse().map((t) => {
        const d = t.decision;
        const what = !d ? '(no readable decision)' : d.kind === 'action' ? d.action + (Object.keys(d.arguments || {}).length ? ' ' + JSON.stringify(d.arguments) : '') : d.kind === 'ask' ? 'ask: ' + d.question : 'finish: ' + d.outcome;
        return { key: t.id, cells: {
          turn: String(t.turn), status: tone(t.status, TURN), decision: code(what), rationale: d ? d.rationale : '',
          result: t.result ? [t.result.summary + (t.result.class && t.result.class !== 'none' ? ' (' + t.result.class + ')' : ''), ...(t.result.evidence || []).map((e) => [' ', code(e)])] : (t.problems || []).map((p) => p.code + ': ' + p.message).join('; '),
        } };
      }), 'No turns yet'));
      return section('agent', 'Agent', children, a.note);
    }

    function render(v, agent) {
      const p = v.project;
      const out = [];
      const rev = p.revision;
      out.push(S.dom.PageHeader({
        eyebrow: 'Project · ' + p.repository.provider,
        title: p.repository.owner + '/' + p.repository.name,
        status: status(v.status),
        description: 'Workflow stage: ' + p.stage + '. Created by ' + p.createdBy + '.',
        meta: [S.dom.ResourceIdentity({ kind: 'project', id: p.id, length: 24 }), ' ', rev ? S.dom.ResourceIdentity({ kind: 'commit', id: rev.sha }) : null],
      }));

      // Workflow stages, in the order feltdb.flow declares them.
      out.push(section('workflow', 'Workflow', el('ol', { class: 'appworks-stages' }, v.stages.map((s) => el('li', { class: 'appworks-stage appworks-stage--' + s.state, 'data-stage': s.stage, ...(s.state === 'current' ? { 'aria-current': 'step' } : {}) }, [
        el('span', { class: 'appworks-stage__mark', 'aria-hidden': 'true' }, s.state === 'done' ? '✓' : s.state === 'current' ? '●' : s.state === 'failed' ? '✕' : '○'),
        el('span', {}, s.stage),
        el('span', { class: 'stack-visually-hidden' }, ' (' + s.state + ')'),
      ]))), 'Stages and transitions come from the workspace\'s feltdb.flow. Every transition is checked against recorded evidence.'));

      const notices = [];
      if (p.failure) notices.push(S.dom.ErrorPanel({ title: p.failure.step + ' failed', message: p.failure.message, code: p.failure.code }));
      if (p.activeRun) notices.push(p.activeRun.expired
        ? S.dom.Unavailable({ status: 'partial', title: p.activeRun.step + ' was interrupted', reason: 'Run ' + p.activeRun.id + ' stopped renewing its lease. Resume runs that step again; completed steps are not repeated.' })
        : S.dom.Loading({ what: p.activeRun.step + ' (' + p.activeRun.id + ')' }));
      for (const r of p.condition.reasons) notices.push(S.dom.Unavailable({ status: 'partial', title: r.code.replace(/_/g, ' ').toLowerCase(), reason: r.message + (r.stage ? ' (' + r.stage + ')' : '') }));
      if (notices.length) out.push(section('condition', 'Condition', notices));

      // Next actions: advisory.
      out.push(section('next', 'Next actions', [
        el('p', {}, v.next.summary),
        v.next.actions.length
          ? el('div', { class: 'appworks-actions' }, v.next.actions.map((n) => el('div', { class: 'appworks-action' }, [
            S.dom.Button({ label: n.label, variant: n.action === 'cancel' ? 'ghost' : 'primary', onClick: () => onAction(n), attrs: { 'data-action': n.action } }),
            el('span', { class: 'appworks-muted' }, ' ' + n.reason + (n.approval ? ' Requires approval: ' + n.approval + '.' : '')),
          ])))
          : null,
        el('p', { class: 'appworks-muted' }, v.next.note),
      ]));

      out.push(renderAgent(agent));

      out.push(section('repository', 'Repository and revision', S.dom.MetadataList({ items: [
        { label: 'Repository', value: p.repository.url, mono: true },
        { label: 'Owner', value: p.repository.owner },
        { label: 'Provider', value: p.repository.provider === 'github' ? 'GitHub through @appport/github' : 'git' },
        { label: 'Default branch', value: p.repository.defaultBranch },
        { label: 'Selected ref', value: p.ref, mono: true },
        { label: 'Pinned commit', value: rev ? rev.sha : undefined, mono: true },
        { label: 'On the default branch', value: rev ? rev.onDefaultBranch : undefined, hint: v.revisionNotice },
        { label: 'Acquisition', value: status(v.acquisition) },
        { label: 'Pinned at', value: rev && rev.pinnedAt ? when(rev.pinnedAt) : undefined },
        { label: 'Checkout content hash', value: rev ? rev.treeDigest : undefined, mono: true, hint: 'Every later step re-checks it; a change stops the workflow.' },
        { label: 'Read credential', value: p.repository.readCredential || 'none (public)', mono: true, hint: 'A reference only; the value is never stored or shown.' },
        { label: 'Write credential', value: p.repository.writeCredential || 'none', mono: true },
      ] })));

      // AppPort integration and discovery.
      const integration = v.integration
        ? [S.dom.MetadataList({ items: [
          { label: 'Integration', value: tone(v.integration.status, { present: 'positive', absent: 'neutral' }) },
          { label: 'Inspection', value: v.integration.note },
        ] }), v.integration.integrations.length ? table('AppPort integrations in the revision', [{ id: 'root', header: 'Directory' }, { id: 'name', header: 'Package' }, { id: 'packages', header: 'AppPort packages' }, { id: 'entry', header: 'Entry (not run)' }], v.integration.integrations.map((i) => ({ key: i.root, cells: { root: code(i.root), name: i.name, packages: Object.entries(i.packages).map(([k, x]) => k + '@' + x).join(', '), entry: code(i.entry) } }))) : null]
        : [pending('Not inspected', 'Inspection reads the pinned files for an AppPort integration.')];
      const d = v.discovery;
      const discovery = d
        ? [S.dom.MetadataList({ items: [
          { label: 'Outcome', value: tone(d.outcome, { discovered: 'positive', 'no-integration': 'neutral', unavailable: 'attention' }) },
          { label: 'Endpoint', value: d.endpoint, mono: true },
          { label: 'Application', value: d.application ? d.application.id + ' ' + d.application.version : undefined },
          { label: 'Discovered at', value: when(d.at) },
          { label: 'Established', value: 'Publisher trust, authorization, approval and invocation: none. Discovery grants nothing.' },
        ] }), el('p', { class: 'appworks-muted' }, d.note),
        table('Discovered capabilities', [{ id: 'name', header: 'Capability' }, { id: 'status', header: 'Reference' }, { id: 'effect', header: 'Effect' }, { id: 'auth', header: 'Authorization' }, { id: 'claims', header: 'Fulfillment claims' }], d.capabilities.map((c) => ({ key: c.name + '@' + c.version, cells: {
          name: code(c.name + '@' + c.version),
          status: tone(c.status, { verified: 'positive', unresolved: 'attention' }),
          effect: c.effect,
          auth: c.authorization ? (typeof c.authorization === 'string' ? c.authorization : 'scopes ' + (c.authorization.scopes || []).join(', ')) : undefined,
          claims: c.claims.length ? c.claims.map((x) => x.claim.contract + ' ' + x.claim.capability + '@' + x.claim.version + ': ' + x.evaluation).join('; ') : 'none',
        } })), d.outcome === 'no-integration' ? 'No AppPort integration: nothing to discover' : 'No capabilities discovered')]
        : [pending('Not discovered', 'Discovery asks a running instance, through AppPort\'s client, what it advertises.')];
      out.push(section('integration', 'AppPort integration', [...integration, el('h3', {}, 'Discovery'), ...discovery]));

      const a = v.assessment;
      out.push(section('assessment', 'Assessment', a ? [
        a.partial.length ? S.dom.Unavailable({ status: 'partial', title: 'Partial assessment', reason: 'Not covered: ' + a.partial.join(', ') + '. ' + a.coverage.filesAnalyzed + ' of ' + a.coverage.filesSeen + ' files analyzed.' }) : null,
        S.dom.MetadataList({ items: [
          { label: 'Digest', value: a.digest, mono: true },
          { label: 'Artifact', value: a.artifact, mono: true, hint: 'File ' + a.fileDigest },
          { label: 'Candidates', value: a.candidates },
          { label: 'Recommended', value: a.recommendation, mono: true },
          { label: 'Open questions', value: a.questions },
        ] }),
      ] : pending('Not assessed', 'Static assessment of the same pinned revision.')));

      // Reconciliation.
      const inv = v.inventory;
      if (inv) {
        let tab = 'capabilities';
        const panel = el('div');
        const tabs = () => S.dom.Tabs({ label: 'Inventory', idPrefix: 'inventory', panelId: 'inventory-panel', active: tab, tabs: [
          { id: 'capabilities', label: 'Capabilities', badge: String(inv.capabilities.length) },
          { id: 'candidates', label: 'Candidates', badge: String(inv.candidates.length) },
        ], onSelect: (next) => { tab = next; draw(); } });
        const tabSlot = el('div');
        const draw = () => {
          tabSlot.replaceChildren(tabs());
          panel.replaceChildren(S.dom.TabPanel({ id: 'inventory-panel', idPrefix: 'inventory', active: tab, children: tab === 'capabilities'
            ? table('Capabilities', [{ id: 'name', header: 'Capability' }, { id: 'sources', header: 'Source' }, { id: 'status', header: 'Match' }, { id: 'basis', header: 'Basis' }, { id: 'candidates', header: 'Candidates and evidence' }, { id: 'hints', header: 'Name hints (not evidence)' }], inv.capabilities.map((c) => ({ key: c.name + '@' + c.version, attrs: { 'data-capability': c.name }, cells: {
              name: code(c.name + '@' + c.version),
              sources: c.sources.join(', '),
              status: tone(c.status, MATCH),
              basis: c.basis,
              candidates: c.candidates.length ? el('ul', { class: 'appworks-plain' }, c.candidates.slice(0, 6).map((x) => el('li', {}, [code(x.id), ' ', x.evidence.map((e) => e.kind).join(', ')]))) : 'none',
              hints: c.hints.map((h) => h.candidate.replace(/^cand-/, '')).join(', '),
            } })), 'No capabilities')
            : table('Candidates', [{ id: 'id', header: 'Candidate' }, { id: 'readiness', header: 'Readiness' }, { id: 'effect', header: 'Effect' }, { id: 'exposure', header: 'Exposure' }, { id: 'matches', header: 'Matches' }], inv.candidates.map((c) => ({ key: c.id, cells: {
              id: code(c.id), readiness: c.readiness, effect: c.effect, exposure: tone(c.exposure, EXPOSURE), matches: c.matches.map((m) => m.capability + ' (' + m.status + ')').join(', ') || 'none',
            } })), 'No candidates') }));
        };
        draw();
        out.push(section('inventory', 'Inventory', [
          ...inv.partial.map((r) => S.dom.Unavailable({ status: 'partial', title: r.code.replace(/_/g, ' ').toLowerCase(), reason: r.message })),
          S.dom.MetadataList({ items: [
            { label: 'Confirmed', value: inv.summary.confirmed }, { label: 'Probable', value: inv.summary.probable },
            { label: 'Ambiguous', value: inv.summary.ambiguous }, { label: 'Unresolved', value: inv.summary.unresolved },
            { label: 'Candidates kept', value: inv.summary.candidates, hint: inv.summary.exposed + ' exposed, ' + inv.summary.possiblyExposed + ' possibly, ' + inv.summary.notExposed + ' not exposed, ' + inv.summary.unknown + ' unknown' },
          ] }),
          tabSlot, panel,
        ], 'Confirmed needs a verified extraction for this revision; a similar name is never evidence.'));
      } else out.push(section('inventory', 'Inventory', pending('Not reconciled', 'Reconciliation joins discovered capabilities and assessed candidates.')));

      out.push(section('selection', 'Selection and plan', [
        v.selection ? S.dom.MetadataList({ items: [
          { label: 'Selected candidate', value: v.selection.candidate, mono: true },
          { label: 'Selected by', value: v.selection.by, hint: v.selection.rationale },
          { label: 'Selected at', value: when(v.selection.at) },
        ] }) : pending('No candidate selected', 'Only eligible candidates can be selected.'),
        v.plan ? S.dom.MetadataList({ items: [
          { label: 'Extraction', value: v.plan.extraction + ' · ' + v.plan.identity },
          { label: 'Validated plan digest', value: v.plan.digest, mono: true },
          { label: 'Plan directory digest', value: v.plan.planDirectory, mono: true },
          { label: 'Behaviors to verify', value: v.plan.behaviors },
        ] }) : null,
      ]));

      out.push(section('approvals', 'Approvals', table('Approvals', [{ id: 'action', header: 'Action' }, { id: 'status', header: 'Status' }, { id: 'subject', header: 'Subject' }, { id: 'by', header: 'Granted by' }, { id: 'consumed', header: 'Used by' }], v.approvals.map((x) => ({ key: x.id, cells: {
        action: x.action, status: tone(x.status, APPROVAL), subject: S.dom.ResourceIdentity({ id: x.subject, length: 19 }), by: x.grantedBy ? [x.grantedBy, ' ', when(x.grantedAt)] : undefined, consumed: code(x.consumedBy),
      } })), 'No approvals requested'), 'Each action class (generate files, modify integration, commit, push, pull request, promote) needs its own approval of an exact subject, enforced when the action runs.'));

      // Extraction and verification.
      const x = v.extraction;
      const ver = v.verification;
      const verification = [];
      if (x) verification.push(S.dom.MetadataList({ items: [
        { label: 'Extraction', value: x.identity + ' (' + x.format + ')' },
        { label: 'Digest', value: x.digest, mono: true },
        { label: 'Replaces', value: x.previous, mono: true },
        { label: 'Source', value: x.source, mono: true },
        { label: 'Contract', value: x.contract, mono: true },
        { label: 'Fulfillment declaration', value: x.fulfillment, mono: true },
        { label: 'Runner log', value: x.log, mono: true },
      ] }));
      if (ver) {
        const checks = ver.records.map((r) => ({ label: r.behavior + (r.against ? ' · ' + r.against : ''), status: r.status === 'passed' ? 'passed' : 'failed' }));
        verification.push(S.dom.EvidenceSummary({
          id: 'verification-evidence',
          title: 'Verification',
          headingLevel: 3,
          outcome: S.dom.VerificationBadge({ state: ver.status === 'verified' && ver.fresh ? 'verified' : ver.status === 'verified' ? 'not_verified' : 'verification_failed', checks, at: ver.at }),
          claims: [
            { label: 'Integrity (verifyExtractionAt)', value: ver.integrity.ok ? 'valid' : ver.integrity.findings.map((f) => f.code).join(', '), verification: ver.integrity.ok ? 'verified' : 'verification_failed', checks: [{ label: 'artifact, assessment, checkout and adapter sources', status: ver.integrity.ok ? 'passed' : 'failed' }] },
            { label: 'Required behaviors', value: ver.behaviors.passed + ' of ' + ver.behaviors.required + ' passed (' + ver.behaviors.againstReal + ' against the real application, ' + ver.behaviors.againstStub + ' against a stub)', verification: ver.behaviors.passed === ver.behaviors.required ? 'verified' : 'verification_failed', checks },
            { label: 'Checkout unchanged', value: ver.checkoutUnchanged ? 'unchanged' : 'changed', verification: ver.checkoutUnchanged ? 'verified' : 'verification_failed', checks: [{ label: 'content hash ' + ver.treeDigest, status: ver.checkoutUnchanged ? 'passed' : 'failed' }] },
            { label: 'Still current', value: ver.fresh ? 'same revision, assessment, extraction and plan' : ver.staleReasons.join('; '), verification: ver.fresh ? 'verified' : 'not_verified', checks: [{ label: 'freshness', status: ver.fresh ? 'passed' : 'failed' }] },
            { label: 'Revision', value: ver.revision, mono: true },
            { label: 'Assessment', value: ver.assessmentDigest, mono: true },
          ],
          source: 'Recorded by the workspace in FeltDB',
          recordedAt: ver.at,
        }));
        if (ver.reasons.length) verification.push(S.dom.ErrorPanel({ title: 'Not verified', message: ver.reasons.map((r) => r.code + ': ' + r.message).join(' · ') }));
      }
      if (x && x.questions.length) verification.push(el('h3', {}, 'Open questions'), el('ul', {}, x.questions.map((q) => el('li', {}, [code(q.id), ' ', q.question]))));
      if (!verification.length) verification.push(pending('Nothing executed yet', 'The reviewed extraction runs only after its approval.'));
      out.push(section('verification', 'Extraction and verification', verification));

      // Contract adoption: the proposal, every difference and what supports it, the questions, the decision.
      const ad = v.adoption;
      const SUPPORT = { verified: 'positive', 'source-evidence': 'progress', explained: 'neutral', unknown: 'critical' };
      out.push(section('adoption', 'Contract adoption', ad ? [
        S.dom.MetadataList({ items: [
          { label: 'Contract', value: ad.contract.application + ' ' + ad.contract.capability + '@' + ad.contract.version, mono: true },
          { label: 'Capability digest', value: ad.contract.capabilityDigest, mono: true },
          { label: 'Status', value: ad.adopted ? status({ tone: 'positive', label: 'Adopted', detail: 'by ' + ad.decision.by }) : ad.blocking.length ? status({ tone: 'critical', label: 'Blocked', detail: ad.blocking.length + ' items' }) : status({ tone: 'attention', label: 'Proposed', detail: 'awaiting approval' }) },
          { label: 'Proposal digest', value: ad.digest, mono: true },
          { label: 'Provider', value: ad.provider ? ad.provider.application + ' ' + ad.provider.capability + '@' + ad.provider.version : undefined, mono: true },
          { label: 'Existing declarations', value: ad.existingDeclarations.length ? ad.existingDeclarations.map((d) => d.name + '@' + d.version + ' (' + d.relation + ')').join('; ') : 'none: the contract is new to this application' },
        ] }),
        ...ad.blocking.map((b) => S.dom.ErrorPanel({ title: 'Blocks adoption', message: b.message, code: b.code })),
        table('Differences', [{ id: 'kind', header: 'Kind' }, { id: 'subject', header: 'Subject' }, { id: 'impact', header: 'Impact' }, { id: 'support', header: 'Support' }, { id: 'what', header: 'Difference and reason' }], ad.differences.map((d) => ({ key: d.id, attrs: { 'data-difference': d.id }, cells: {
          kind: d.kind, subject: code(d.subject), impact: d.impact,
          support: tone(d.support, SUPPORT),
          what: [d.description, d.reason ? el('br') : null, d.reason ? el('span', { class: 'appworks-muted' }, d.reason) : null, d.behaviors.length ? el('br') : null, d.behaviors.length ? el('span', { class: 'appworks-muted' }, d.behaviors.map((b) => b.behavior + ' ' + b.status).join(', ')) : null],
        } })), 'No differences'),
        table('Questions', [{ id: 'id', header: 'Question' }, { id: 'impact', header: 'Impact' }, { id: 'disposition', header: 'Disposition' }, { id: 'reason', header: 'Reason' }], ad.questions.map((q) => ({ key: q.id, cells: { id: [code(q.id), ' ', q.question], impact: q.impact, disposition: tone(q.disposition, { resolved: 'positive', accepted: 'neutral', open: 'critical' }), reason: q.reason } })), 'No questions'),
        el('p', { class: 'appworks-muted' }, 'A matching name, compatible schemas, a fulfillment claim and passing behaviors are each recorded for what they are: none of them is equivalence or authority. Adoption grants nothing and registers nothing.'),
      ] : pending('No contract proposed', 'A verified extraction\'s contract can be proposed for adoption into the application\'s integration.')));

      // The integration change: the promotion artifact, its patch and its verification.
      const ic = v.integrationChange;
      if (ic) {
        const pr = ic.promotion;
        const STATE = { proposed: 'attention', approved: 'progress', applied: 'progress', verified: 'positive', 'verification-failed': 'critical', 'ready-for-review': 'positive', 'submitted-for-review': 'positive' };
        out.push(section('integration-change', 'Integration change', [
          S.dom.MetadataList({ items: [
            { label: 'State', value: tone(ic.state, STATE) },
            { label: 'Promotion digest', value: pr.digest, mono: true },
            { label: 'Base revision', value: pr.target.base, mono: true },
            { label: 'Adds under', value: pr.target.directory, mono: true, hint: 'Additions only: no existing file of the application changes.' },
            { label: 'Isolated worktree', value: ic.worktree, mono: true },
            { label: 'Extraction', value: pr.extraction.identity.name + ' revision ' + pr.extraction.identity.revision + ' ' + pr.extraction.digest, mono: true },
            { label: 'Patch digest', value: ic.patch ? ic.patch.digest : undefined, mono: true },
            { label: 'Local commit', value: ic.commit ? ic.commit + ' on ' + ic.branch : undefined, mono: true, hint: ic.commit ? 'Local to the workspace. Not pushed.' : undefined },
          ] }),
          ...ic.reasons.map((r) => S.dom.ErrorPanel({ title: 'Recorded problem', message: r.message, code: r.code })),
          table('Files', [{ id: 'path', header: 'Path' }, { id: 'role', header: 'Role' }, { id: 'source', header: 'Verified source' }, { id: 'digest', header: 'sha256' }], pr.target.files.map((f) => ({ key: f.path, cells: { path: code(f.path), role: f.role, source: code(f.source), digest: S.dom.ResourceIdentity({ id: f.sha256, length: 19 }) } }))),
          pr.target.excluded.length ? table('Not promoted', [{ id: 'source', header: 'File' }, { id: 'reason', header: 'Reason' }], pr.target.excluded.map((e) => ({ key: e.source, cells: { source: code(e.source), reason: e.reason } }))) : null,
          pr.requirements.packages.length ? table('Runtime requirements', [{ id: 'name', header: 'Package' }, { id: 'required', header: 'Verified with' }, { id: 'target', header: 'Target pins (' + pr.requirements.lockfile + ')' }, { id: 'met', header: '' }], pr.requirements.packages.map((r) => ({ key: r.name, cells: { name: code(r.name), required: r.required, target: r.target || 'absent', met: r.met ? status({ tone: 'positive', label: 'Met' }) : status({ tone: 'critical', label: 'Not met by this patch' }) } }))) : null,
          table('Approvals this change needs', [{ id: 'action', header: 'Action' }, { id: 'supported', header: '' }, { id: 'note', header: 'What it covers' }], pr.approvals.map((x) => ({ key: x.action, cells: { action: x.action, supported: x.supported ? status({ tone: 'neutral', label: 'Supported' }) : status({ tone: 'unknown', label: 'Not supported' }), note: x.note } }))),
          el('h3', {}, 'What runs'), el('ul', {}, pr.execution.map((e) => el('li', {}, e))),
          ic.verification ? S.dom.EvidenceSummary({
            id: 'promotion-evidence', title: 'Verification of the promoted copy', headingLevel: 3,
            outcome: S.dom.VerificationBadge({ state: ic.verification.status === 'verified' ? 'verified' : 'verification_failed', checks: [{ label: 'behaviors', status: ic.verification.behaviors.passed === ic.verification.behaviors.required ? 'passed' : 'failed' }, { label: 'mutants', status: ic.verification.mutations && ic.verification.mutations.caught === ic.verification.mutations.total ? 'passed' : 'failed' }] }),
            claims: [
              { label: 'Required behaviors', value: ic.verification.behaviors.passed + ' of ' + ic.verification.behaviors.required + ' passed (' + ic.verification.behaviors.againstReal + ' against the real application)', verification: ic.verification.behaviors.passed === ic.verification.behaviors.required ? 'verified' : 'verification_failed', checks: [{ label: 'the extraction\'s behavioral suite, against the promoted copy', status: ic.verification.behaviors.passed === ic.verification.behaviors.required ? 'passed' : 'failed' }] },
              { label: 'Mutants caught', value: ic.verification.mutations ? ic.verification.mutations.caught + ' of ' + ic.verification.mutations.total : 'not run', verification: ic.verification.mutations && ic.verification.mutations.total > 0 && ic.verification.mutations.caught === ic.verification.mutations.total ? 'verified' : 'verification_failed', checks: [{ label: 'mutation check, against copies of the promoted host', status: ic.verification.mutations && ic.verification.mutations.caught === ic.verification.mutations.total ? 'passed' : 'failed' }] },
              { label: 'Subject', value: 'the extraction\'s own: ' + Object.values(pr.verification.subject).map((x) => String(x).slice(0, 19)).join(' · '), mono: true },
              ...ic.verification.reasons.map((r) => ({ label: r.code, value: r.message })),
            ],
          }) : null,
          ic.patch ? el('details', { class: 'appworks-diff' }, [el('summary', {}, 'Patch (' + ic.patch.files + ' files, ' + ic.patch.digest.slice(0, 19) + '…)'), el('pre', {}, ic.patch.diff)]) : null,
        ], 'A deterministic promotion artifact describes the change; its lifecycle is recorded separately. Applying, committing, pushing and opening a pull request are separate actions, each with its own approval.'));
      }

      out.push(section('promotion', 'Promotion', v.promotion
        ? S.dom.MetadataList({ items: [{ label: 'Status', value: v.promotion.status }, { label: 'Deployed', value: v.promotion.deployed ? 'yes' : 'no' }, { label: 'Note', value: v.promotion.note }] })
        : pending('Not ready for promotion', 'Ready for promotion means verified and still fresh. It deploys nothing, and promotion needs its own approval.')));

      out.push(section('runs', 'Runs', table('Runs', [{ id: 'id', header: 'Run' }, { id: 'status', header: 'Status' }, { id: 'owner', header: 'Worker' }, { id: 'started', header: 'Started' }, { id: 'finished', header: 'Finished' }, { id: 'error', header: 'Error' }], v.runs.map((r) => ({ key: r.id, cells: {
        id: code(r.id), status: tone(r.status, RUN), owner: r.owner, started: when(r.startedAt), finished: when(r.finishedAt), error: r.error ? r.error.code + ': ' + r.error.message : undefined,
      } })), 'No runs'), 'A run record is the lease on one attempt. The project record and its evidence, not the run, decide the stage.'));

      out.push(section('history', 'History', table('Stage history', [{ id: 'seq', header: '#' }, { id: 'step', header: 'Step' }, { id: 'to', header: 'Stage' }, { id: 'condition', header: 'Condition' }, { id: 'actor', header: 'Actor' }, { id: 'at', header: 'At' }, { id: 'note', header: 'Note' }], v.history.map((h) => ({ key: String(h.sequence), cells: {
        seq: String(h.sequence), step: h.step, to: h.from && h.from !== h.to ? h.from + ' → ' + h.to : h.to, condition: h.condition, actor: h.actor, at: when(h.at), note: h.note,
      } })))));
      return out;
    }

    await refresh();
  }

  // ---- Shell ----------------------------------------------------------------------------------------------------

  const main = el('div', { class: 'appworks-page' });
  document.body.prepend(S.dom.Shell({
    product: { name: 'AppWorks', homeHref: '/', mark: 'W' },
    mainId: 'appworks-main',
    navigation: [
      { id: 'projects', label: 'Projects', href: '/', current: config.page === 'projects' },
      ...(config.project ? [{ id: 'project', label: 'Project', href: '/projects/' + encodeURIComponent(config.project), current: true }] : []),
    ],
    children: main,
  }));
  (config.page === 'projects' ? projectsPage(main) : projectPage(main)).catch((error) => {
    main.replaceChildren(S.dom.ErrorPanel({ title: 'The page could not load', message: error.message, code: error.code }));
  });
})();
