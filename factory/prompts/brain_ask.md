# BRAIN ASK — answer from the company brain

You are `{{agent}}`. There is no worktree and nothing to run: `/work` is empty and you have no tools. Everything you need is below. Answer with the structured output only.

## Question
{{context.brainAsk.question}}

## What the brain holds about it
{{context.brainAsk.rows}}

## What to do
1. Answer the question in `reply` from the rows above. Do not go beyond them.
2. Put in `cites` the slug of every row your answer rests on, copied verbatim.
3. When the rows do not hold the answer, set `known` to false, say so in one sentence and cite nothing.
