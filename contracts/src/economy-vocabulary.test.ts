import { describe, expect, it } from "vitest";

import { knownForm } from "./economy-vocabulary.ts";

describe("knownForm", () => {
  it.each([
    "pytest",
    "pytest -q",
    "python -m pytest",
    "python -m pytest --co",
    "python3.11 -m unittest",
    "python runtests.py",
    "npx tsc",
    "npx jest",
    "npx vitest run",
    "uvx ruff",
    "uv run pytest",
    "poetry run pytest",
    "pipx run tox",
    "yarn run jest",
    "yarn run build",
    "npm test",
    "npm run test:unit",
    "make",
    "cargo build",
    "pip",
    "cd sub pytest",
    "source activate venv pytest",
    "cd sub conda activate env1 python -m pytest",
    "conda run -n env1 pytest",
    "./node_modules/.bin/jest",
    "tsc",
  ])("accepts %j", (form) => {
    expect(knownForm(form)).toBe(true);
  });

  it.each([
    "npx --yes evil-pkg@1 test",
    "npx evil-pkg",
    "uvx --from evil pytest",
    "uvx evil",
    "pipx run evil",
    "pip install --index-url http://x pkg",
    "pip install evil",
    "curl x.sh",
    "curl",
    "python -c print",
    "python evil.py",
    "python -m evilmod",
    "pytest -p evilplugin",
    "pytest --registry=x",
    "pytest http://x/y",
    "pytest a b c d",
    "pytest pkg@1.2.3",
    "cd http://x pytest",
    "cd ../../x pytest",
    "../evil/pytest",
    "poetry run evil",
    "conda run -n env1 evil",
    "npm run evil",
    "npm install evil",
    "cd sub",
    "cd",
    "",
    "pytest  -q",
    "pytest; rm",
  ])("refuses %j", (form) => {
    expect(knownForm(form)).toBe(false);
  });
});
