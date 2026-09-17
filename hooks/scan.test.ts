import { test, expect } from 'claude-code/testing';
import { scanAskQuestions, readAskQuestions } from './suggest';

const good = { question: 'A or B?', options: [{ label: 'A' }, { label: 'B' }] };

test('a dialog that cannot be routed says why, not just that it failed', async () => {
  // The distinction that matters: a missing field is a different fault from a
  // field of the wrong type, and only one of them is worth changing.
  expect(scanAskQuestions(undefined).skipped[0]).toBe('questions is undefined, not an array');
  expect(scanAskQuestions(null).skipped[0]).toBe('questions is null, not an array');
  expect(scanAskQuestions('nope').skipped[0]).toBe('questions is string, not an array');
  expect(scanAskQuestions({}).skipped[0]).toBe('questions is object, not an array');
  expect(scanAskQuestions([]).skipped[0]).toBe('the call carried no questions');
});

test('each dropped step names itself and its fault', async () => {
  expect(scanAskQuestions([42]).skipped[0]).toBe('step 1 is number, not an object');
  expect(scanAskQuestions([null]).skipped[0]).toBe('step 1 is null, not an object');
  expect(scanAskQuestions([{ ...good, multiSelect: true }]).skipped[0])
    .toBe('step 1 is multi-select, which is not a Choice');
  expect(scanAskQuestions([{ options: good.options }]).skipped[0])
    .toBe('step 1 has no question text');
  expect(scanAskQuestions([{ question: 'q', options: 'nope' }]).skipped[0])
    .toBe('step 1 has string where its options should be');
  expect(scanAskQuestions([{ question: 'q', options: [{ label: 'A' }] }]).skipped[0])
    .toBe('step 1 offers 1, so there is nothing to choose between');
  expect(scanAskQuestions([{ question: 'q', options: [{ label: 'A' }, { label: 7 }] }]).skipped[0])
    .toBe('step 1 option 2 has no string label');
});

test('the step number points at the right step in a batch', async () => {
  const scan = scanAskQuestions([good, { ...good, multiSelect: true }, good]);
  // Two routed, one dropped, and the reason names step 2 rather than step 1.
  expect(scan.routable.length).toBe(2);
  expect(scan.skipped).toEqual(['step 2 is multi-select, which is not a Choice']);
});

test('a routable dialog reports no faults', async () => {
  const scan = scanAskQuestions([good, good]);
  expect(scan.routable.length).toBe(2);
  expect(scan.skipped).toEqual([]);
});

test('readAskQuestions still returns the routable steps alone', async () => {
  expect(readAskQuestions([good, { ...good, multiSelect: true }]).length).toBe(1);
  expect(readAskQuestions(null)).toEqual([]);
});
