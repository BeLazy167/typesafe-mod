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
  readAskQuestions,
  buildBatchRequest,
  readDecisions,
  isDecisionViewList,
  decisionLine,
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

  // The agent's own this-or-that question is the general decision point. A
  // dialog may carry several, and they ride one request together.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const questions = readAskQuestions((e as { questions?: unknown }).questions);
    // Nothing routable here. A multi-select step is not a Choice, and
    // approximating one would answer a question the agent did not ask.
    if (questions.length === 0) return next(e);

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
            buildBatchRequest(
              questions,
              `A coding agent paused mid-task in ${cwd} to ask this. ` +
                `Judge only from the questions and the options as written.`
            )
          ),
        }),
        $.clock.sleep(DEFAULTS.budgetMs).then(() => null),
      ]);

      if (res !== null && res.ok) {
        const payload: unknown = JSON.parse(res.text);
        const views = readDecisions(payload, questions, DECISION_DEFAULTS.minConfidence);

        // Record them whatever happens next, so the render hook can show why
        // the router stood aside on the questions it did not answer.
        if (views.length > 0) await $.store.set(DECISION_KEY, views);
        else await $.store.delete(DECISION_KEY);

        // Answering the call outright needs `deny`, which the engine defines as
        // "the model receives the text as an error result", so a working
        // decision renders red. It is opt-in, and only for a lone question: a
        // single deny string cannot answer a dialog of several.
        const auto = await $.env.get('TYPESAFE_AUTO_ANSWER');
        const only = questions.length === 1 ? questions[0] : undefined;
        if (auto && only) {
          const decision = pickDecision(payload, only, DECISION_DEFAULTS.minConfidence);
          if (decision) {
            $.ui.log(
              `typesafe-mod: decided "${decision.label}" (${decision.confidence.toFixed(2)}) without asking`
            );
            return { deny: decisionNote(only, decision) };
          }
        }

        // Text has no element budget, so every question gets a line even when
        // the panel can only draw one.
        views.forEach((view, i) => {
          const q = questions[i];
          if (!q) return;
          const prefix = questions.length > 1 ? `(${i + 1}/${questions.length}) ` : '';
          $.ui.log(decisionLine(view, q, prefix));
        });
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
    if (!isDecisionViewList(stored)) {
      $.ui.log('typesafe-mod: render skipped, no stored decision');
      return next(e);
    }

    const questions = readAskQuestions((e.props as { questions?: unknown }).questions);
    if (questions.length === 0) {
      $.ui.log('typesafe-mod: render skipped, dialog props did not parse');
      return next(e);
    }

    // The engine caps what a hook may add around a dialog, so a batched dialog
    // gets bars for its first answered question only. The rest are in the
    // transcript, where text costs nothing.
    let index = -1;
    for (let i = 0; i < questions.length; i++) {
      if (stored.some((v) => v.question === questions[i]?.question)) {
        index = i;
        break;
      }
    }
    if (index < 0) {
      $.ui.log('typesafe-mod: render skipped, no decision matches this dialog');
      return next(e);
    }

    const question = questions[index]!;
    const view = stored.find((v) => v.question === question.question)!;

    const el = $.ui.resolve(e);
    const width = Math.max(16, Math.min((e.viewport?.columns ?? 80) - 28, 32));

    // One Text per option rather than a Box holding two, to stay inside the
    // element budget. Measured on 2.1.274: four rows draw, six are refused.
    const rows = rankOptions(view, question)
      .slice(0, MAX_PANEL_ROWS)
      .map((row) =>
        el.Text({
          key: row.label,
          color: row.label === view.choice ? 'green' : 'gray',
          bold: row.label === view.choice,
          children: `${bar(row.p, width)} ${row.p.toFixed(2)}  ${row.label}`,
        })
      );

    const title =
      questions.length > 1
        ? `TypeSafe decision router  (question ${index + 1} of ${questions.length})`
        : 'TypeSafe decision router';

    // The dialog is drawn by exactly one engine node, so this wraps core's own
    // tree rather than replacing it. A tree with no engine node is refused.
    const core = await next(e);

    return el.Box({
      flexDirection: 'column',
      paddingX: 1,
      children: [
        el.Text({ bold: true, color: 'cyan', children: title }),
        ...rows,
        el.Text({
          dimColor: true,
          children: view.wouldAnswer
            ? `confidence ${view.confidence.toFixed(2)}, over the 0.75 floor`
            : `confidence ${view.confidence.toFixed(2)}, under the 0.75 floor, so this one is yours`,
        }),
        core,
      ],
    });
  });
};
