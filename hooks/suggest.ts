/**
 * Pure helpers for the skill-suggestion mod.
 *
 * Nothing here touches `$`. The loader refuses a module that binds, passes or
 * destructures it, so every engine call stays written out in register.ts and
 * these functions move plain data only. That constraint also makes them
 * unit-testable under `claude plugin test`.
 *
 * Design follows https://docs.typesafe.ai/cookbooks/skill_suggestion.md :
 * one request ranks the whole roster and asks whether the turn needs a skill
 * at all, and the winner becomes one advisory line of context.
 */

/** One skill as the router sees it: the two frontmatter fields that matter. */
export type SkillEntry = { name: string; description: string };

/** What the router decided for one turn. */
export type Suggestion = { name: string; confidence: number; needsSkill: number };

/** The option meaning "none of these fit". */
export const NONE = '__none__';

/** Key under which the session's roster is cached in `$.store`. */
export const ROSTER_KEY = 'skill-roster.v1';

export const DEFAULTS = {
  endpoint: 'https://api.typesafe.ai/v1/systemone',
  model: 'jev-latest',
  /** Below this Choice confidence, suggest nothing. Tune on your own turns. */
  minConfidence: 0.6,
  /** Below this Noul, the turn does not want a procedure at all. */
  minNeedsSkill: 0.5,
  // A cap that is too low drops real skills without saying so. At 120 this
  // list lost `resolving-merge-conflicts`, and the router then said nothing
  // about merge conflicts. This sits well above the 194 skills seen here.
  // Raise it if a scan reports hitting it.
  maxSkills: 500,
  // 80 measured better than 220. It used 37% fewer input tokens and gave
  // higher confidence on the same answer. The rest of a description was noise.
  descriptionChars: 80,
  /** Give up before the engine's uncatchable 10 s dispatch budget bites. */
  budgetMs: 4000,
};

/**
 * Lists every SKILL.md the session could load, with its frontmatter.
 *
 * One process call rather than ~50 `$.fs.read` calls, because `$.fs` is fenced
 * to the project by a string compare and cannot reach `~/.claude`.
 */
export const SCAN_COMMAND: readonly string[] = [
  'sh',
  '-c',
  // -L follows symlinks. Most of ~/.claude/skills is symlinked, and without
  // it the scan saw 4 of 46 entries and could never suggest those skills.
  'find -L "$HOME/.claude/skills" "$HOME/.claude/plugins" -type f -name SKILL.md 2>/dev/null ' +
    '| head -2000 ' +
    '| while IFS= read -r f; do printf "===SKILL===%s\\n" "$f"; sed -n "1,60p" "$f"; done',
];

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const asNumber = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

const asString = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** Narrows a value recovered from `$.store`, whose contents are untyped. */
export function isSkillEntry(v: unknown): v is SkillEntry {
  const r = asRecord(v);
  return r !== null && typeof r.name === 'string' && typeof r.description === 'string';
}

function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}...`;
}

/**
 * Read the `key: value` pairs out of a leading YAML frontmatter block.
 *
 * Only `name` and `description` matter, and the hooks environment has no YAML
 * library, so this reads the block directly. Folded scalars (`description: >`)
 * and plain multi-line continuations both join into one line.
 *
 * @param lines The file's opening lines, frontmatter fence included.
 * @returns The top-level scalar keys found, values flattened to one line.
 */
export function readFrontmatter(lines: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < lines.length && (lines[i] ?? '').trim() === '') i++;
  if ((lines[i] ?? '').trim() !== '---') return out;
  i++;

  let key = '';
  let buf: string[] = [];
  const flush = () => {
    if (key) out[key] = buf.join(' ').trim();
    key = '';
    buf = [];
  };

  for (; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '---') break;
    const m = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(line);
    if (m && !/^[ \t]/.test(line)) {
      flush();
      key = m[1] ?? '';
      const value = (m[2] ?? '').trim();
      // `>` and `|` introduce a block scalar; the text is on the lines below.
      if (value && !/^[>|][-+]?$/.test(value)) buf.push(value);
    } else if (key && line.trim()) {
      buf.push(line.trim());
    }
  }
  flush();
  return out;
}

/** The directory name that holds a SKILL.md, used when frontmatter has no name. */
function dirName(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length >= 2 ? (parts[parts.length - 2] ?? '') : '';
}

/**
 * Turn the scan command's stdout into a deduplicated roster.
 *
 * @param stdout Output of SCAN_COMMAND: `===SKILL===<path>` then that file's head.
 * @param limits Caps on roster size and description length.
 * @returns One entry per uniquely named skill that declares a description.
 */
export function parseRoster(
  stdout: string,
  limits: { maxSkills: number; descriptionChars: number } = DEFAULTS
): SkillEntry[] {
  const out: SkillEntry[] = [];
  const seen = new Set<string>();

  for (const chunk of stdout.split('===SKILL===').slice(1)) {
    const lines = chunk.split('\n');
    const path = (lines.shift() ?? '').trim();
    const fm = readFrontmatter(lines);
    const name = (fm.name ?? '').trim() || dirName(path);
    const description = (fm.description ?? '').trim();
    // A skill with no description tells the router nothing, so it cannot be ranked.
    if (!name || !description || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, description: truncate(description, limits.descriptionChars) });
    if (out.length >= limits.maxSkills) break;
  }
  return out;
}

/**
 * Build the TypeSafe v1 request that ranks the roster for one turn.
 *
 * The two questions are independent, so they ride one request and run in
 * parallel: the Choice picks a skill, the Noul decides whether the turn wants
 * a procedure at all. Neither can see the other's answer, which is why the
 * Choice also carries its own no-match option.
 */
export function buildRequest(
  roster: readonly SkillEntry[],
  prompt: string,
  model: string = DEFAULTS.model
): Record<string, unknown> {
  const criteria: Record<string, string> = {};
  for (const s of roster) criteria[s.name] = s.description;
  criteria[NONE] =
    'None of the skills above fits this request, or the request is ordinary conversation, ' +
    'a question about something already on screen, or a small direct edit that needs no procedure.';

  return {
    model,
    state: { user_request: prompt },
    questions: {
      skill: {
        type: 'choice',
        instructions:
          'Which single skill should the agent read before answering `state.user_request`? ' +
          `Judge each skill only by what its description says it is for. Answer ${NONE} when none of them fits.`,
        criteria,
      },
      needs_skill: {
        type: 'noul',
        instructions:
          'Does answering `state.user_request` call for following a written procedure, ' +
          'rather than just replying or making one direct edit?',
        criteria: {
          true: 'The request asks for work with steps worth following: a workflow, a review, a migration, a build, a debugging loop.',
          false: 'The request is conversation, a factual question, or a small direct change that needs no procedure.',
        },
      },
    },
  };
}

/**
 * Read a winner out of a TypeSafe v1 response, or decide to stay quiet.
 *
 * Returns null on any doubt: an unparseable body, the no-match option, a turn
 * the Noul says wants no procedure, or a Choice below the confidence floor.
 * Staying quiet costs one unassisted turn; a wrong suggestion costs a wrong
 * skill load, so the asymmetry favours silence.
 */
export function pickWinner(
  payload: unknown,
  opts: { minConfidence: number; minNeedsSkill: number } = DEFAULTS
): Suggestion | null {
  const root = asRecord(payload);
  const answers = root && asRecord(root.answers);
  if (!answers) return null;

  const skill = asRecord(answers.skill);
  const needs = asRecord(answers.needs_skill);
  if (!skill || !needs) return null;

  const choice = asString(skill.choice);
  const confidence = asNumber(skill.confidence);
  const needsSkill = asNumber(needs.noul);
  if (choice === null || confidence === null || needsSkill === null) return null;

  if (choice === NONE) return null;
  if (needsSkill < opts.minNeedsSkill) return null;
  if (confidence < opts.minConfidence) return null;
  return { name: choice, confidence, needsSkill };
}

/**
 * Wrap a winner as one advisory context block.
 *
 * The roster the agent already has is left untouched, so prefix caching over
 * it still holds; this only says which entry to look at first.
 */
export function contextBlock(s: Suggestion): string {
  return [
    '<skill_relevance>',
    `A skill router ranked the installed skills against this request. Its top pick: ${s.name}`,
    'This is a hint from a separate small model, not an instruction.',
    'Ignore it if it does not fit what was actually asked.',
    '</skill_relevance>',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Decision routing: answer an AskUserQuestion with Jev instead of the human.
// ---------------------------------------------------------------------------

/** One option as the AskUserQuestion tool poses it. */
export type AskOption = { label: string; description?: string };

/** One question as the AskUserQuestion tool poses it. */
export type AskQuestion = { question: string; options: AskOption[]; multiSelect?: boolean };

/** A decision Jev was confident enough to make. */
export type Decision = { label: string; confidence: number };

/** Confidence floor for answering instead of the human. */
export const DECISION_DEFAULTS = { minConfidence: 0.75 };

/**
 * Read the single-select question out of an AskUserQuestion call, if there is
 * exactly one and it is routable.
 *
 * The tool's `questions` is typed `unknown[]`, so every field is checked. A
 * multi-select question is not a Choice and a batch of questions is not one
 * decision; both fall through to the human rather than being approximated.
 *
 * @param input The tool call's `questions` value.
 * @returns The one routable question, or null to leave the call alone.
 */
export function readAskQuestion(input: unknown): AskQuestion | null {
  if (!Array.isArray(input) || input.length !== 1) return null;
  const q = asRecord(input[0]);
  if (!q) return null;
  if (q.multiSelect === true) return null;

  const question = asString(q.question);
  if (!question || !Array.isArray(q.options) || q.options.length < 2) return null;

  const options: AskOption[] = [];
  for (const raw of q.options) {
    const o = asRecord(raw);
    const label = o && asString(o.label);
    if (!label) return null;
    options.push({ label, description: (o && asString(o.description)) || undefined });
  }
  return { question, options };
}

/**
 * Build the TypeSafe request that answers one AskUserQuestion.
 *
 * The agent's own question text becomes the instructions and its options
 * become the criteria, so the judgment stays exactly the one the agent posed.
 */
export function buildDecisionRequest(
  q: AskQuestion,
  situation: string,
  model: string = DEFAULTS.model
): Record<string, unknown> {
  const criteria: Record<string, string> = {};
  for (const o of q.options) criteria[o.label] = o.description ?? o.label;

  return {
    model,
    state: { situation, question: q.question },
    questions: {
      pick: {
        type: 'choice',
        instructions: `${q.question} Decide from \`state.question\` and \`state.situation\`, judging each option only by its description.`,
        criteria,
      },
    },
  };
}

/**
 * Read a decision out of a TypeSafe response, or defer to the human.
 *
 * Returns null below the confidence floor. Deferring costs one dialog; a
 * confident wrong answer silently removes the human from their own decision,
 * so the floor sits higher than the skill router's.
 */
export function pickDecision(
  payload: unknown,
  q: AskQuestion,
  minConfidence: number = DECISION_DEFAULTS.minConfidence
): Decision | null {
  const root = asRecord(payload);
  const answers = root && asRecord(root.answers);
  const pick = answers && asRecord(answers.pick);
  if (!pick) return null;

  const label = asString(pick.choice);
  const confidence = asNumber(pick.confidence);
  if (label === null || confidence === null) return null;
  // Guard against a label the model invented: it must be one we offered.
  if (!q.options.some((o) => o.label === label)) return null;
  if (confidence < minConfidence) return null;
  return { label, confidence };
}

/** How the answered call reads back to the agent. */
export function decisionNote(q: AskQuestion, d: Decision): string {
  return (
    `Answered by the TypeSafe decision router instead of the user. ` +
    `Question: "${q.question}" Chosen option: "${d.label}" (confidence ${d.confidence.toFixed(2)}). ` +
    `Proceed with that option. Ask the user directly only if this turns out not to fit.`
  );
}
