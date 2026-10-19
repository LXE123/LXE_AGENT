# TianTai shipment-list fixture

This is the bounded business projection of the successful 2026-10-19
`activeTab=all` response supplied by the user for `FBA15MPDN5VF`. It preserves
the top-level provider status, tabs, pagination, and the complete returned
business row. The original 62 KB response also contained search-form options,
column definitions, and write/print action configuration; those unrelated
configuration fields are intentionally omitted.

The sample is a German Amazon shipment in `picked` business state. It does not
contain `to_warehouse_code`, a carrier, a transfer tracking number, a final-mile
ETA, or a verified empty/failure response shape. Tests must not invent those
contracts or present this sample as US-FBA acceptance evidence.
