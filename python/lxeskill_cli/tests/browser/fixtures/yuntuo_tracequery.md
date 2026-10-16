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
1Z16HE510305235582. The subsequently supplied getTrack JavaScript explicitly
maps jobno/refno/referenceno to labels 运单/zhuan单/参考. This confirms refno's
transfer-number role without inferring it from its format. carrier is empty;
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

The supplied getTrack calls this.$httpService.get("oms/tms/tracequery/list", n).
It accepts an already-unwrapped array, renders trace remarks and may create
placeholder rows for missing inputs. Those placeholders are client-side data,
not rows captured in the supplier response. Its empty-array handling does not
establish a real empty HTTP response or the service's unwrap/error behavior.
The supplied function contains no token/sign injection or signing algorithm;
at that stage the implementation of $httpService and its request interceptors
was still needed. The later public-bundle inspection below supplies it.

Later on 2026-10-16, the user supplied the complete public vendor URL:
https://vip.yjtms.com:11000/static/js/vendor.88f20a13bf63cefc60d8.1791808844334.js
The file was downloaded without credentials (1,546,042 bytes, SHA-256
8c1cbc4e4d94ed68544723121ba7695ad7b6d0486b0ed1718504712dcaa6132f).
Module Mj9K exports getRequestHeader(params), which uses the current native
HEADER token, fresh timestamp/nonce, and module jOZb's getSign/getToken helpers.
It also adds version/timeZone/locale and the current station ID. The adapter
reuses this native method in the browser; it does not clone the signing code
or copy authentication values into a fixture or the Python process.

The bundle's generic get() unwraps body for result_code==0 but rejects without
the original error in several branches and modifies network/HTTP messages.
The adapter therefore uses only the header builder and a fixed same-origin
fetch, projecting original status/diagnostics before returning to Python.
The bundle is static-source evidence, not a successful live Selenium call.
