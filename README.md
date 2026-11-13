# ponytail-forge

A fork of [ponytail](https://github.com/DietrichGebert/ponytail) 5.3.2 (MIT, Dietrich Gebert) with one addition: a **Prompt Optimizer**.

## What it adds

An `Optimize` switch in the grey panel above the prompt box (next to `Review`, `Audit` and `Board`). Switching it on opens a side panel:

1. Type a draft in the prompt box and press **Optimize draft**. The panel shows the original.
2. The model judges the draft on nine dimensions (task, input, output, constraints, context, audience, memory, success criteria, examples) and, only if something that matters is open, asks up to three questions per round, two rounds at most. Each question has a recommended answer; an empty answer takes it. **Accept all recommendations** answers a whole round in one click.
3. It writes one tight prompt and lists the assumptions (every accepted recommendation and every gap it filled). **Use** puts it in the prompt box, **Copy** copies it, **Grill harder** asks for another round.

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
