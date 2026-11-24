# ponytail-forge

A fork of [ponytail](https://github.com/DietrichGebert/ponytail) 5.3.2 (MIT, Dietrich Gebert) with one addition: a **Prompt Optimizer**.

## What it adds

An `Optimize` switch in the grey panel above the prompt box (next to `Review`, `Audit` and `Board`). Switching it on opens a side panel:

1. Type a draft in the prompt box, optionally write a **comment** in the panel's field (what the prompt is for, how the result should look; paste examples if you have them), and press **Optimize draft**. The comment goes to every step, questions and final prompt alike, as context; it is not copied into the result word for word, and it stays until you change it.
2. The model judges the draft on nine dimensions (task, input, output, constraints, context, audience, memory, success criteria, examples) and, only if something that matters is open, asks up to three questions per round, two rounds at most. The questions come one at a time with the recommended answer first and up to two alternatives; pick one or type your own (Enter sends it, Shift+Enter starts a new line; text you paste there counts as an example) and press **Next**. **Back** returns to the earlier questions with their answers; changing one keeps the later ones. **Skip** takes the recommendation. The last question's button is **Send**: it sends the round.
3. It writes one tight prompt and lists the assumptions (every accepted recommendation and every gap it filled). **Use** puts it in the prompt box, **Copy** copies it, **Grill harder** asks for another round. Enter in the comment field rewrites the prompt by the comment. The panel does not repeat your draft; it is already in the chat.

The method lives in `skills/prompt-optimizer/SKILL.md`, which also works as a normal skill (`/ponytail-forge:prompt-optimizer`). It borrows the nine dimensions and the token audit from prompt-master (MIT, nidhinjs) and the question rounds from "grill me".

Inside a conversation the optimizer forks the session, so it sees what is already settled; before the first turn it uses the model named in the `optimizerModel` setting (default `sonnet`).

## Install (every session, every project)

This repository is its own marketplace. Add it and install the plugin at user scope:

```
claude plugin marketplace add sinder2221/ponytail-forge
claude plugin install ponytail-forge@ponytail-forge --scope user
```

From a local clone, use its path instead of `sinder2221/ponytail-forge`. The marketplace records that path, so add it again after moving the folder.

The fork replaces ponytail. Turn the original off so hooks and the panel do not run twice:

```
claude plugin disable ponytail --scope user
```

Everything else (levels, review, audit, board, task ledger) works as in ponytail 5.3.2.

## Known limits

- The optimizer's model call is part of the session cost, so the panel's "last $" for the next turn can include it. It is not split out.
- A failed model call keeps your answers and the last result and shows the error; the same button retries.
- Two grill rounds by default; **Grill harder** allows more.
- No per-tool prompt profiles: the target is always Claude Code.
