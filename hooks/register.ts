import type { Register } from 'claude-code';
import {
  DEFAULTS,
  DECISION_DEFAULTS,
  DECISION_KEY,
  ROSTER_KEY,
  MAX_PANEL_ROWS,
  SCAN_COMMAND,
  bar,
  rankOptions,
  buildRequest,
  contextBlock,
  decisionNote,
  isSkillEntry,
  parseRoster,
  pickDecision,
  pickWinner,
  scanAskQuestions,
  buildBatchRequest,
  readDecisions,
  isDecisionViewList,
  decisionLine,
  summaryRow,
  pairDecisions,
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
    const scan = scanAskQuestions((e as { questions?: unknown }).questions);
    const questions = scan.routable;
    // Nothing routable here. A multi-select step is not a Choice, and
    // approximating one would answer a question the agent did not ask.
    if (questions.length === 0) {
      $.ui.log(`typesafe-mod: not routed, ${scan.skipped.join('; ')}`);
      return next(e);
    }
    // Some steps routed and some did not. Say which, so a dialog that is only
    // half covered does not look like a dialog the router ignored.
    if (scan.skipped.length > 0) {
      $.ui.log(`typesafe-mod: skipped ${scan.skipped.length} of ${scan.skipped.length + questions.length}, ${scan.skipped.join('; ')}`);
    }

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

    const questions = scanAskQuestions((e.props as { questions?: unknown }).questions);
    if (questions.routable.length === 0) {
      $.ui.log(`typesafe-mod: render skipped, ${questions.skipped.join('; ')}`);
      return next(e);
    }

    const steps = questions.routable;
    const paired = pairDecisions(steps, stored);
    if (paired.length === 0) {
      $.ui.log('typesafe-mod: render skipped, no decision matches this dialog');
      return next(e);
    }

    const el = $.ui.resolve(e);
    const columns = e.viewport?.columns ?? 80;
    const multi = paired.length > 1;

    // The render event never says which step the dialog is showing, so a
    // batched dialog gets one row per question rather than one question's
    // option bars. Pinning the panel to step one would misread every later
    // step as belonging to the first.
    let rows;
    let title;
    let footer;
    if (multi) {
      const shown = paired.slice(0, MAX_PANEL_ROWS);
      const labelWidth = Math.min(
        shown.reduce((w, p) => Math.max(w, p.view.choice.length), 0),
        Math.max(8, columns - 34)
      );
      const barWidth = Math.max(8, Math.min(columns - labelWidth - 28, 16));
      rows = shown.map((p, i) =>
        el.Text({
          key: `q${i}`,
          color: p.view.wouldAnswer ? 'green' : 'gray',
          bold: p.view.wouldAnswer,
          children: summaryRow(p.view, barWidth, labelWidth),
        })
      );
      const over = paired.filter((p) => p.view.wouldAnswer).length;
      title = `TypeSafe decision router  (${paired.length} questions, one row each)`;
      footer =
        over === 0
          ? 'none cleared the 0.75 floor, so every one of these is yours'
          : `${over} of ${paired.length} cleared the 0.75 floor, marked with a tick`;
    } else {
      const only = paired[0]!;
      const width = Math.max(16, Math.min(columns - 28, 32));
      rows = rankOptions(only.view, only.question)
        .slice(0, MAX_PANEL_ROWS)
        .map((row) =>
          el.Text({
            key: row.label,
            color: row.label === only.view.choice ? 'green' : 'gray',
            bold: row.label === only.view.choice,
            children: `${bar(row.p, width)} ${row.p.toFixed(2)}  ${row.label}`,
          })
        );
      title = 'TypeSafe decision router';
      footer = only.view.wouldAnswer
        ? `confidence ${only.view.confidence.toFixed(2)}, over the 0.75 floor`
        : `confidence ${only.view.confidence.toFixed(2)}, under the 0.75 floor, so this one is yours`;
    }

    // The dialog is drawn by exactly one engine node, so this wraps core's own
    // tree rather than replacing it. A tree with no engine node is refused.
    const core = await next(e);

    return el.Box({
      flexDirection: 'column',
      paddingX: 1,
      children: [
        el.Text({ bold: true, color: 'cyan', children: title }),
        ...rows,
        el.Text({ dimColor: true, children: footer }),
        core,
      ],
    });
  });
};
