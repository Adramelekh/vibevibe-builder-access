import { assignBuilderRole } from "./assignment.js";
import { loadConfig } from "./config.js";
import { checkDiscordReadiness, DiscordApiError, DiscordClient } from "./discord.js";
import { InvalidRequestError, parseAssignmentRequest } from "./schema.js";
import { verifyServiceRequest } from "./security.js";

const ASSIGN_PATH = "/internal/v1/discord/builder-role/assign";
const MAX_BODY_BYTES = 4 * 1024;
const JSON_HEADERS = Object.freeze({
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
});

export default {
  async fetch(request, environment) {
    return handleRequest(request, environment);
  },
};

export async function handleRequest(request, environment, dependencies = {}) {
  const logger = dependencies.logger || console;
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/healthz") {
    return jsonResponse({ status: "ok" }, 200);
  }

  let config;
  try {
    config = loadConfig(environment);
  } catch (error) {
    logger.error("Builder Worker configuration rejected", {
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
    if (request.method === "GET" && url.pathname === "/readyz") {
      return jsonResponse(
        { status: "not_ready", reason: "CONFIGURATION_INVALID" },
        503,
      );
    }
    return errorResponse("DISCORD_UNAVAILABLE", false, 503);
  }

  const discord = new DiscordClient({
    token: config.botToken,
    fetchImplementation: dependencies.fetchImplementation || globalThis.fetch,
    sleep: dependencies.sleep,
    random: dependencies.random,
  });

  if (request.method === "GET" && url.pathname === "/readyz") {
    try {
      const details = await checkDiscordReadiness(config, discord);
      logger.info("Discord readiness check passed", details);
      return jsonResponse({ status: "ready" }, 200);
    } catch (error) {
      logger.error("Discord readiness check failed", {
        reason: error instanceof Error ? error.message : "unknown failure",
        networkCause: safeNetworkCause(error),
      });
      return jsonResponse(
        {
          status: "not_ready",
          reason: readinessFailureCode(error),
          ...(safeNetworkCause(error) ? { diagnostic: safeNetworkCause(error) } : {}),
        },
        503,
      );
    }
  }

  if (url.pathname !== ASSIGN_PATH) {
    return jsonResponse({ ok: false, code: "NOT_FOUND" }, 404);
  }
  if (request.method !== "POST") {
    return jsonResponse(
      { ok: false, code: "METHOD_NOT_ALLOWED" },
      405,
      { Allow: "POST" },
    );
  }

  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return errorResponse("INVALID_REQUEST", false, 400);
  }

  let rawBody;
  try {
    rawBody = new Uint8Array(await request.arrayBuffer());
  } catch {
    return errorResponse("INVALID_REQUEST", false, 400);
  }
  if (rawBody.byteLength > MAX_BODY_BYTES) {
    return errorResponse("INVALID_REQUEST", false, 400);
  }

  let authenticated = false;
  try {
    authenticated = await verifyServiceRequest({
      rawBody,
      timestampHeader: request.headers.get("x-vv-timestamp"),
      signatureHeader: request.headers.get("x-vv-signature"),
      secret: config.hmacSecret,
      nowSeconds: dependencies.nowSeconds?.(),
      cryptoImplementation: dependencies.cryptoImplementation || globalThis.crypto,
    });
  } catch {
    authenticated = false;
  }
  if (!authenticated) {
    logger.warn("Builder Worker service authentication rejected");
    return errorResponse("UNAUTHENTICATED_CALLER", false, 401);
  }

  const contentType = request.headers.get("content-type");
  if (!contentType?.toLowerCase().startsWith("application/json")) {
    return errorResponse("INVALID_REQUEST", false, 400);
  }

  let assignmentRequest;
  try {
    assignmentRequest = parseAssignmentRequest(new TextDecoder().decode(rawBody));
  } catch (error) {
    if (error instanceof InvalidRequestError) {
      return errorResponse("INVALID_REQUEST", false, 400);
    }
    throw error;
  }

  let result;
  try {
    result = await assignBuilderRole(config, discord, assignmentRequest);
  } catch (error) {
    logger.error("Unhandled Builder assignment failure", {
      requestId: assignmentRequest.requestId,
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
    result = { ok: false, code: "DISCORD_UNAVAILABLE", retryable: true };
  }

  logger.info("Builder assignment request completed", {
    requestId: assignmentRequest.requestId,
    result: result.ok ? result.status : result.code,
  });
  if (result.ok) return jsonResponse(result, 200);
  return jsonResponse(result, statusForCode(result.code));
}

function statusForCode(code) {
  switch (code) {
    case "NOT_MEMBER":
    case "MEMBERSHIP_PENDING":
    case "NOT_VERIFIED":
      return 422;
    case "BOT_ROLE_TOO_LOW":
      return 403;
    default:
      return 503;
  }
}

function readinessFailureCode(error) {
  if (error instanceof DiscordApiError) {
    if (error.status === 401) return "DISCORD_AUTHENTICATION_FAILED";
    if (error.status === 403) return "DISCORD_ACCESS_DENIED";
    if (error.status === 0) return "DISCORD_NETWORK_FAILED";
    if (error.status === 429) return "DISCORD_RATE_LIMITED";
    if (error.status >= 500) return `DISCORD_UPSTREAM_${error.status}`;
    return `DISCORD_HTTP_${error.status}`;
  }

  const reasonByMessage = {
    "Discord bot identity could not be resolved": "BOT_IDENTITY_INVALID",
    "Discord bot token does not belong to the configured application": "BOT_IDENTITY_MISMATCH",
    "Configured Discord guild could not be resolved": "GUILD_MISMATCH",
    "Discord guild roles could not be resolved": "ROLE_LIST_INVALID",
    "Bot is not a member of the configured guild": "BOT_NOT_IN_GUILD",
    "Configured Discord roles could not all be resolved": "CONFIGURED_ROLE_MISSING",
    "Builder role must not be integration-managed": "TARGET_ROLE_MANAGED",
    "Bot must not have Administrator": "ADMINISTRATOR_PRESENT",
    "Bot lacks Manage Roles": "MANAGE_ROLES_MISSING",
    "Bot's highest role must be above Builder": "TARGET_ROLE_TOO_HIGH",
  };
  return reasonByMessage[error instanceof Error ? error.message : ""] || "READINESS_CHECK_FAILED";
}

function safeNetworkCause(error) {
  if (!(error instanceof DiscordApiError) || error.status !== 0) return "";
  const cause = error.cause;
  if (!(cause instanceof Error)) return "UNKNOWN_NETWORK_ERROR";
  const message = String(cause.message || "").toLowerCase();
  if (message.includes("invalid header")) return "INVALID_REQUEST_HEADER";
  if (message.includes("network connection lost")) return "NETWORK_CONNECTION_LOST";
  if (message.includes("fetch failed")) return "FETCH_FAILED";
  if (message.includes("subrequest")) return "SUBREQUEST_REJECTED";
  if (message.includes("cannot perform i/o")) return "REQUEST_CONTEXT_ERROR";
  const sanitizedMessage = message
    .replace(/https?:\/\/[^\s]+/g, "URL")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
  return `UNCLASSIFIED_${cause.name || "ERROR"}_${sanitizedMessage || "NO_MESSAGE"}`
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_");
}

function errorResponse(code, retryable, status) {
  return jsonResponse({ ok: false, code, retryable }, status);
}

function jsonResponse(value, status, additionalHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...JSON_HEADERS, ...additionalHeaders },
  });
}
