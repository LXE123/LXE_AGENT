# Retire the legacy logistics service

Status: `Accepted`

The legacy logistics HTTP integration is retired from both the source and desktop product lines. The
`fba logistics quote` and `fba logistics rates-import` commands, their legacy aliases, and their two
owner Skills are no longer part of the public lxeskill contract. Existing invocations fail with the
normal `unknown_command` response.

The Mabang WMS workbook lookup and column-resolution helpers remain active because shipment, customs,
and invoice workflows depend on them. They now live under `services.mabang.amazon.fba`; the obsolete
`services.amazon.amazon_logistic` and `services.agent_cli.amazon_logistic` packages are removed.

This decision does not retire LXE Agent Data Server. Session snapshots, machine identity,
`LXE_DATA_SERVER_*`, and the disabled-by-default `lxe-saihu` MCP definition remain unchanged.

The catalog now contains 26 commands and the repository contains 26 top-level runtime Skills. The
bundled Lark CLI contributes 27 nested connector manifests, so recursive runtime discovery reports 53
repository manifests. Desktop packaging compares the packaged command set with the source catalog
instead of freezing a numeric command count. Existing logistics artifacts and user-local environment
files are not migrated or deleted.
