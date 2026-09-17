# typesafe-mod

A Claude Mod that routes two kinds of decision to TypeSafe's Jev model.

Jev returns typed judgments (Choice, Noul, Score) instead of prose, so code can
branch on the answer and its confidence. See
<https://docs.typesafe.ai/cookbooks/skill_suggestion.md>.

## What it does

**1. Skill router — `prompt.submit`, every turn.**
Ranks every installed skill against the prompt in one request, and asks in the
same request whether the turn needs a procedure at all. A confident winner
becomes one advisory line of context. The roster itself is never touched, so
prefix caching over it still holds.

**2. Decision router — `tool.call` on `AskUserQuestion`.**
When the agent stops to ask you a this-or-that question, Jev answers it instead,
if it is confident enough. The dialog never opens and the turn continues. Below
the floor, you get asked as normal.

## Install

```sh
claude plugin marketplace add BeLazy167/typesafe-mod
claude plugin install typesafe-mod@typesafe-mod
```

Or run it from a checkout without installing:

```sh
claude --plugin-dir /path/to/typesafe-mod
```

Two things are required, and without either the mod loads and quietly does
nothing.

**1. Function hooks turned on.** In `~/.claude/settings.json`:

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
| `TYPESAFE_API_KEY` | Unset: both routers no-op. |
| `TYPESAFE_DECIDE_OFF` | Any value: keeps the skill router, stops Jev answering your questions. |

Thresholds live in `hooks/suggest.ts`: `DEFAULTS.minConfidence` (0.6) for the
skill hint, `DECISION_DEFAULTS.minConfidence` (0.75) for answering instead of
you. The decision floor sits higher on purpose: a quiet skill router costs one
unassisted turn, while a confident wrong decision removes you from a choice that
was yours. Tune both on your own turns, not on these numbers.

## Measured here

187 skills indexed in ~1.1 s, once per session. Routing adds 160-370 ms per
prompt and about 10.7k input tokens per prompt, which is the real running cost.

| Prompt | Answer |
| --- | --- |
| "the merge is conflicted on three files" | `resolving-merge-conflicts` @ 1.00 |
| "what time is it in Tokyo right now" | nothing, `needs_skill` 0.02 |
| "review the changes before I open a PR" | `code-review` @ 0.96 |

## Failure behaviour

Every path fails open. A missing key, an HTTP error, a timeout, a thrown hook,
an unparseable body, or a roster that never built all fall through to `next(e)`
and the turn proceeds untouched. The engine's 10 s dispatch budget cannot be
caught from inside a hook, so each call races `$.clock.sleep(4000)` and gives up
first.

The decision router refuses a label that was not among the options offered, so a
hallucinated answer can never be acted on.

## Design notes

`$` is written out at every call site. The loader refuses a module that binds,
passes, spreads or destructures it, which is why every engine call sits inline
in `register.ts` and all logic lives in pure functions in `suggest.ts`. That is
also what makes them testable.

The roster is read with one `$.process.run` rather than ~190 `$.fs.read` calls:
`$.fs` is fenced to the project by a string compare and cannot reach `~/.claude`.

`AskUserQuestion` is answered with `{ deny: text }`. The tool's own result
schema is not declared in the generated types, and a guessed shape breaks the
dialog; `deny` is typed, documented, and its string reaches the agent.

Multi-select questions and batches of questions are never routed. Neither is one
Choice, and approximating them would answer a question you did not ask.

## Known limits

- The decision router sees the question and its options, not the conversation.
  Questions whose meaning depends on unstated context will route worse. It
  passes the cwd and nothing else.
- ~10.7k input tokens per prompt is the price of ranking 187 skills every turn.
  Narrowing the roster would cut it; truncating it blindly is what broke the
  first version.
- Skill names that collide across plugins (54 here) are deduplicated by first
  occurrence, so the router may name the other plugin's copy.

```sh
claude plugin validate typesafe-skill-mod
claude plugin test typesafe-skill-mod     # 7 tests
```
