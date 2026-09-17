import type { Register } from 'claude-code';
import {
  DEFAULTS,
  DECISION_DEFAULTS,
  ROSTER_KEY,
  SCAN_COMMAND,
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
      // A cap that bites drops real skills and the router goes quiet on them,
      // which reads exactly like "nothing fits". Say so instead.
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
        const decision = pickDecision(JSON.parse(res.text), question, DECISION_DEFAULTS.minConfidence);
        if (decision) {
          $.ui.log(
            `typesafe-mod: decided "${decision.label}" (${decision.confidence.toFixed(2)}) without asking`
          );
          // Answering alone, before next: the dialog never opens. `deny` is the
          // documented way to return text the agent reads, and the tool's own
          // result schema is not declared, so it is not guessed at here.
          return { deny: decisionNote(question, decision) };
        }
      }
    } catch (err) {
      $.ui.log(`typesafe-mod: decision router unavailable (${String(err)})`);
    }

    // Not confident, unreachable, or switched off: the user gets asked.
    return next(e);
  });
};
