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
to ask you a this-or-that question, the hook sends it to Jev and puts the
probability for each option in the transcript beside the dialog. You still
choose. `TYPESAFE_AUTO_ANSWER=1` lets Jev answer instead, so the dialog never
opens. This runs by default.

A dialog may carry several questions, and they all ride one request. Jev answers
independent questions in parallel, so two steps cost one call. Each gets its own
transcript line, and each is judged on its own: it can be confident about one
step and hand the next back to you.

```
typesafe-mod: (1/2) Jev picks Tag v0.3.0 as-is (Tag v0.3.0 as-is 0.89,
Bump to 0.4.0 0.10, Backfill v0.2.0 0.01), confidence 0.84
typesafe-mod: (2/2) Jev leans Everything since the first commit
(Everything 0.51, Only since the bump 0.49), but confidence 0.02 is under
the floor, so this one is yours
```

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
| `TYPESAFE_AUTO_ANSWER` | Set to `1` to let Jev answer the dialog outright instead of advising. See the warning below. |

By default the router advises. The dialog opens as usual, with a panel above it
drawing a bar per option, and the same numbers go to the transcript.

```
  TypeSafe decision router

  ███████████████████████░░░░░░░ 0.73  Fix forward
  ████████░░░░░░░░░░░░░░░░░░░░░░ 0.27  Roll back

  confidence 0.47, under the 0.75 floor, so this one is yours
```

The panel wraps core's dialog rather than replacing it. `AskUserQuestion` is
drawn by exactly one engine node, so a tree without that node is refused and
core draws its own. The engine also caps how much a hook may add around a
dialog, so the panel draws at most four options, highest probability first.

The transcript line carries the same information in one row:

```
typesafe-mod: Jev leans Fix forward (Fix forward 0.73, Roll back 0.27),
but confidence 0.47 is under the floor, so this one is yours
```

`TYPESAFE_AUTO_ANSWER=1` makes the router answer the call instead, so the
dialog never opens. Know the cost before you turn it on. Answering a tool call
from a hook requires `deny`, and the engine defines `deny` as "the model
receives the text as an error result". So a decision that worked renders in red
as a failure, and the agent may argue with it rather than proceed. Answering
with `{ result }` would avoid that, but it needs this tool's output schema,
which the generated types do not declare.

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

In auto-answer mode the hook returns `{ deny: text }`, which is the only way a
hook can answer a tool call it is given. The engine defines `deny` as "the model
receives the text as an error result", so the answer renders in red. `{ result }`
would render normally, but core validates it against the tool's output schema
and the generated types declare none for `AskUserQuestion`. That is why advising
is the default.

The router skips multi-select steps, because a multi-select answer is not a
Choice and approximating one would answer a question you did not ask. The other
steps in the same dialog still route.

The panel draws bars for the first answered step only. The engine caps what a
hook may add around a dialog, so a second set of bars would be refused and core
would draw its own. Every step still gets a transcript line, where text costs
nothing.

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
claude plugin test typesafe-skill-mod     # 38 tests
```
