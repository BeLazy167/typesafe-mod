import { test, expect, mock } from 'claude-code/testing';
import {
  DECISION_KEY,
  buildBatchRequest,
  decisionLine,
  isDecisionViewList,
  readAskQuestions,
  readDecisions,
} from './suggest';

const VERSION = 'Which version should the release be?';
const SCOPE = 'What should the release notes cover?';
const dialog = [
  {
    question: VERSION,
    options: [
      { label: 'Tag v0.3.0 as-is', description: 'No edit. Tag HEAD and cut the release.' },
      { label: 'Bump to 0.4.0', description: 'Edit the manifest, commit, tag v0.4.0.' },
    ],
  },
  {
    question: SCOPE,
    options: [
      { label: 'Since the last tag', description: 'There is no last tag, so this is everything.' },
      { label: 'Since the version bump', description: 'Only what landed after the manifest changed.' },
    ],
  },
];

test('every routable step in a batched dialog is read', async () => {
  const qs = readAskQuestions(dialog);
  expect(qs.length).toBe(2);
  expect(qs[0]!.question).toBe(VERSION);
  expect(qs[1]!.question).toBe(SCOPE);

  // A multi-select step is dropped, and the rest still route.
  const mixed = [dialog[0], { ...dialog[1], multiSelect: true }];
  expect(readAskQuestions(mixed).length).toBe(1);

  // Nothing routable at all yields an empty list rather than throwing.
  expect(readAskQuestions([{ ...dialog[0], multiSelect: true }])).toEqual([]);
  expect(readAskQuestions(null)).toEqual([]);
  expect(readAskQuestions([])).toEqual([]);
  expect(readAskQuestions([{ question: 'one option', options: [{ label: 'A' }] }])).toEqual([]);
});

test('a batch rides one request, keyed per question', async () => {
  const body = buildBatchRequest(readAskQuestions(dialog), 'mid-task');
  const asked = body.questions as Record<string, { type: string; criteria: Record<string, string> }>;
  const state = body.state as Record<string, string>;

  // One Choice per step, so they answer in parallel in a single call.
  expect(Object.keys(asked).sort()).toEqual(['q0', 'q1']);
  expect(asked.q0!.type).toBe('choice');
  expect(Object.keys(asked.q0!.criteria)).toContain('Tag v0.3.0 as-is');
  expect(Object.keys(asked.q1!.criteria)).toContain('Since the last tag');
  // The situation is sent once, not per question.
  expect(state.situation).toBe('mid-task');
  expect(state.q0).toBe(VERSION);
  // Each question points at its own state field.
  expect(asked.q0!.instructions).toContain('`state.q0`');
  expect(asked.q1!.instructions).toContain('`state.q1`');
});

test('partial confidence answers one step and defers the other', async () => {
  const qs = readAskQuestions(dialog);
  const views = readDecisions(
    {
      answers: {
        q0: { choice: 'Tag v0.3.0 as-is', confidence: 0.91, probabilities: { 'Tag v0.3.0 as-is': 0.95, 'Bump to 0.4.0': 0.05 } },
        q1: { choice: 'Since the last tag', confidence: 0.42, probabilities: { 'Since the last tag': 0.6, 'Since the version bump': 0.4 } },
      },
    },
    qs,
    0.75
  );
  expect(views.length).toBe(2);
  // Confident on the first, so the router would act on it.
  expect(views[0]!.wouldAnswer).toBe(true);
  // Under the floor on the second, so that one stays with the human.
  expect(views[1]!.wouldAnswer).toBe(false);
  expect(views[1]!.choice).toBe('Since the last tag');
});

test('a step Jev could not answer is skipped, not guessed', async () => {
  const qs = readAskQuestions(dialog);
  // Only q1 came back, and q0 is missing entirely.
  const views = readDecisions({ answers: { q1: { choice: 'Since the last tag', confidence: 0.9 } } }, qs, 0.75);
  expect(views.length).toBe(1);
  expect(views[0]!.question).toBe(SCOPE);

  // A label nobody offered is reported but never actionable.
  const bogus = readDecisions({ answers: { q0: { choice: 'Delete the repo', confidence: 1 } } }, qs, 0.75);
  expect(bogus[0]!.wouldAnswer).toBe(false);

  expect(readDecisions(null, qs, 0.75)).toEqual([]);
  expect(readDecisions({ answers: {} }, qs, 0.75)).toEqual([]);
});

test('the store guard accepts a list and refuses anything else', async () => {
  const view = { question: 'q', choice: 'c', confidence: 0.5, probabilities: {}, wouldAnswer: false };
  expect(isDecisionViewList([view])).toBe(true);
  expect(isDecisionViewList([view, view])).toBe(true);
  // The old single-object shape must not be read as a list.
  expect(isDecisionViewList(view)).toBe(false);
  for (const v of [null, undefined, [], {}, [null], [{ question: 'q' }], 'x'])
    expect(isDecisionViewList(v)).toBe(false);
});

test('each question gets its own transcript line', async () => {
  const qs = readAskQuestions(dialog);
  const sure = { question: VERSION, choice: 'Tag v0.3.0 as-is', confidence: 0.91,
    wouldAnswer: true, probabilities: { 'Tag v0.3.0 as-is': 0.95, 'Bump to 0.4.0': 0.05 } };
  const unsure = { question: SCOPE, choice: 'Since the last tag', confidence: 0.42,
    wouldAnswer: false, probabilities: { 'Since the last tag': 0.6, 'Since the version bump': 0.4 } };

  const a = decisionLine(sure, qs[0]!, '(1/2) ');
  expect(a).toContain('(1/2) Jev picks Tag v0.3.0 as-is');
  expect(a).toContain('0.95');
  const b = decisionLine(unsure, qs[1]!, '(2/2) ');
  expect(b).toContain('(2/2) Jev leans Since the last tag');
  expect(b).toContain('under the floor, so this one is yours');
});

test('a batched dialog gets one row per question, not one question in detail', async ($, on) => {
  const views = [
    { question: VERSION, choice: 'Tag v0.3.0 as-is', confidence: 0.91, wouldAnswer: true,
      probabilities: { 'Tag v0.3.0 as-is': 0.95, 'Bump to 0.4.0': 0.05 } },
    { question: SCOPE, choice: 'Since the last tag', confidence: 0.42, wouldAnswer: false,
      probabilities: { 'Since the last tag': 0.6, 'Since the version bump': 0.4 } },
  ];
  mock.store(on, { [DECISION_KEY]: views });
  on('ui.render', () => ({ type: 'engine', ref: 0 }));

  const json = JSON.stringify(await $.ui.render({
    surface: 'terminal', component: 'AskUserQuestion', requestId: 'r',
    viewport: { columns: 100, rows: 40 },
    props: { tool: 'AskUserQuestion', questions: dialog },
  }));

  // One row per question. The render event never says which step is on screen,
  // so drawing one question's options would be wrong on every other step.
  const bars = json.match(/[\u2588\u2591]+/g) ?? [];
  expect(bars.length).toBe(2);
  expect(json).toContain('2 questions, one row each');
  // Both winners appear, so paging between steps never contradicts the panel.
  expect(json).toContain('Tag v0.3.0 as-is');
  expect(json).toContain('Since the last tag');
  // Both confidences appear, and only one cleared the floor.
  expect(json).toContain('0.91');
  expect(json).toContain('0.42');
  expect(json).toContain('1 of 2 cleared the 0.75 floor');
  expect(json.split('\u2713').length - 1).toBe(1);
  expect(json.split('"type":"engine"').length - 1).toBe(1);
});

test('a lone question still gets its options drawn in full', async ($, on) => {
  const view = { question: VERSION, choice: 'Tag v0.3.0 as-is', confidence: 0.91, wouldAnswer: true,
    probabilities: { 'Tag v0.3.0 as-is': 0.95, 'Bump to 0.4.0': 0.05 } };
  mock.store(on, { [DECISION_KEY]: [view] });
  on('ui.render', () => ({ type: 'engine', ref: 0 }));

  const json = JSON.stringify(await $.ui.render({
    surface: 'terminal', component: 'AskUserQuestion', requestId: 'r',
    viewport: { columns: 100, rows: 40 },
    props: { tool: 'AskUserQuestion', questions: [dialog[0]] },
  }));
  // A single question has no ambiguity about which step is showing, so it keeps
  // the per-option bars.
  const bars = json.match(/[\u2588\u2591]+/g) ?? [];
  expect(bars.length).toBe(2);
  expect(json).toContain('0.95  Tag v0.3.0 as-is');
  expect(json).toContain('0.05  Bump to 0.4.0');
  expect(json).not.toContain('one row each');
});

test('every question shows even when none cleared the floor', async ($, on) => {
  const views = [
    { question: VERSION, choice: 'Tag v0.3.0 as-is', confidence: 0.3, wouldAnswer: false,
      probabilities: { 'Tag v0.3.0 as-is': 0.55, 'Bump to 0.4.0': 0.45 } },
    { question: SCOPE, choice: 'Since the last tag', confidence: 0.2, wouldAnswer: false,
      probabilities: { 'Since the last tag': 0.52, 'Since the version bump': 0.48 } },
  ];
  mock.store(on, { [DECISION_KEY]: views });
  on('ui.render', () => ({ type: 'engine', ref: 0 }));
  const json = JSON.stringify(await $.ui.render({
    surface: 'terminal', component: 'AskUserQuestion', requestId: 'r',
    viewport: { columns: 100, rows: 40 },
    props: { tool: 'AskUserQuestion', questions: dialog },
  }));
  expect(json).toContain('none cleared the 0.75 floor');
  expect(json.split('\u2713').length - 1).toBe(0);
});

test('a dialog with no matching decision is left alone', async ($, on) => {
  mock.store(on, {
    [DECISION_KEY]: [{ question: 'a question from an earlier dialog', choice: 'x',
      confidence: 0.9, wouldAnswer: true, probabilities: { x: 1 } }],
  });
  on('ui.render', () => ({ type: 'engine', ref: 0 }));
  const tree = await $.ui.render({
    surface: 'terminal', component: 'AskUserQuestion', requestId: 'r',
    viewport: { columns: 100, rows: 40 },
    props: { tool: 'AskUserQuestion', questions: dialog },
  });
  expect(JSON.stringify(tree)).not.toContain('TypeSafe decision router');
});
