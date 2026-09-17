import { test, expect, mock } from 'claude-code/testing';
import {
  DECISION_KEY,
  MAX_PANEL_ROWS,
  NONE,
  bar,
  buildBatchRequest,
  buildRequest,
  isDecisionView,
  isSkillEntry,
  parseRoster,
  pickDecision,
  pickWinner,
  rankOptions,
  readDecisions,
  scanAskQuestions,
  readFrontmatter,
} from './suggest';

const LIMITS = { maxSkills: 500, descriptionChars: 80 };
const GATES = { minConfidence: 0.6, minNeedsSkill: 0.5 };

// ---------------------------------------------------------------------------
// Input the model or the agent can hand us that must never crash a turn.
// ---------------------------------------------------------------------------

test('a question with many options and no descriptions still routes', async () => {
  const qs = scanAskQuestions([
    { question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }, { label: 'D' }] },
  ]).routable;
  expect(qs[0]!.options.length).toBe(4);
  const body = buildBatchRequest(qs, 'situation');
  const questions = body.questions as Record<string, { criteria: Record<string, string> }>;
  // An option with no description must still be selectable, so the label stands in.
  expect(questions.q0!.criteria.A).toBe('A');
  expect(Object.keys(questions.q0!.criteria).length).toBe(4);
});

test('question and label text with quotes and newlines survives serialisation', async () => {
  const q = scanAskQuestions([
    {
      question: 'Use "smart" quotes,\nor plain ones?',
      options: [{ label: 'He said "yes"' }, { label: "it's fine\ttabbed" }],
    },
  ]).routable[0]!;
  const body = buildBatchRequest([q], 'x');
  // Must round-trip as JSON, since this is what goes on the wire.
  const round = JSON.parse(JSON.stringify(body)) as typeof body;
  const questions = round.questions as Record<string, { criteria: Record<string, string> }>;
  expect(Object.keys(questions.q0!.criteria)).toContain('He said "yes"');
  expect(pickDecision({ answers: { pick: { choice: 'He said "yes"', confidence: 0.9 } } }, q, 0.75)!.label)
    .toBe('He said "yes"');
});

// ---------------------------------------------------------------------------
// Responses the service can return, including ones it should never return.
// ---------------------------------------------------------------------------

test('a malformed or hostile response never yields a decision', async () => {
  const q = { question: 'A or B?', options: [{ label: 'A' }, { label: 'B' }] };
  const bad: unknown[] = [
    null,
    undefined,
    'a string',
    42,
    [],
    {},
    { answers: null },
    { answers: [] },
    { answers: {} },
    { answers: { pick: null } },
    { answers: { pick: {} } },
    { answers: { pick: { choice: 'A' } } }, // no confidence
    { answers: { pick: { confidence: 0.9 } } }, // no choice
    { answers: { pick: { choice: 'A', confidence: 'high' } } },
    { answers: { pick: { choice: 42, confidence: 0.9 } } },
    { answers: { pick: { choice: 'A', confidence: NaN } } },
    { answers: { pick: { choice: 'A', confidence: Infinity } } },
  ];
  for (const payload of bad) {
    expect(pickDecision(payload, q, 0.75)).toBe(null);
    // The batch reader must be as strict, since it reads the same answers.
    expect(readDecisions(payload, [q], 0.75)).toEqual([]);
  }
  // An option never offered must never be acted on, at any confidence.
  expect(pickDecision({ answers: { pick: { choice: 'C', confidence: 1 } } }, q, 0.75)).toBe(null);
  expect(readDecisions({ answers: { q0: { choice: 'C', confidence: 1 } } }, [q], 0.75)[0]!.wouldAnswer)
    .toBe(false);
});

test('readDecisions tolerates missing or junk probabilities', async () => {
  const q = { question: 'A or B?', options: [{ label: 'A' }, { label: 'B' }] };
  const view = readDecisions(
    { answers: { q0: { choice: 'A', confidence: 0.9, probabilities: { A: 'x', B: 0.4 } } } },
    [q], 0.75)[0]!;
  // A non-numeric probability is dropped rather than rendered as NaN.
  expect(view.probabilities.A).toBe(undefined);
  expect(view.probabilities.B).toBe(0.4);
  const ranked = rankOptions(view, q);
  expect(ranked.length).toBe(2);
  for (const r of ranked) expect(Number.isFinite(r.p)).toBe(true);

  const noProbs = readDecisions({ answers: { q0: { choice: 'A', confidence: 0.9 } } }, [q], 0.75)[0]!;
  expect(rankOptions(noProbs, q).every((r) => r.p === 0)).toBe(true);
});

test('the skill router stays quiet on every malformed answer', async () => {
  const bad: unknown[] = [
    null, {}, { answers: {} },
    { answers: { skill: { choice: 'a', confidence: 0.9 } } }, // no needs_skill
    { answers: { needs_skill: { noul: 0.9 } } }, // no skill
    { answers: { skill: { choice: NONE, confidence: 1 }, needs_skill: { noul: 1 } } },
    { answers: { skill: { choice: 'a', confidence: 0.9 }, needs_skill: { noul: 'yes' } } },
  ];
  for (const payload of bad) expect(pickWinner(payload, GATES)).toBe(null);
});

// ---------------------------------------------------------------------------
// The roster scan, against files that are not well behaved.
// ---------------------------------------------------------------------------

test('parseRoster survives empty, truncated and duplicate input', async () => {
  expect(parseRoster('', LIMITS)).toEqual([]);
  expect(parseRoster('no markers at all', LIMITS)).toEqual([]);
  // A file cut off mid-frontmatter has no closing fence.
  expect(parseRoster('===SKILL===/a/SKILL.md\n---\nname: a\n', LIMITS).length).toBe(0);
  // No frontmatter at all.
  expect(parseRoster('===SKILL===/a/SKILL.md\n# Just a heading\n', LIMITS).length).toBe(0);

  const dupes = [
    '===SKILL===/one/alpha/SKILL.md', '---', 'name: alpha', 'description: first', '---',
    '===SKILL===/two/alpha/SKILL.md', '---', 'name: alpha', 'description: second', '---',
  ].join('\n');
  const roster = parseRoster(dupes, LIMITS);
  expect(roster.length).toBe(1);
  // First wins, so the result is stable across runs.
  expect(roster[0]!.description).toBe('first');
});

test('descriptions are truncated to a fixed budget', async () => {
  const long = 'x'.repeat(500);
  const roster = parseRoster(
    `===SKILL===/a/big/SKILL.md\n---\nname: big\ndescription: ${long}\n---\n`, LIMITS);
  expect(roster[0]!.description.length).toBeLessThanOrEqual(LIMITS.descriptionChars);
  expect(roster[0]!.description.endsWith('...')).toBe(true);
});

test('the cap holds and never exceeds its limit', async () => {
  const many = Array.from({ length: 30 }, (_, i) =>
    `===SKILL===/s/s${i}/SKILL.md\n---\nname: s${i}\ndescription: d${i}\n---`).join('\n');
  expect(parseRoster(many, { maxSkills: 7, descriptionChars: 80 }).length).toBe(7);
  expect(parseRoster(many, LIMITS).length).toBe(30);
});

test('frontmatter with odd spacing and comments still yields name and description', async () => {
  const fm = readFrontmatter([
    '---',
    'name:    spaced   ',
    'description: >-',
    '   folded line one',
    '   folded line two',
    'allowed-tools: Read, Grep',
    '---',
  ]);
  expect(fm.name).toBe('spaced');
  expect(fm.description).toBe('folded line one folded line two');
  expect(fm['allowed-tools']).toBe('Read, Grep');
});

test('the roster request always offers a way out, even with one skill', async () => {
  const body = buildRequest([{ name: 'only', description: 'the only one' }], 'a prompt');
  const questions = body.questions as Record<string, { criteria: Record<string, string> }>;
  expect(Object.keys(questions.skill!.criteria)).toContain(NONE);
  // An empty roster still produces a valid request rather than throwing.
  const empty = buildRequest([], 'a prompt');
  const eq = empty.questions as Record<string, { criteria: Record<string, string> }>;
  expect(Object.keys(eq.skill!.criteria)).toEqual([NONE]);
});

test('store guards reject anything that is not what we wrote', async () => {
  expect(isSkillEntry({ name: 'a', description: 'b' })).toBe(true);
  for (const v of [null, undefined, 'x', 1, [], {}, { name: 'a' }, { description: 'b' }, { name: 1, description: 'b' }])
    expect(isSkillEntry(v)).toBe(false);

  expect(isDecisionView({ question: 'q', choice: 'c', confidence: 0.5, probabilities: {} })).toBe(true);
  for (const v of [null, {}, { question: 'q' }, { question: 'q', choice: 'c', confidence: 'x', probabilities: {} },
    { question: 'q', choice: 'c', confidence: 0.5 }])
    expect(isDecisionView(v)).toBe(false);
});

// ---------------------------------------------------------------------------
// The panel, across viewports and option counts.
// ---------------------------------------------------------------------------

const QUESTION = 'Roll back, or fix forward?';
const mkProps = (opts: Array<{ label: string }>) => ({
  tool: 'AskUserQuestion',
  questions: [{ question: QUESTION, options: opts }],
});
const view = {
  question: QUESTION,
  choice: 'Fix forward',
  confidence: 0.47,
  wouldAnswer: false,
  probabilities: { 'Fix forward': 0.73, 'Roll back': 0.27 },
};
type Ui = { ui: { render: (i: unknown) => Promise<unknown> } };
const draw = ($: Ui, props: unknown, viewport?: { columns: number; rows: number }) =>
  $.ui.render({ surface: 'terminal', component: 'AskUserQuestion', requestId: 'r', viewport, props });

test('the panel holds together at any terminal width', async ($, on) => {
  mock.store(on, { [DECISION_KEY]: [view] });
  on('ui.render', () => ({ type: 'engine', ref: 0 }));

  for (const columns of [20, 40, 80, 200, 1000]) {
    const json = JSON.stringify(await draw($ as Ui, mkProps([{ label: 'Roll back' }, { label: 'Fix forward' }]), { columns, rows: 40 }));
    const bars = json.match(/[█░]+/g) ?? [];
    expect(bars.length).toBe(2);
    // Equal width at every size, or the rows stop lining up.
    expect(bars[0]!.length).toBe(bars[1]!.length);
    // Never narrower than the floor, never wider than the cap.
    expect(bars[0]!.length).toBeGreaterThanOrEqual(16);
    expect(bars[0]!.length).toBeLessThanOrEqual(32);
    expect(json.split('"type":"engine"').length - 1).toBe(1);
  }

  // No viewport reported at all must not throw.
  const noViewport = JSON.stringify(await draw($ as Ui, mkProps([{ label: 'Roll back' }, { label: 'Fix forward' }])));
  expect((noViewport.match(/[█░]+/g) ?? []).length).toBe(2);
});

test('the panel stands aside for a question it has no decision for', async ($, on) => {
  mock.store(on, { [DECISION_KEY]: [view] });
  on('ui.render', () => ({ type: 'engine', ref: 0 }));
  // A stale decision from an earlier dialog must not be drawn over a new one.
  const stale = { tool: 'AskUserQuestion', questions: [{ question: 'A different question?', options: [{ label: 'A' }, { label: 'B' }] }] };
  const json = JSON.stringify(await draw($ as Ui, stale, { columns: 100, rows: 40 }));
  expect(json).not.toContain('TypeSafe decision router');
});

test('the panel stands aside when the stored value is junk', async ($, on) => {
  mock.store(on, { [DECISION_KEY]: [{ not: 'a decision' }] });
  on('ui.render', () => ({ type: 'engine', ref: 0 }));
  const json = JSON.stringify(await draw($ as Ui, mkProps([{ label: 'A' }, { label: 'B' }]), { columns: 100, rows: 40 }));
  expect(json).not.toContain('TypeSafe decision router');
});

test('the panel draws a row per option when there are more than two', async ($, on) => {
  const three = {
    question: QUESTION,
    choice: 'Fix forward',
    confidence: 0.39,
    wouldAnswer: false,
    probabilities: { 'Fix forward': 0.6, 'Roll back': 0.34, 'Roll back, then fix': 0.06 },
  };
  mock.store(on, { [DECISION_KEY]: [three] });
  on('ui.render', () => ({ type: 'engine', ref: 0 }));
  const props = mkProps([{ label: 'Roll back' }, { label: 'Fix forward' }, { label: 'Roll back, then fix' }]);
  const json = JSON.stringify(await draw($ as Ui, props, { columns: 100, rows: 40 }));
  expect((json.match(/[█░]+/g) ?? []).length).toBe(3);
  expect(json).toContain('0.60  Fix forward');
  expect(json).toContain('0.06  Roll back, then fix');
  expect(json.split('"type":"engine"').length - 1).toBe(1);
});

test('bar never renders a ragged row', async () => {
  for (const p of [0, 0.001, 0.5, 0.999, 1, -5, 12, NaN, Infinity, -Infinity]) {
    for (const w of [1, 8, 32]) {
      const b = bar(p, w);
      expect(b.length).toBe(w);
      expect(/^[█]*[░]*$/.test(b)).toBe(true);
    }
  }
});

test('a long option list stays inside the engine element budget', async ($, on) => {
  // The engine refuses a panel of more than 12 elements around the dialog.
  // Ten options must therefore be capped rather than drawn one row each.
  const labels = Array.from({ length: 10 }, (_, i) => `Option ${i}`);
  const probabilities: Record<string, number> = {};
  labels.forEach((l, i) => (probabilities[l] = (10 - i) / 55));

  mock.store(on, {
    [DECISION_KEY]: [{
      question: QUESTION,
      choice: 'Option 0',
      confidence: 0.8,
      wouldAnswer: true,
      probabilities,
    }],
  });
  on('ui.render', () => ({ type: 'engine', ref: 0 }));

  const json = JSON.stringify(
    await draw($ as Ui, mkProps(labels.map((label) => ({ label }))), { columns: 100, rows: 40 })
  );
  // Drawn at all, rather than refused and replaced by core's own tree.
  expect(json).toContain('TypeSafe decision router');
  const bars = json.match(/[█░]+/g) ?? [];
  expect(bars.length).toBe(MAX_PANEL_ROWS);
  // The highest probability survives the cap; the tail is dropped.
  expect(json).toContain('Option 0');
  expect(json).not.toContain('Option 9');
  expect(json.split('"type":"engine"').length - 1).toBe(1);
});
