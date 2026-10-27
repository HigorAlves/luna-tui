# Brief template

Disclosed from `writing-plans`. Read when drafting the triage brief: the JSON shape the stage answers with and the semantics of every slice field.

## The brief

In factory mode (LUNA_FACTORY=1) the plan is the triage stage's answer, not a document. **Every brief has this shape:**

```json
{
  "kind": "brief",
  "summary": "<what to change, where, and how to check it — 2-5 sentences: goal, approach, key libraries>",
  "criteria": [
    "<every ticket criterion, refined until testable, plus any the plan needs>"
  ],
  "assumptions": [
    "<each gap you filled with a default, one per entry>"
  ],
  "slices": [
    {
      "title": "<component or behaviour>",
      "est_loc": 140,
      "touchpoints": ["src/exact/path.ts", "test/exact/path.test.ts"],
      "acceptance": [
        "<command to run or behaviour to observe, with the expected result>"
      ]
    }
  ],
  "confidence": "high | medium | low",
  "risk": "high | medium | low"
}
```

`summary` plays the role a plan header used to: goal in one sentence, architecture in two or three, the tech stack by name. `criteria[]` replaces the ticket's list for every later stage, so nothing the ticket asked for may be missing from it.

## What a slice implies

A slice is executed by the implementing stage as a TDD loop. Each acceptance line should let the implementer write these steps without guessing:

````markdown
### Slice N: [Component Name]

Files (= touchpoints):
- Create: `exact/path/to/file.py`
- Modify: `exact/path/to/existing.py` (the `function()` block)
- Test: `tests/exact/path/to/test.py`

1. Write the failing test for the first acceptance line

```python
def test_specific_behavior():
    result = function(input)
    assert result == expected
```

2. Run it to verify it fails — `pytest tests/path/test.py::test_name -v`, expected: FAIL with "function not defined"
3. Write the minimal implementation
4. Run it to verify it passes — same command, expected: PASS
5. Commit — `git add tests/path/test.py src/path/file.py && git commit -m "feat: add specific feature"`
````

If an acceptance line does not translate into step 1 and step 2 (a test to write, a command to run, an expected output), it is not testable yet — rewrite it.

## Slice fields

- **`title`** — the component or behaviour, specific enough to be a commit subject.
- **`est_loc`** — the budget contract for the slice; see [LOC-BUDGET.md](LOC-BUDGET.md).
- **`touchpoints`** — the repo-relative files this slice owns. Evidence-based, never guessed: use the graph (`graphify affected`) or Grep to confirm what the slice actually touches. These become the implementer's file-ownership boundary.
- **`acceptance`** — 2–5 **testable** criteria: each names a command to run or an observable behavior, never "works correctly". They are the slice's contract for the implementer and the scoring rubric for the verifying and e2e stages.
- **Ordering** — `slices[]` is ordered; a slice that consumes another's output comes after it. The order is the only dependency expression in the brief, so a slice that could run in any position is placed where it reads most naturally, and a slice with any doubt goes after the slices it might depend on — sequential is the safe default.
