import type { Register } from 'claude-code';
import {
  DEFAULTS,
  DECISION_DEFAULTS,
  DECISION_KEY,
  ROSTER_KEY,
  MAX_PANEL_ROWS,
  SCAN_COMMAND,
  bar,
  isDecisionView,
  rankOptions,
  readDecision,
  buildDecisionRequest,
  buildRequest,
  contextBlock,
  decisionNote,
  isSkillEntry,
  parseRoster,
  pickDecision,
  pickWinner,
  readAskQuestion,
} from './suggest';

/**
 * Two decision points, both answered by TypeSafe's Jev model.
 *
 * `prompt.submit` ranks the installed skills for the turn and attaches one
 * advisory line. `tool.call` on AskUserQuestion answers the agent's own
 * this-or-that question when Jev is confident enough, so the turn continues
 * without stopping the user.
 *
 * Every path fails open. Routing is an optimisation, and no turn should wait
 * on, or break because of, a third-party service.
 *
 * `$` is written out at every call site: the loader refuses a module that
 * binds, passes, spreads or destructures it.
 */
export const register: Register = (on) => {
  // The roster is built once per session. The gotchas list says to do work
  // like this in session.start: a prompt.submit hook has a 10 s dispatch
  // budget, enforced outside the hook, that a cold scan could blow.
  on('session.start', async ($, e, next) => {
    // The skill router is opt-in. Off, there is nothing to scan for.
    const enabled = await $.env.get('TYPESAFE_SKILL_ROUTER');
    if (!enabled) return next(e);
    try {
      const scan = await $.process.run(SCAN_COMMAND, { timeoutMs: 8000 });
      const roster = parseRoster(scan.stdout);
      await $.store.set(ROSTER_KEY, roster);
      // A cap that is too low drops real skills, and the router then says
      // nothing about them. That looks exactly like "nothing fits", so report
      // it instead of staying silent.
      if (roster.length >= DEFAULTS.maxSkills) {
        $.ui.log(`typesafe-mod: roster hit the ${DEFAULTS.maxSkills} cap; raise maxSkills`);
      } else {
        $.ui.log(`typesafe-mod: ${roster.length} skills indexed`);
      }
    } catch (err) {
      // A hook that throws is skipped silently, so catch and say so.
      $.ui.log(`typesafe-mod: skill scan failed, router off (${String(err)})`);
    }
    return next(e);
  });

  on('prompt.submit', async ($, e, next) => {
    // Opt-in: this hook runs on every prompt, so it costs 160-420 ms of the
    // turn each time. The money is negligible (Jev bills input only, at
    // $0.042/M, so about $1.35 a month at 100 prompts a day); the latency is
    // not. Off by default, on with TYPESAFE_SKILL_ROUTER=1.
    const enabled = await $.env.get('TYPESAFE_SKILL_ROUTER');
    if (!enabled) return next(e);

    const text = typeof e.text === 'string' ? e.text.trim() : '';
    // A slash command already names what it wants, and a very short prompt
    // carries too little to route on.
    if (text.length < 12 || text.startsWith('/')) return next(e);

    const key = await $.env.get('TYPESAFE_API_KEY');
    if (!key) return next(e);

    const cached = await $.store.get(ROSTER_KEY);
    const roster = Array.isArray(cached) ? cached.filter(isSkillEntry) : [];
    if (roster.length === 0) return next(e);

    let block = '';
    try {
      // The dispatch budget cannot be caught from in here, so race it and
      // give up first.
      const res = await Promise.race([
        $.http.fetch(DEFAULTS.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify(buildRequest(roster, text)),
        }),
        $.clock.sleep(DEFAULTS.budgetMs).then(() => null),
      ]);

      if (res === null) {
        $.ui.log('typesafe-mod: skill router timed out, continuing');
      } else if (res.ok) {
        const winner = pickWinner(JSON.parse(res.text));
        if (winner) {
          block = contextBlock(winner);
          $.ui.log(`typesafe-mod: skill hint ${winner.name} (${winner.confidence.toFixed(2)})`);
        }
      } else {
        $.ui.log(`typesafe-mod: skill router HTTP ${res.status}`);
      }
    } catch (err) {
      $.ui.log(`typesafe-mod: skill router unavailable (${String(err)})`);
    }

    if (!block) return next(e);
    return next({ ...e, context: [...(e.context ?? []), block] });
  });

  // The agent's own this-or-that question is the general decision point.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const question = readAskQuestion((e as { questions?: unknown }).questions);
    // Multi-select, or a batch of questions, is not one Choice. Ask the human.
    if (!question) return next(e);

    const off = await $.env.get('TYPESAFE_DECIDE_OFF');
    if (off) return next(e);

    const key = await $.env.get('TYPESAFE_API_KEY');
    if (!key) return next(e);

    try {
      const cwd = await $.session.cwd();
      const res = await Promise.race([
        $.http.fetch(DEFAULTS.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify(
            buildDecisionRequest(
              question,
              `A coding agent paused mid-task in ${cwd} to ask this question. ` +
                `Judge only from the question and the options as written.`
            )
          ),
        }),
        $.clock.sleep(DEFAULTS.budgetMs).then(() => null),
      ]);

      if (res !== null && res.ok) {
        const payload: unknown = JSON.parse(res.text);
        const view = readDecision(payload, question, DECISION_DEFAULTS.minConfidence);

        // Record the distribution whatever happens next. When the dialog does
        // open, the render hook can then show why the router stood aside,
        // which is the case where the numbers are most worth seeing.
        if (view) await $.store.set(DECISION_KEY, view);
        else await $.store.delete(DECISION_KEY);

        // Advisory by default. The dialog opens, and the recommendation goes
        // to the transcript beside it.
        //
        // The alternative is to answer the call outright, which needs `deny`,
        // and the engine defines `deny` as "the model receives the text as an
        // error result". A working decision then renders red as a failure, and
        // the agent argues with it. Answering with `{ result }` instead would
        // need this tool's output schema, which the generated types do not
        // declare, and a guessed shape breaks the dialog. So the interrupting
        // version is opt-in, and the readable one is the default.
        const auto = await $.env.get('TYPESAFE_AUTO_ANSWER');
        if (auto) {
          const decision = pickDecision(payload, question, DECISION_DEFAULTS.minConfidence);
          if (decision) {
            $.ui.log(
              `typesafe-mod: decided "${decision.label}" (${decision.confidence.toFixed(2)}) without asking`
            );
            return { deny: decisionNote(question, decision) };
          }
        } else if (view) {
          const ranked = rankOptions(view, question);
          const spread = ranked.map((r) => `${r.label} ${r.p.toFixed(2)}`).join(', ');
          $.ui.log(
            view.wouldAnswer
              ? `typesafe-mod: Jev picks ${view.choice} (${spread}), confidence ${view.confidence.toFixed(2)}`
              : `typesafe-mod: Jev leans ${view.choice} (${spread}), but confidence ${view.confidence.toFixed(2)} is under the floor, so this one is yours`
          );
        }
      }
    } catch (err) {
      $.ui.log(`typesafe-mod: decision router unavailable (${String(err)})`);
    }

    // Not confident, unreachable, or switched off, so the user gets asked.
    return next(e);
  });

  // Draws Jev's distribution over the question dialog. Only fires in
  // show-your-work mode, because otherwise the hook answers the tool call
  // and no dialog is ever drawn.
  on('ui.render', { component: 'AskUserQuestion' }, async ($, e, next) => {
    const stored = await $.store.get(DECISION_KEY);
    if (!isDecisionView(stored)) {
      $.ui.log('typesafe-mod: render skipped, no stored decision');
      return next(e);
    }

    const question = readAskQuestion((e.props as { questions?: unknown }).questions);
    if (!question) {
      $.ui.log('typesafe-mod: render skipped, dialog props did not parse');
      return next(e);
    }
    // A stale decision belongs to an earlier dialog, so draw the engine's own.
    if (question.question !== stored.question) {
      $.ui.log(`typesafe-mod: render skipped, stale decision for "${stored.question.slice(0, 40)}"`);
      return next(e);
    }

    const el = $.ui.resolve(e);
    const width = Math.max(16, Math.min((e.viewport?.columns ?? 80) - 28, 32));

    // The engine refuses a panel of more than 12 elements around the dialog,
    // so each option is one Text rather than a Box holding two. That leaves
    // room for the title, the footer and core's own node.
    const ranked = rankOptions(stored, question).slice(0, MAX_PANEL_ROWS);
    const rows = ranked.map((row) =>
      el.Text({
        key: row.label,
        color: row.label === stored.choice ? 'green' : 'gray',
        bold: row.label === stored.choice,
        children: `${bar(row.p, width)} ${row.p.toFixed(2)}  ${row.label}`,
      })
    );

    // The dialog is drawn by exactly one engine node, so this wraps core's own
    // tree rather than replacing it. A tree with no engine node is refused.
    const core = await next(e);

    return el.Box({
      flexDirection: 'column',
      paddingX: 1,
      children: [
        el.Text({ bold: true, color: 'cyan', children: 'TypeSafe decision router' }),
        ...rows,
        el.Text({
          dimColor: true,
          children: stored.wouldAnswer
            ? `confidence ${stored.confidence.toFixed(2)}, over the 0.75 floor`
            : `confidence ${stored.confidence.toFixed(2)}, under the 0.75 floor, so this one is yours`,
        }),
        core,
      ],
    });
  });
};
