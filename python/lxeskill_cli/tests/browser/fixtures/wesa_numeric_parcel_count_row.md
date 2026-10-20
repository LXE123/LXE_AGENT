This row reproduces the diagnostic supplied by the user for the Wesa query of
FBA19SS5YN6R at 2026-10-20T09:38:33Z. The observed failure was
`ValueError: Shipment field must be a string`, with numeric `parcel_count: 1`.

The row comes from the bounded, HTML-stripped error diagnostic, not a complete
raw HTTP response. It proves the reported numeric count and business field
values; it does not establish pagination, response tabs, HTTP status, delivery
status, ETA or live query success. Tests that place this row in the older
response fixture use a synthetic envelope solely for integration coverage.
