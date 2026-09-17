import { test, expect } from 'claude-code/testing';
import {
  NONE,
  buildBatchRequest,
  buildRequest,
  parseRoster,
  pickDecision,
  pickWinner,
  readFrontmatter,
  bar,
  rankOptions,
  readDecisions,
} from './suggest';

const LIMITS = { maxSkills: 120, descriptionChars: 220 };
const GATES = { minConfidence: 0.6, minNeedsSkill: 0.5 };

test('reads folded and inline frontmatter descriptions', async () => {
  const folded = readFrontmatter([
    '---',
    'name: typesafe-ai',
    'description: >',
    '  Build AI-powered software with TypeSafe.',
    '  Use when a feature needs programmable common sense.',
    'license: MIT',
    '---',
  ]);
  expect(folded.name).toBe('typesafe-ai');
  expect(folded.description).toBe(
    'Build AI-powered software with TypeSafe. Use when a feature needs programmable common sense.'
  );
  expect(folded.license).toBe('MIT');

  const inline = readFrontmatter(['---', 'name: unslop', 'description: Cut AI tells.', '---']);
  expect(inline.description).toBe('Cut AI tells.');
});

test('parses a roster and drops skills with no description', async () => {
  const stdout = [
    '===SKILL===/home/u/.claude/skills/alpha/SKILL.md',
    '---',
    'name: alpha',
    'description: Does the alpha thing.',
    '---',
    '# Alpha',
    '===SKILL===/home/u/.claude/skills/nameless/SKILL.md',
    '---',
    'description: Derives its name from the folder.',
    '---',
    '===SKILL===/home/u/.claude/skills/bare/SKILL.md',
    '---',
    'name: bare',
    '---',
  ].join('\n');

  const roster = parseRoster(stdout, LIMITS);
  expect(roster.length).toBe(2);
  expect(roster[0]?.name).toBe('alpha');
  // Falls back to the containing folder when frontmatter omits `name`.
  expect(roster[1]?.name).toBe('nameless');
  // `bare` declares nothing to rank on, so it cannot be offered.
  expect(roster.some((s) => s.name === 'bare')).toBe(false);
});

test('the roster request always offers a no-match option', async () => {
  const body = buildRequest([{ name: 'alpha', description: 'Does alpha.' }], 'do the alpha thing');
  const questions = body.questions as Record<string, { criteria: Record<string, string> }>;
  expect(Object.keys(questions.skill!.criteria)).toContain(NONE);
  expect(Object.keys(questions)).toContain('needs_skill');
});

test('pickWinner stays quiet unless every gate passes', async () => {
  const good = {
    answers: {
      skill: { choice: 'alpha', confidence: 0.9 },
      needs_skill: { noul: 0.8 },
    },
  };
  expect(pickWinner(good, GATES)?.name).toBe('alpha');

  // The model says nothing fits.
  const none = { answers: { skill: { choice: NONE, confidence: 0.99 }, needs_skill: { noul: 0.9 } } };
  expect(pickWinner(none, GATES)).toBe(null);

  // Confident about the skill, but the turn wants no procedure at all.
  const chatter = {
    answers: { skill: { choice: 'alpha', confidence: 0.95 }, needs_skill: { noul: 0.1 } },
  };
  expect(pickWinner(chatter, GATES)).toBe(null);

  // Right skill, not enough confidence to spend the agent's attention on.
  const unsure = {
    answers: { skill: { choice: 'alpha', confidence: 0.3 }, needs_skill: { noul: 0.9 } },
  };
  expect(pickWinner(unsure, GATES)).toBe(null);

  expect(pickWinner('not json at all', GATES)).toBe(null);
  expect(pickWinner({ answers: {} }, GATES)).toBe(null);
});

test('pickDecision refuses a label that was never offered', async () => {
  const question = {
    question: 'Fix or revert?',
    options: [{ label: 'Fix' }, { label: 'Revert' }],
  };

  expect(pickDecision({ answers: { pick: { choice: 'Fix', confidence: 0.9 } } }, question, 0.75)?.label).toBe('Fix');
  // Below the floor, the human decides.
  expect(pickDecision({ answers: { pick: { choice: 'Fix', confidence: 0.5 } } }, question, 0.75)).toBe(null);
  // A label we never offered must never be acted on.
  expect(pickDecision({ answers: { pick: { choice: 'Rewrite', confidence: 0.99 } } }, question, 0.75)).toBe(null);
});

test('the decision request carries the agent options as criteria', async () => {
  const body = buildBatchRequest(
    [{ question: 'Fix or revert?', options: [{ label: 'Fix', description: 'Finish it' }, { label: 'Revert' }] }],
    'mid-task'
  );
  const questions = body.questions as Record<string, { criteria: Record<string, string> }>;
  expect(questions.q0!.criteria.Fix).toBe('Finish it');
  // An option with no description still has to be selectable.
  expect(questions.q0!.criteria.Revert).toBe('Revert');
});

test('bar draws a proportional, fixed-width bar', async () => {
  expect(bar(0, 10)).toBe('░'.repeat(10));
  expect(bar(1, 10)).toBe('█'.repeat(10));
  expect(bar(0.5, 10)).toBe('█'.repeat(5) + '░'.repeat(5));
  // Width must hold whatever the input, or the rows stop lining up.
  expect(bar(0.37, 20).length).toBe(20);
  // Out-of-range and non-finite input must not produce a ragged row.
  expect(bar(1.8, 10).length).toBe(10);
  expect(bar(-1, 10)).toBe('░'.repeat(10));
  expect(bar(NaN, 10).length).toBe(10);
});

test('readDecisions reports the distribution even below the floor', async () => {
  const q = { question: 'YAML or TOML?', options: [{ label: 'YAML' }, { label: 'TOML' }] };
  const body = {
    answers: { q0: { choice: 'TOML', confidence: 0.4, probabilities: { TOML: 0.6, YAML: 0.4 } } },
  };
  const view = readDecisions(body, [q], 0.75)[0]!;
  expect(view.choice).toBe('TOML');
  // Below 0.75, so the router reports but does not act.
  expect(view.wouldAnswer).toBe(false);
  expect(view.probabilities.TOML).toBe(0.6);

  const sure = readDecisions(
    { answers: { q0: { choice: 'TOML', confidence: 0.9, probabilities: { TOML: 0.9, YAML: 0.1 } } } },
    [q], 0.75)[0]!;
  expect(sure.wouldAnswer).toBe(true);

  // A label nobody offered must never read as answerable.
  const bogus = readDecisions(
    { answers: { q0: { choice: 'JSON', confidence: 0.99, probabilities: { JSON: 0.99 } } } },
    [q], 0.75)[0]!;
  expect(bogus.wouldAnswer).toBe(false);
});

test('rankOptions orders by probability and keeps unscored options', async () => {
  const q = { question: 'q', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] };
  const view = { question: 'q', choice: 'B', confidence: 0.8, wouldAnswer: true,
    probabilities: { A: 0.2, B: 0.7 } };
  const ranked = rankOptions(view, q);
  expect(ranked.map((r) => r.label).join(',')).toBe('B,A,C');
  // An option the model never scored still gets a row, at zero.
  expect(ranked[2]!.p).toBe(0);
});
