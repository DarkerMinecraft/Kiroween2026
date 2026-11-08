/**
 * SignalWire REST client wrapper.
 *
 * Wraps the SignalWire REST Phone Numbers Inventory API (search, purchase,
 * configure inbound handler, release) used to provision and tear down a
 * Protection_Number (Req 4.1, 4.5, 4.7, 4.8).
 *
 * All calls authenticate with HTTP Basic auth built from
 * `SIGNALWIRE_PROJECT_ID` (username) and `SIGNALWIRE_API_TOKEN` (password),
 * against the space at `SIGNALWIRE_SPACE_URL`. These are read from the
 * environment at call time and are never hardcoded. Every failure — missing
 * configuration, network error, or non-2xx response — surfaces as a typed
 * {@link TelephonyError} so the provisioning action can report failure without
 * leaving partial state (Req 4.6, 4.8).
 *
 * NOTE: SWML document builders live in task 5.2 and are intentionally kept out
 * of this module to avoid collision; this file holds only the REST wrapper.
 */

/**
 * Error thrown by every SignalWire REST wrapper function on failure.
 *
 * Carries the originating operation and, where a response was received, the
 * HTTP status so callers can distinguish provider errors from transport
 * failures. The underlying cause (if any) is preserved on `cause`.
 */
export class TelephonyError extends Error {
  /** The wrapper operation that failed (e.g. `"purchaseNumber"`). */
  readonly operation: string;
  /** HTTP status code when a response was received, otherwise `undefined`. */
  readonly status?: number;

  constructor(
    operation: string,
    message: string,
    options?: { status?: number; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "TelephonyError";
    this.operation = operation;
    this.status = options?.status;
  }
}

/** A purchasable number returned by {@link searchAvailable}. */
export interface AvailableNumber {
  /** The candidate number in E.164 format. */
  e164: string;
}

/** Parameters for {@link purchaseNumber}. */
export interface PurchaseNumberParams {
  /** Area code to purchase a local number within. */
  areaCode: string;
}

/** A provisioned number returned by {@link purchaseNumber}. */
export interface PurchasedNumber {
  /** The purchased number in E.164 format. */
  e164: string;
  /** The SignalWire phone number resource id. */
  signalwireId: string;
}

/**
 * Resolved SignalWire REST configuration read from the environment.
 */
interface SignalWireConfig {
  projectId: string;
  apiToken: string;
  baseUrl: string;
}

/**
 * Reads and validates SignalWire REST credentials from the environment.
 *
 * Normalizes `SIGNALWIRE_SPACE_URL` into an `https://<space>` base URL,
 * accepting either a bare space host (`example.signalwire.com`) or a full URL.
 * Throws a {@link TelephonyError} when any required variable is absent so no
 * request is attempted with incomplete configuration.
 */
const resolveConfig = (operation: string): SignalWireConfig => {
  const projectId = process.env.SIGNALWIRE_PROJECT_ID;
  const apiToken = process.env.SIGNALWIRE_API_TOKEN;
  const spaceUrl = process.env.SIGNALWIRE_SPACE_URL;

  const missing = [
    ["SIGNALWIRE_PROJECT_ID", projectId],
    ["SIGNALWIRE_API_TOKEN", apiToken],
    ["SIGNALWIRE_SPACE_URL", spaceUrl],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new TelephonyError(
      operation,
      `Missing SignalWire configuration: ${missing.join(", ")}`,
    );
  }

  const trimmed = (spaceUrl as string).trim().replace(/\/+$/, "");
  const baseUrl = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  return {
    projectId: projectId as string,
    apiToken: apiToken as string,
    baseUrl,
  };
};

/** Builds the HTTP Basic `Authorization` header value from credentials. */
const basicAuthHeader = (projectId: string, apiToken: string): string => {
  const encoded = Buffer.from(`${projectId}:${apiToken}`).toString("base64");
  return `Basic ${encoded}`;
};

/**
 * Performs an authenticated request against the SignalWire REST API.
 *
 * Returns the parsed JSON body (or `undefined` for empty `204` responses).
 * Any transport failure or non-2xx status is wrapped in a {@link TelephonyError}
 * tagged with the calling `operation`.
 */
const signalwireFetch = async (
  operation: string,
  config: SignalWireConfig,
  path: string,
  init: { method: string; body?: unknown } = { method: "GET" },
): Promise<unknown> => {
  const headers: Record<string, string> = {
    Authorization: basicAuthHeader(config.projectId, config.apiToken),
    Accept: "application/json",
  };

  const requestInit: RequestInit = { method: init.method, headers };

  if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
    requestInit.body = JSON.stringify(init.body);
  }

  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}${path}`, requestInit);
  } catch (cause) {
    throw new TelephonyError(
      operation,
      `SignalWire request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new TelephonyError(
      operation,
      `SignalWire responded with ${response.status}${detail ? `: ${detail}` : ""}`,
      { status: response.status },
    );
  }

  if (response.status === 204) return undefined;

  const text = await response.text().catch(() => "");
  if (!text) return undefined;

  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new TelephonyError(operation, "SignalWire returned an unparseable response body", {
      status: response.status,
      cause,
    });
  }
};

/**
 * Searches SignalWire's inventory for a purchasable local number.
 *
 * `region` is matched as an ISO 3166-2 alpha-2 state/region code (for example
 * `"TX"`). Returns the first purchasable candidate. Throws a
 * {@link TelephonyError} when the search fails or returns no candidates.
 */
export const searchAvailable = async (region: string): Promise<AvailableNumber> => {
  const operation = "searchAvailable";
  const config = resolveConfig(operation);

  const query = new URLSearchParams({ region, max_results: "1" });
  const body = (await signalwireFetch(
    operation,
    config,
    `/api/relay/rest/phone_numbers/search?${query.toString()}`,
  )) as { data?: Array<{ e164?: string; number?: string }> } | null;

  const first = body?.data?.[0];
  const e164 = first?.e164 ?? first?.number;

  if (!e164) {
    throw new TelephonyError(operation, `No purchasable numbers found for region ${region}`);
  }

  return { e164 };
};

/**
 * Purchases a local number in the given area code.
 *
 * Searches the inventory by `areaCode`, then purchases the first candidate.
 * Returns the purchased number in E.164 form and the SignalWire resource id
 * (Req 4.1). Throws a {@link TelephonyError} on search, availability, or
 * purchase failure.
 */
export const purchaseNumber = async ({
  areaCode,
}: PurchaseNumberParams): Promise<PurchasedNumber> => {
  const operation = "purchaseNumber";
  const config = resolveConfig(operation);

  const query = new URLSearchParams({ areacode: areaCode, max_results: "1" });
  const searchBody = (await signalwireFetch(
    operation,
    config,
    `/api/relay/rest/phone_numbers/search?${query.toString()}`,
  )) as { data?: Array<{ e164?: string; number?: string }> } | null;

  const candidate = searchBody?.data?.[0];
  const number = candidate?.e164 ?? candidate?.number;

  if (!number) {
    throw new TelephonyError(
      operation,
      `No purchasable numbers found for area code ${areaCode}`,
    );
  }

  const purchased = (await signalwireFetch(operation, config, "/api/relay/rest/phone_numbers", {
    method: "POST",
    body: { number },
  })) as { id?: string; number?: string } | null;

  if (!purchased?.id || !purchased.number) {
    throw new TelephonyError(operation, "SignalWire purchase response was missing id or number");
  }

  return { e164: purchased.number, signalwireId: purchased.id };
};

/**
 * Points a purchased number's inbound voice handler at the Mabel SWML endpoint.
 *
 * Configures the number to POST inbound calls to `swmlUrl` so SignalWire routes
 * them to the application's call-handling route (Req 4.5). Throws a
 * {@link TelephonyError} on failure.
 */
export const configureInboundHandler = async (
  numberId: string,
  swmlUrl: string,
): Promise<void> => {
  const operation = "configureInboundHandler";
  const config = resolveConfig(operation);

  await signalwireFetch(operation, config, `/api/relay/rest/phone_numbers/${numberId}`, {
    method: "PUT",
    body: {
      call_handler: "laml_webhooks",
      call_receive_mode: "voice",
      call_request_url: swmlUrl,
      call_request_method: "POST",
    },
  });
};

/**
 * Releases a project-owned number back to SignalWire by resource id (Req 4.7).
 *
 * Throws a {@link TelephonyError} on failure so the caller can keep the number
 * marked active and report a release failure (Req 4.8).
 */
export const releaseNumber = async (numberId: string): Promise<void> => {
  const operation = "releaseNumber";
  const config = resolveConfig(operation);

  await signalwireFetch(operation, config, `/api/relay/rest/phone_numbers/${numberId}`, {
    method: "DELETE",
  });
};
