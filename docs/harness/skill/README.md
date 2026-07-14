# Skill Documentation

Status: `Current`

Runtime skill prompts live in repository `skills/*/SKILL.md` and optional user skills under `~/.agents/skills`. This directory explains discovery and classification; it does not duplicate full runtime prompts.

## Discovery And Precedence

`packages/agent/runtime/src/tooling/skills.ts` scans both roots and parses skill front matter. Repository skills win when the same skill name also exists in the user root. Duplicate names or commands within one source are rejected instead of being resolved by filesystem order.

The catalog validates that referenced files:

- use relative paths;
- exist beneath the declared skill root;
- remain beneath the real root after symlink resolution;
- cannot escape through `..` or a linked path.

The catalog signature includes file size and modification metadata so runtime can refresh when skill files change.

## Visibility And Activation

Discovery is not the same as model activation.

1. Runtime discovers and validates the catalog.
2. Permission policy filters skills by the current agent's allowed skill types.
3. Connector state can hide optional connector-owned skills.
4. The prompt receives compact metadata for only the available skills.
5. The model reads a skill's `SKILL.md` when it chooses that workflow.
6. Tool ownership from the activated skill becomes available on the next step.

This keeps the base prompt bounded while preserving detailed workflow contracts on demand.

## Script Tools

Business skills use registered script tools from `python/lxeskill_cli/lxeskill/catalog.json`. Catalog protocol version 1 records the tool name, schema, handler/module, owner skills, timeout, and exposure policy.

Runtime skills must invoke their owned tools through the tool registry. They must not instruct the model to shell out directly to internal command modules. This boundary keeps validation, cancellation, JSON protocol handling, logging, and permission checks centralized.

## Usage Tracking

Runtime records which skills were activated and used during a turn. This supports diagnostics and Dashboard visibility without copying complete skill text into logs or persisted usage records.

## Documentation Classes

- [Current skill catalog](current_skill_catalog.md): active repository skill inventory and categories.
- [Archive](archive/README.md): historical workflows, recordings, and superseded implementation notes.
- [Reference](reference/README.md): external platform or vendor material.

Archive and reference files are not runtime prompts unless a current `SKILL.md` explicitly links to them. Historical credentials, selectors, and examples must be sanitized before retention.

## Maintenance Checklist

When adding or renaming a skill:

1. keep `name`, `type`, description, and allowed tools precise;
2. make all references relative and contained inside the skill root;
3. register any script tool with explicit ownership and schema;
4. update workflow-map routing when the user intent changes;
5. update catalog/count tests and this inventory if categories change;
6. test permission and connector filtering where applicable;
7. avoid copying the full prompt into `docs/`.
