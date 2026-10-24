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

`tiantai_shipment_row_ups.json` is the business-field projection of a second
real row supplied by the user on 2026-10-22. It contains shipment FBA15MN7QKMD,
waybill TAI10723968, three parcels, and the explicit UPS / single tracking
number / 已生成 HTML layout. Unused internal ID, fees, weights and action fields
were omitted. Tests place this row inside the earlier envelope; this does not
claim a new capture of the outer response, tabs or pagination. The U in an
input such as FBA15MN7QKMDU000001 begins the box suffix U000001. The row only
verifies shipment identity, not an individual box or official UPS status.
