import { assignBuilderRole } from "./assignment.js";
import { loadConfig } from "./config.js";
import { checkDiscordReadiness, DiscordClient } from "./discord.js";
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
      return jsonResponse({ status: "not_ready" }, 503);
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
      });
      return jsonResponse({ status: "not_ready" }, 503);
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

function errorResponse(code, retryable, status) {
  return jsonResponse({ ok: false, code, retryable }, status);
}

function jsonResponse(value, status, additionalHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...JSON_HEADERS, ...additionalHeaders },
  });
}
