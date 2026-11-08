import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureInboundHandler,
  purchaseNumber,
  releaseNumber,
  searchAvailable,
  TelephonyError,
} from "./signalwire";

// Unit tests for the SignalWire REST wrapper (task 5.1 / 5.3). The wrapper talks
// to the SignalWire REST API through the global `fetch` using Basic auth built
// from env vars, so these tests stub `fetch` and the three required env vars and
// assert both the success paths and the typed-error paths.
// Validates: Requirements 4.1, 4.5, 4.7, 4.8

const PROJECT_ID = "proj-test-123";
const API_TOKEN = "tok-test-456";
const SPACE_URL = "example.signalwire.com";

/** Expected Basic auth header for the stubbed credentials. */
const expectedAuthHeader = `Basic ${Buffer.from(`${PROJECT_ID}:${API_TOKEN}`).toString("base64")}`;

/**
 * Builds a minimal `Response`-like object good enough for the wrapper, which
 * only reads `ok`, `status`, `text()`, and (for 204) short-circuits the body.
 */
const jsonResponse = (status: number, body: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  }) as unknown as Response;

/** Builds a non-2xx error response carrying a plain-text detail body. */
const errorResponse = (status: number, detail = ""): Response =>
  ({
    ok: false,
    status,
    text: async () => detail,
  }) as unknown as Response;

/** The current `fetch` mock, reset before each test. */
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv("SIGNALWIRE_PROJECT_ID", PROJECT_ID);
  vi.stubEnv("SIGNALWIRE_API_TOKEN", API_TOKEN);
  vi.stubEnv("SIGNALWIRE_SPACE_URL", SPACE_URL);

  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("searchAvailable", () => {
  it("returns the first purchasable candidate on an ok response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: [{ e164: "+15125550100" }] }));

    const result = await searchAvailable("TX");

    expect(result).toEqual({ e164: "+15125550100" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://example.signalwire.com/api/relay/rest/phone_numbers/search?region=TX&max_results=1",
    );
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe(expectedAuthHeader);
  });

  it("falls back to the `number` field when `e164` is absent", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: [{ number: "+15125550101" }] }));

    const result = await searchAvailable("TX");

    expect(result).toEqual({ e164: "+15125550101" });
  });

  it("throws a TelephonyError when no candidates are returned", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: [] }));

    await expect(searchAvailable("TX")).rejects.toMatchObject({
      name: "TelephonyError",
      operation: "searchAvailable",
    });
  });

  it("throws a typed TelephonyError carrying the HTTP status on a non-ok response", async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(502, "bad gateway"));

    await expect(searchAvailable("TX")).rejects.toMatchObject({
      name: "TelephonyError",
      operation: "searchAvailable",
      status: 502,
    });
  });
});

describe("purchaseNumber", () => {
  it("searches by area code then purchases the first candidate (Req 4.1)", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ e164: "+15125550123" }] }))
      .mockResolvedValueOnce(jsonResponse(201, { id: "pn-abc", number: "+15125550123" }));

    const result = await purchaseNumber({ areaCode: "512" });

    expect(result).toEqual({ e164: "+15125550123", signalwireId: "pn-abc" });

    const [searchUrl] = fetchMock.mock.calls[0];
    expect(searchUrl).toBe(
      "https://example.signalwire.com/api/relay/rest/phone_numbers/search?areacode=512&max_results=1",
    );

    const [purchaseUrl, purchaseInit] = fetchMock.mock.calls[1];
    expect(purchaseUrl).toBe("https://example.signalwire.com/api/relay/rest/phone_numbers");
    expect(purchaseInit.method).toBe("POST");
    expect(purchaseInit.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(purchaseInit.body)).toEqual({ number: "+15125550123" });
  });

  it("throws a TelephonyError when the area-code search yields no candidate", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: [] }));

    await expect(purchaseNumber({ areaCode: "512" })).rejects.toMatchObject({
      name: "TelephonyError",
      operation: "purchaseNumber",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws a TelephonyError when the purchase response is missing id or number", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ e164: "+15125550123" }] }))
      .mockResolvedValueOnce(jsonResponse(201, { id: "pn-abc" }));

    await expect(purchaseNumber({ areaCode: "512" })).rejects.toMatchObject({
      name: "TelephonyError",
      operation: "purchaseNumber",
    });
  });

  it("throws a typed TelephonyError with status when the purchase call fails (Req 4.8)", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ e164: "+15125550123" }] }))
      .mockResolvedValueOnce(errorResponse(422, "unprocessable"));

    await expect(purchaseNumber({ areaCode: "512" })).rejects.toMatchObject({
      name: "TelephonyError",
      operation: "purchaseNumber",
      status: 422,
    });
  });
});

describe("configureInboundHandler", () => {
  it("PUTs the SWML webhook configuration for the number (Req 4.5)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: "pn-abc" }));

    await expect(
      configureInboundHandler("pn-abc", "https://mabel.example.com/api/telephony/inbound"),
    ).resolves.toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://example.signalwire.com/api/relay/rest/phone_numbers/pn-abc");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({
      call_handler: "laml_webhooks",
      call_receive_mode: "voice",
      call_request_url: "https://mabel.example.com/api/telephony/inbound",
      call_request_method: "POST",
    });
  });

  it("throws a typed TelephonyError on a non-ok response", async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(404, "not found"));

    await expect(configureInboundHandler("pn-missing", "https://x.example/cb")).rejects.toMatchObject(
      {
        name: "TelephonyError",
        operation: "configureInboundHandler",
        status: 404,
      },
    );
  });
});

describe("releaseNumber", () => {
  it("DELETEs the number resource and resolves on a 204 (Req 4.7)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(204, undefined));

    await expect(releaseNumber("pn-abc")).resolves.toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://example.signalwire.com/api/relay/rest/phone_numbers/pn-abc");
    expect(init.method).toBe("DELETE");
  });

  it("throws a typed TelephonyError on a failed release so the caller keeps the number active (Req 4.8)", async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(500, "server error"));

    await expect(releaseNumber("pn-abc")).rejects.toMatchObject({
      name: "TelephonyError",
      operation: "releaseNumber",
      status: 500,
    });
  });

  it("wraps a transport-level fetch rejection in a TelephonyError without a status", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));

    const error = await releaseNumber("pn-abc").catch((caught) => caught);

    expect(error).toBeInstanceOf(TelephonyError);
    expect(error.operation).toBe("releaseNumber");
    expect(error.status).toBeUndefined();
    expect(error.cause).toBeInstanceOf(Error);
  });
});

describe("missing configuration", () => {
  it("throws a TelephonyError before any request when an env var is absent", async () => {
    vi.stubEnv("SIGNALWIRE_API_TOKEN", "");

    await expect(searchAvailable("TX")).rejects.toMatchObject({
      name: "TelephonyError",
      operation: "searchAvailable",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
