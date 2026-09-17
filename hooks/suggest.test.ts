import { test, expect } from 'claude-code/testing';
import {
  NONE,
  buildDecisionRequest,
  buildRequest,
  parseRoster,
  pickDecision,
  pickWinner,
  readAskQuestion,
  readFrontmatter,
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

test('only a single-select question is routable', async () => {
  const one = [{ question: 'Fix or revert?', options: [{ label: 'Fix' }, { label: 'Revert' }] }];
  expect(readAskQuestion(one)?.options.length).toBe(2);

  // Multi-select is not a Choice.
  expect(readAskQuestion([{ ...one[0], multiSelect: true }])).toBe(null);
  // A batch of questions is not one decision.
  expect(readAskQuestion([one[0], one[0]])).toBe(null);
  // One option is not a choice.
  expect(readAskQuestion([{ question: 'Only?', options: [{ label: 'Yes' }] }])).toBe(null);
  expect(readAskQuestion(undefined)).toBe(null);
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
  const body = buildDecisionRequest(
    { question: 'Fix or revert?', options: [{ label: 'Fix', description: 'Finish it' }, { label: 'Revert' }] },
    'mid-task'
  );
  const questions = body.questions as Record<string, { criteria: Record<string, string> }>;
  expect(questions.pick!.criteria.Fix).toBe('Finish it');
  // An option with no description still has to be selectable.
  expect(questions.pick!.criteria.Revert).toBe('Revert');
});
