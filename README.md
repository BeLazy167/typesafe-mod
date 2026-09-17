# typesafe-mod

A Claude Code function hook that sends two kinds of decision to TypeSafe's Jev
model.

Jev returns typed answers (Choice, Noul, Score) with probabilities instead of
prose, so your code can branch on both the answer and how confident it is.

This is a function hook, not a shell hook. It is a TypeScript module that runs
inside the agent loop, so it can answer a tool call itself rather than only
allowing or blocking one.

## What it does

**Decision router, on `tool.call` for `AskUserQuestion`.** When the agent stops
to ask you a this-or-that question, Jev answers it instead. The dialog never
opens and the turn keeps going. If Jev is not confident enough, you get asked as
normal. This runs by default.

**Skill router, on `prompt.submit`.** One request ranks every installed skill
against your prompt and asks whether the turn needs a procedure at all. A
confident winner becomes one advisory line of context. The skill list the agent
already has does not change, so prefix caching over it still works. This is off
by default. See the cost section for why.

## Install

```sh
claude plugin marketplace add BeLazy167/typesafe-mod
claude plugin install typesafe-mod@typesafe-mod
```

To run it from a checkout without installing:

```sh
claude --plugin-dir /path/to/typesafe-mod
```

Two things are required. Without either one, the mod loads and does nothing.

**1. Function hooks turned on.** They are early access. In
`~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } }
```

**2. A TypeSafe API key** in the environment Claude Code runs in. Get one at
<https://console.typesafe.ai/keys>.

```sh
export TYPESAFE_API_KEY="your-key-here"
```

## Switches

| Variable | Effect |
| --- | --- |
| `TYPESAFE_API_KEY` | Unset, and neither router runs. |
| `TYPESAFE_SKILL_ROUTER` | Set to `1` to turn the skill router on. Off otherwise. |
| `TYPESAFE_DECIDE_OFF` | Set to any value to stop Jev answering your questions. |
| `TYPESAFE_SHOW_WORK` | Set to any value to let the dialog open and draw Jev's probability for each option. You still choose. |

Show-your-work mode exists because the router is invisible when it works. It
answers the tool call, so nothing is drawn and one line goes to the transcript.
With `TYPESAFE_SHOW_WORK=1` the dialog opens as usual, and a `ui.render` hook
draws a bar per option with the probability Jev gave it, the pick in green, and
whether that pick cleared the 0.75 floor.

```
  TypeSafe decision router

  Should the new config file be YAML or TOML?

  █████████████████████████████░░░ 0.92  YAML
  ███░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ 0.08  TOML

  confidence 0.83, above the 0.75 floor, so the router would answer this itself
```

Both thresholds live in `hooks/suggest.ts`. `DEFAULTS.minConfidence` is 0.6 for
the skill hint. `DECISION_DEFAULTS.minConfidence` is 0.75 for answering instead
of you.

The decision floor is higher for a reason. When the skill router says nothing,
you lose one hint. When the decision router is confidently wrong, it answers a
question that was yours to answer. Tune both against your own turns rather than
these numbers.

## What it costs

Jev bills input tokens only, at $0.042 per million. It does no token-by-token
decoding, so output is not billed.

| | Input tokens | Cost |
| --- | --- | --- |
| One decision | 374 | $0.000016 |
| One skill-router prompt | 6,772 | $0.00028 |

The decision router fires only when the agent stops to ask you something, so it
costs almost nothing.

The skill router runs on every prompt. At 100 prompts a day that is about $0.85
a month, which is not the reason it is off by default. It adds 166 to 420 ms to
every prompt you type, and that is the reason.

## Measured on a 194-skill install

The scan takes about 1.1 s, once per session.

| Prompt | Answer |
| --- | --- |
| "the merge is conflicted on three files" | `resolving-merge-conflicts` at 1.00 |
| "what time is it in Tokyo right now" | nothing, `needs_skill` 0.02 |
| "review the changes before I open a PR" | `code-review` at 0.96 |

## When it fails

Every path fails open. A missing key, an HTTP error, a timeout, a hook that
throws, a body that will not parse, and a skill list that never built all fall
through to `next(e)`, and the turn carries on untouched.

A hook cannot catch the engine's 10 second dispatch budget, because the engine
enforces it from outside. So each call races `$.clock.sleep(4000)` and gives up
first.

The decision router also checks that the answer is one of the options you
offered. If it is not, the router ignores it and you get asked.

## Design notes

Every call writes `$` out in full, as in `$.http.fetch(...)`. The loader rejects
a module that binds, passes, spreads, or destructures `$`. So every engine call
sits inline in `register.ts`, and the logic lives in pure functions in
`suggest.ts`. Those functions take plain data and return plain data, which is
why the tests need no mocks.

One `$.process.run` reads all the skills, rather than about 194 `$.fs.read`
calls. `$.fs` compares paths against the project directory as strings, so it
cannot reach `~/.claude`.

The scan runs `find -L`. Most of `~/.claude/skills` is symlinks, and without
`-L` the scan found 4 of 46 entries.

The hook answers `AskUserQuestion` with `{ deny: text }`. The generated types do
not declare that tool's own result shape, and a guessed shape breaks the dialog.
`deny` is typed, documented, and its string reaches the agent.

The router skips multi-select questions and batches of questions. Neither one is
a single Choice, and approximating them would answer a question you did not ask.

## Known limits

- The decision router reads the question and its options, not the conversation.
  It also passes the working directory. Questions that depend on anything else
  will route worse.
- Ranking 194 skills costs 6,772 input tokens per prompt. A shorter list costs
  less. Cutting the list blindly is what broke the first version: a cap of 120
  dropped `resolving-merge-conflicts`, and a missing skill looks exactly like
  "nothing fits".
- 54 skill names here appear in more than one plugin. The scan keeps the first
  one it finds, so the router may name a different plugin's copy.

```sh
claude plugin validate typesafe-skill-mod
claude plugin test typesafe-skill-mod     # 7 tests
```
