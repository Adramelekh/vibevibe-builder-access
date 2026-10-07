import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { assignBuilderRole } from "../src/assignment.js";
import { loadConfig } from "../src/config.js";
import { checkDiscordReadiness, DiscordApiError } from "../src/discord.js";
import { parseAssignmentRequest } from "../src/schema.js";
import { verifyServiceRequest } from "../src/security.js";
import { handleRequest } from "../src/worker.js";

globalThis.crypto = webcrypto;

const tests = [];
const TEST_SECRET = "test-secret-with-at-least-thirty-two-bytes";
const REQUEST_ID = "4bd69619-70c2-4c82-a917-b6b79fa7f401";
const NOW_SECONDS = 1791367200;

function test(name, run) {
  tests.push({ name, run });
}

test("configuration rejects unsafe role and secret values", () => {
  assert.throws(
    () => loadConfig(baseEnvironment({ DISCORD_VERIFIED_ROLE_ID: "2" })),
    /must differ/,
  );
  assert.throws(
    () => loadConfig(baseEnvironment({ WEBSITE_SERVICE_HMAC_SECRET: "short" })),
    /at least 32 bytes/,
  );
});

test("HMAC covers the timestamp and exact raw body", async () => {
  const rawBody = new TextEncoder().encode('{"requestId":"x"}');
  const timestamp = String(NOW_SECONDS);
  const signature = await sign(rawBody, timestamp);

  assert.equal(
    await verifyServiceRequest({
      rawBody,
      timestampHeader: timestamp,
      signatureHeader: signature,
      secret: TEST_SECRET,
      nowSeconds: NOW_SECONDS,
      cryptoImplementation: webcrypto,
    }),
    true,
  );
  assert.equal(
    await verifyServiceRequest({
      rawBody: new TextEncoder().encode('{ "requestId":"x"}'),
      timestampHeader: timestamp,
      signatureHeader: signature,
      secret: TEST_SECRET,
      nowSeconds: NOW_SECONDS,
      cryptoImplementation: webcrypto,
    }),
    false,
  );
  assert.equal(
    await verifyServiceRequest({
      rawBody,
      timestampHeader: timestamp,
      signatureHeader: signature,
      secret: TEST_SECRET,
      nowSeconds: NOW_SECONDS + 301,
      cryptoImplementation: webcrypto,
    }),
    false,
  );
});

test("assignment schema accepts only the two contract fields", () => {
  assert.deepEqual(
    parseAssignmentRequest(JSON.stringify(assignmentRequest())),
    assignmentRequest(),
  );
  assert.throws(
    () => parseAssignmentRequest(JSON.stringify({ ...assignmentRequest(), roleId: "999" })),
    /exactly/,
  );
});

test("assignment maps Discord membership and verification states", async () => {
  const config = serviceConfig();
  assert.deepEqual(
    await assignBuilderRole(config, fakeDiscord({ member: null }), assignmentRequest()),
    { ok: false, code: "NOT_MEMBER", retryable: true },
  );
  assert.deepEqual(
    await assignBuilderRole(
      config,
      fakeDiscord({ member: { pending: true, roles: [] } }),
      assignmentRequest(),
    ),
    { ok: false, code: "MEMBERSHIP_PENDING", retryable: true },
  );
  assert.deepEqual(
    await assignBuilderRole(
      config,
      fakeDiscord({ member: { pending: false, roles: [] } }),
      assignmentRequest(),
    ),
    { ok: false, code: "NOT_VERIFIED", retryable: true },
  );
});

test("an existing Builder role succeeds without writing", async () => {
  let addCalls = 0;
  const result = await assignBuilderRole(
    serviceConfig(),
    fakeDiscord({
      member: { pending: false, roles: ["3", "2"] },
      onAdd: () => {
        addCalls += 1;
      },
    }),
    assignmentRequest(),
  );
  assert.equal(result.ok, true);
  assert.equal(result.status, "ALREADY_ASSIGNED");
  assert.equal(typeof result.confirmedAt, "string");
  assert.equal("assignedAt" in result, false);
  assert.equal(addCalls, 0);
});

test("an eligible member receives and confirms Builder", async () => {
  let member = { pending: false, roles: ["3"] };
  let auditReason;
  const discord = {
    async getGuildMember() {
      return member;
    },
    async addGuildMemberRole(_guildId, _userId, roleId, reason) {
      member = { ...member, roles: [...member.roles, roleId] };
      auditReason = reason;
    },
  };
  const result = await assignBuilderRole(serviceConfig(), discord, assignmentRequest());
  assert.equal(result.ok, true);
  assert.equal(result.status, "ASSIGNED");
  assert.equal(typeof result.assignedAt, "string");
  assert.match(auditReason, new RegExp(REQUEST_ID));
});

test("Discord 403 during role write maps to BOT_ROLE_TOO_LOW", async () => {
  const discord = fakeDiscord({
    member: { pending: false, roles: ["3"] },
    onAdd: () => {
      throw new DiscordApiError(403, "forbidden");
    },
  });
  assert.deepEqual(
    await assignBuilderRole(serviceConfig(), discord, assignmentRequest()),
    { ok: false, code: "BOT_ROLE_TOO_LOW", retryable: false },
  );
});

test("readiness requires Manage Roles without Administrator and a higher bot role", async () => {
  const config = serviceConfig();
  const details = await checkDiscordReadiness(
    config,
    readinessDiscord({ botPermissions: String(1n << 28n), botPosition: 3 }),
  );
  assert.equal(details.builderRoleName, "Builder");

  await assert.rejects(
    checkDiscordReadiness(
      config,
      readinessDiscord({ botPermissions: String((1n << 28n) | (1n << 3n)), botPosition: 3 }),
    ),
    /must not have Administrator/,
  );
  await assert.rejects(
    checkDiscordReadiness(
      config,
      readinessDiscord({ botPermissions: String(1n << 28n), botPosition: 1 }),
    ),
    /must be above Builder/,
  );
});

test("Worker rejects missing authentication before contacting Discord", async () => {
  let discordCalls = 0;
  const response = await handleRequest(
    assignmentHttpRequest(assignmentBody()),
    baseEnvironment(),
    workerDependencies(async () => {
      discordCalls += 1;
      return new Response("{}", { status: 500 });
    }),
  );
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, "UNAUTHENTICATED_CALLER");
  assert.equal(discordCalls, 0);
});

test("Worker validates schema and returns the stable result", async () => {
  const invalidBody = JSON.stringify({ ...assignmentRequest(), roleId: "999" });
  const invalid = await handleRequest(
    assignmentHttpRequest(invalidBody, await signedHeaders(invalidBody)),
    baseEnvironment(),
    workerDependencies(notMemberFetch),
  );
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).code, "INVALID_REQUEST");

  const validBody = assignmentBody();
  const valid = await handleRequest(
    assignmentHttpRequest(validBody, await signedHeaders(validBody)),
    baseEnvironment(),
    workerDependencies(notMemberFetch),
  );
  assert.equal(valid.status, 422);
  assert.deepEqual(await valid.json(), {
    ok: false,
    code: "NOT_MEMBER",
    retryable: true,
  });
});

test("Worker readiness exposes only a stable non-sensitive failure code", async () => {
  const response = await handleRequest(
    new Request("https://builder.example/readyz"),
    baseEnvironment(),
    workerDependencies(async () => new Response("unauthorized", { status: 401 })),
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    status: "not_ready",
    reason: "DISCORD_AUTHENTICATION_FAILED",
  });
});

let failures = 0;
for (const { name, run } of tests) {
  try {
    await run();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`not ok - ${name}`);
    console.error(error);
  }
}

if (failures > 0) process.exitCode = 1;
else console.log(`\n${tests.length} tests passed`);

function baseEnvironment(overrides = {}) {
  return {
    DISCORD_APPLICATION_ID: "5",
    DISCORD_BOT_TOKEN: "test-token",
    DISCORD_GUILD_ID: "1",
    DISCORD_BUILDER_ROLE_ID: "2",
    DISCORD_VERIFIED_ROLE_ID: "3",
    WEBSITE_SERVICE_HMAC_SECRET: TEST_SECRET,
    ...overrides,
  };
}

function serviceConfig() {
  return loadConfig(baseEnvironment());
}

function assignmentRequest() {
  return { requestId: REQUEST_ID, discordUserId: "123" };
}

function assignmentBody() {
  return JSON.stringify(assignmentRequest());
}

async function sign(rawBody, timestamp) {
  const encoder = new TextEncoder();
  const bytes = typeof rawBody === "string" ? encoder.encode(rawBody) : rawBody;
  const prefix = encoder.encode(`${timestamp}.`);
  const message = new Uint8Array(prefix.byteLength + bytes.byteLength);
  message.set(prefix);
  message.set(bytes, prefix.byteLength);
  const key = await webcrypto.subtle.importKey(
    "raw",
    encoder.encode(TEST_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await webcrypto.subtle.sign("HMAC", key, message));
  return `sha256=${Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function signedHeaders(body) {
  const timestamp = String(NOW_SECONDS);
  return {
    "Content-Type": "application/json",
    "X-VV-Timestamp": timestamp,
    "X-VV-Signature": await sign(body, timestamp),
  };
}

function assignmentHttpRequest(body, headers = {}) {
  return new Request("https://builder.example/internal/v1/discord/builder-role/assign", {
    method: "POST",
    headers,
    body,
  });
}

function workerDependencies(fetchImplementation) {
  return {
    fetchImplementation,
    nowSeconds: () => NOW_SECONDS,
    cryptoImplementation: webcrypto,
    sleep: async () => {},
    random: () => 0,
    logger: { info() {}, warn() {}, error() {} },
  };
}

async function notMemberFetch(url) {
  assert.match(String(url), /\/guilds\/1\/members\/123$/);
  return new Response(JSON.stringify({ message: "Unknown Member" }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
}

function fakeDiscord({ member, onGet, onAdd } = {}) {
  return {
    async getGuildMember() {
      onGet?.();
      return member;
    },
    async addGuildMemberRole(...args) {
      return onAdd?.(...args);
    },
  };
}

function readinessDiscord({ botPermissions, botPosition }) {
  const roles = [
    { id: "1", name: "@everyone", position: 0, permissions: "0", managed: false },
    { id: "2", name: "Builder", position: 2, permissions: "0", managed: false },
    { id: "3", name: "Verified", position: 1, permissions: "0", managed: false },
    { id: "4", name: "Builder Access", position: botPosition, permissions: botPermissions, managed: false },
  ];
  return {
    async getCurrentUser() {
      return { id: "5" };
    },
    async getGuild() {
      return { id: "1", name: "vibe/vibe builders" };
    },
    async getGuildRoles() {
      return roles;
    },
    async getGuildMember() {
      return { roles: ["4"] };
    },
  };
}
