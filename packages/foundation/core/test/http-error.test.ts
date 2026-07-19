import { describe, expect, test } from "bun:test";
import { inspectHttpError } from "../src/http-error";

describe("inspectHttpError", () => {
  test("extracts a positive HTTP status and preserves provider response data", () => {
    const error = Object.assign(new Error("request failed"), {
      response: { status: 400, data: { code: 123, msg: "bad input" } },
    });
    expect(inspectHttpError(error)).toEqual({
      message: "request failed",
      httpStatus: 400,
      responseData: { code: 123, msg: "bad input" },
    });
  });

  test("handles non-HTTP thrown values without inventing a status", () => {
    expect(inspectHttpError("offline")).toEqual({
      message: "offline",
      responseData: {},
    });
  });
});
