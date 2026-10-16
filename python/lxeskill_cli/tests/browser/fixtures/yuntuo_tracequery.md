User-supplied real Yuntuo query evidence captured on 2026-10-16:

GET https://vip.yjtms.com:11000/tms-saas-oms/oms/tms/tracequery/list?noList=FBA19P9T04B2&queryType=99
HTTP 200. noList and queryType are URL query parameters, not a POST body.
The observed page is /customer/trackquery/?jobno=FBA19P9T04B2 on that origin.
The DevTools remote address 127.0.0.1:33745 is not the supplier origin.

The fixture is a minimal projection, not a byte-for-byte network capture.
It retains the response status/diagnostics, all six shipment string fields,
and all 20 traces in their supplied order. Trace scanTime, scanDatetime,
scanStatus, scanCode, scanStation (when present), ctrStation, remark and isshow
are preserved. Employee names, createDatetime, attachment URLs, modifyVersion,
shipPodKey and shipPodUrl are omitted. No attachment URLs are fetched.

referenceno exactly matches the FBA; jobno is 999260910003548 and refno is
1Z16HE510305235582. The meaning of refno as a tail-carrier tracking number
has not yet been corroborated by a page field label. carrier is empty;
neither the 1Z format nor UPS mentions in trace remarks confirm this field.
No warehouse code, parcel count, final-delivery ETA, account identity or
timezone is provided. The remark containing ETA refers to the destination
port LONG BEACH, not delivery to an Amazon warehouse. Preserve dates as given.

The user screenshot shows response headers listing allowed custom headers.
That is not evidence of the headers actually sent. The user subsequently
supplied Request Headers confirming token (value removed), sign,
hyecurrentstatid, locale, timezone and version. No credential or signature
values are stored here. Their derivation and same-origin request replay remain
unverified; the request timezone is not proof of trace/destination timezone.
No Cookie/token/Authorization values were supplied or are expected in fixtures. Empty-result,
failure, other-FBA and multi-row cases in tests are synthetic robustness cases,
not additional real supplier contracts or live automation evidence.
