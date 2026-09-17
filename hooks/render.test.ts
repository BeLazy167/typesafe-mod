import { test, expect, mock } from 'claude-code/testing';
import { DECISION_KEY } from './suggest';

const QUESTION = 'Roll back, or fix forward?';
const props = {
  tool: 'AskUserQuestion',
  questions: [
    {
      question: QUESTION,
      options: [
        { label: 'Roll back', description: 'Restores the last known good build.' },
        { label: 'Fix forward', description: 'Ships a patch on top.' },
      ],
    },
  ],
};
const view = {
  question: QUESTION,
  choice: 'Fix forward',
  confidence: 0.47,
  wouldAnswer: false,
  probabilities: { 'Fix forward': 0.73, 'Roll back': 0.27 },
};

const render = ($: { ui: { render: (i: unknown) => Promise<unknown> } }) =>
  $.ui.render({
    surface: 'terminal',
    component: 'AskUserQuestion',
    requestId: 'r1',
    viewport: { columns: 100, rows: 40 },
    props,
  });

test('the hook draws its own tree, not the engine default', async ($, on) => {
  mock.store(on, { [DECISION_KEY]: [view] });
  // Stand in for core beneath the plugins: the one engine node the dialog needs.
  on('ui.render', () => ({ type: 'engine', ref: 0 }));
  const tree = await render($);
  const json = JSON.stringify(tree);
  // A bare engine node at the root means the hook was skipped entirely.
  expect((tree as { type: string }).type).toBe('Box');
  expect(json).toContain('TypeSafe decision router');
  // Both probabilities are drawn, highest first.
  expect(json).toContain('0.73  Fix forward');
  expect(json).toContain('0.27  Roll back');
  expect(json).toContain('under the 0.75 floor');
  // The dialog is drawn by exactly one engine node; more or fewer is refused.
  expect(json.split('"type":"engine"').length - 1).toBe(1);
  // The bars keep a fixed width so the rows line up.
  const bars = json.match(/[\u2588\u2591]+/g) ?? [];
  expect(bars.length).toBe(2);
  expect(bars[0]!.length).toBe(bars[1]!.length);
});

test('with no stored decision the hook stands aside', async ($, on) => {
  mock.store(on, {});
  // Nothing implements ui.render beneath the plugins in a test, so the bottom
  // hook throws. That the call reaches it is the point: the hook did not draw.
  await expect(render($)).rejects.toThrow();
});
