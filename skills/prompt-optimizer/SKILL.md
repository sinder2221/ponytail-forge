---
name: prompt-optimizer
description: >
  Sharpen a draft prompt before it is sent: find what the prompt leaves
  unsaid, ask only the questions that matter (each with a recommended
  answer), then write one tight, ready-to-paste prompt. Use for "improve this
  prompt", "optimize my prompt", "make this prompt better", /prompt-optimizer.
---

Turn a rough prompt into one where every word earns its place. Two phases:
grill first, forge second. The method borrows the nine intent dimensions and
the token audit of prompt-master (MIT, nidhinjs) and the question rounds of
"grill me".

## 1. Intake (silent)

Judge the draft on nine dimensions: task, input, output, constraints, context,
audience, memory (earlier decisions it must not contradict), success criteria,
examples. Mark each clear, missing or ambiguous. Only missing or ambiguous
dimensions that would change the result are worth a question.

If the request has a `<comment>`, it is the person's own note on what the prompt
is for and how the result should look. Treat what it says as settled: do not ask
what it already answers, and use it for the dimensions it covers. Never copy it
into the prompt word for word. Text pasted into the comment or into an answer is
example material: use it to see what is wanted, and quote it only if asked.

## 2. Grill

Group the open points into a **design tree**: a question whose answer depends on
another open question waits for a later round. Ask only the **frontier**, the
questions that can be answered now, at most three per round.

Give each question a title, the question itself, and your **recommended
answer**, then up to two **alternatives** as `options` (the recommended answer
first). Questions are shown one at a time and the person can skip to the
recommendation, so make each one a real default, not a hedge.

Finding facts is your job. If the answer is in the conversation, use it instead
of asking. You have no tools, so never look anything up.

Stop when the frontier is empty or two rounds are done. Never invent an answer
to a question you did not ask: a gap you fill yourself is an assumption and
must be listed.

## 3. Forge

Write one prompt, ready to paste, in the language of the draft:

- Say the task and what done looks like first.
- Put in only the context, constraints and examples that change the output.
- Cut every word whose removal would not change the output. Prefer one precise
  instruction to three soft ones.
- Ask for reasoning the reader can check (assumptions, evidence), never hidden
  chain-of-thought tricks.
- Do not pad with a role line, politeness or restated instructions.

Then give, in this order: the prompt as one copyable block, one line naming the
strategy you used, and an **Assumptions** list of every answer the person
accepted as recommended and every gap you filled yourself.

If the draft is already sharp, say so, change nothing, and skip the grill.
