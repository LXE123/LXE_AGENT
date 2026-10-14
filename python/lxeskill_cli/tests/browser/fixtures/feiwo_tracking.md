User-supplied real Feiwo response captured on 2026-10-14:

GET http://feichi.nextsls.com/tracking/app?inajax=1&tracking_number=FBA191GB5WTM
HTTP 200, query parameters inajax=1 and tracking_number=FBA191GB5WTM.

The fixture preserves the supplied fields and all 14 traces. Only the pasted
Markdown escape before `*` and the trailing backslash outside the JSON were
removed to make valid JSON; slash escapes in trace text were retained. This is
not a byte-for-byte network capture. No Cookie, token or request headers were
provided. The DevTools remote address 127.0.0.1:12334 is not the provider origin
and is not used in code.

This is a delivered 2025 shipment, not an in-transit/ETA or automated live test.
No warehouse code, final-delivery ETA, account identity or timezone appears in
the response. An arrival trace is timestamped after the delivery trace; preserve
both as supplied, without treating the first trace as delivery or correcting
their chronology. Empty-result and failure contracts have not been captured.
