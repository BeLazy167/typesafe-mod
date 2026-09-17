import { test, expect, mock } from 'claude-code/testing';
import { summaryRow } from './suggest';

const ASK = {
  tool: 'AskUserQuestion',
  questions: [{ question: 'A or B?', options: [{ label: 'A' }, { label: 'B' }] }],
};

/**
 * Nothing implements tool.call beneath the plugins in a test, so the bottom
 * hook throws. A hook that stands aside therefore reaches it and rejects,
 * while a hook that answers on its own resolves. That difference is what these
 * assert: the switches are the documented controls and had no test at all.
 */
const call = ($: { tool: { call: (i: unknown) => Promise<unknown> } }) =>
  $.tool.call({ tool: 'AskUserQuestion', ...ASK });

test('no API key means the router never runs', async ($, on) => {
  mock.env(on, {});
  // Reaching the bottom hook proves it stood aside rather than calling out.
  await expect(call($ as never)).rejects.toThrow();
});

test('TYPESAFE_DECIDE_OFF stops the decision router', async ($, on) => {
  mock.env(on, { TYPESAFE_API_KEY: 'k', TYPESAFE_DECIDE_OFF: '1' });
  await expect(call($ as never)).rejects.toThrow();
});

test('an unroutable dialog stands aside whatever the switches say', async ($, on) => {
  mock.env(on, { TYPESAFE_API_KEY: 'k' });
  await expect(
    ($ as never as { tool: { call: (i: unknown) => Promise<unknown> } }).tool.call({
      tool: 'AskUserQuestion',
      questions: [{ question: 'pick many', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true }],
    })
  ).rejects.toThrow();
});

test('the skill router stays off unless asked for', async ($, on) => {
  mock.env(on, { TYPESAFE_API_KEY: 'k' });
  // With the switch unset the hook returns next(e) before reading the roster,
  // so the prompt reaches the bottom unchanged.
  await expect(
    ($ as never as { prompt: { submit: (i: unknown) => Promise<unknown> } }).prompt.submit({
      text: 'a prompt long enough to be routed',
    })
  ).rejects.toThrow();
});

test('summaryRow lines up its columns whatever the label', async () => {
  const view = (choice: string, top: number, confidence: number, wouldAnswer: boolean) => ({
    question: 'q', choice, confidence, wouldAnswer, probabilities: { [choice]: top },
  });

  const short = summaryRow(view('Yes', 0.9, 0.88, true), 10, 16);
  const long = summaryRow(view('A very long option label indeed', 0.4, 0.3, false), 10, 16);
  // Padded to the same width, so the confidence column aligns down the panel.
  expect(short.indexOf('0.88')).toBe(long.indexOf('0.30'));
  // A label past the budget is cut rather than pushing the column out.
  expect(long).toContain('…');
  // Equal width once the tick is discounted, since only a ticked row carries it.
  expect(long.length).toBe(short.replace(' ✓', '').length);
  // Only an answer over the floor is ticked.
  expect(short.endsWith('✓')).toBe(true);
  expect(long.endsWith('✓')).toBe(false);
  // The bar is the winner's probability, at the width asked for.
  expect((short.match(/[█░]+/) ?? [''])[0].length).toBe(10);
});
