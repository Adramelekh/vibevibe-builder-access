const DISCORD_API_BASE = "https://discord.com/api/v10";
const MANAGE_ROLES = 1n << 28n;
const ADMINISTRATOR = 1n << 3n;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export class DiscordClient {
  constructor({
    token,
    fetchImplementation = globalThis.fetch,
    sleep = defaultSleep,
    random = Math.random,
  }) {
    this.token = token;
    this.fetchImplementation = fetchImplementation;
    this.sleep = sleep;
    this.random = random;
  }

  async getCurrentUser() {
    return this.requestJson("GET", "/users/@me");
  }

  async getGuild(guildId) {
    return this.requestJson("GET", `/guilds/${guildId}`);
  }

  async getGuildRoles(guildId) {
    return this.requestJson("GET", `/guilds/${guildId}/roles`);
  }

  async getGuildMember(guildId, userId) {
    try {
      return await this.requestJson("GET", `/guilds/${guildId}/members/${userId}`);
    } catch (error) {
      if (error instanceof DiscordApiError && error.status === 404) return null;
      throw error;
    }
  }

  async addGuildMemberRole(guildId, userId, roleId, auditReason) {
    await this.request(
      "PUT",
      `/guilds/${guildId}/members/${userId}/roles/${roleId}`,
      { "X-Audit-Log-Reason": encodeURIComponent(auditReason) },
    );
  }

  async requestJson(method, path) {
    const response = await this.request(method, path);
    try {
      return JSON.parse(new TextDecoder().decode(response.body));
    } catch {
      throw new DiscordApiError(502, "Discord returned invalid JSON");
    }
  }

  async request(method, path, extraHeaders = {}) {
    let lastError;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const response = await this.fetchImplementation(`${DISCORD_API_BASE}${path}`, {
          method,
          headers: {
            Authorization: `Bot ${this.token}`,
            Accept: "application/json",
            "User-Agent": "DiscordBot (https://vibevibe.fun, 1.0.0)",
            ...extraHeaders,
          },
        });
        const contentLength = Number(response.headers.get("content-length"));
        if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
          throw new DiscordApiError(502, "Discord response exceeded size limit");
        }
        const body = new Uint8Array(await response.arrayBuffer());
        if (body.byteLength > MAX_RESPONSE_BYTES) {
          throw new DiscordApiError(502, "Discord response exceeded size limit");
        }

        if (response.status >= 200 && response.status < 300) {
          return { status: response.status, headers: response.headers, body };
        }
        if (response.status === 429 && attempt < 3) {
          await this.sleep(Math.ceil(parseRetryAfter(response.headers, body) * 1000 + this.random() * 250));
          continue;
        }
        if (response.status >= 500 && response.status <= 599 && attempt < 3) {
          await this.sleep(backoffMilliseconds(attempt, this.random));
          continue;
        }
        throw new DiscordApiError(response.status, "Discord API request failed");
      } catch (error) {
        if (error instanceof DiscordApiError) throw error;
        lastError = error;
        if (attempt < 3) {
          await this.sleep(backoffMilliseconds(attempt, this.random));
          continue;
        }
      }
    }

    throw new DiscordApiError(0, "Discord network request failed", lastError);
  }
}

export class DiscordApiError extends Error {
  constructor(status, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "DiscordApiError";
    this.status = status;
  }
}

export async function checkDiscordReadiness(config, discord) {
  const [botUser, guild, roles] = await Promise.all([
    discord.getCurrentUser(),
    discord.getGuild(config.guildId),
    discord.getGuildRoles(config.guildId),
  ]);

  if (!botUser || typeof botUser.id !== "string") {
    throw new Error("Discord bot identity could not be resolved");
  }
  if (botUser.id !== config.applicationId) {
    throw new Error("Discord bot token does not belong to the configured application");
  }
  if (!guild || guild.id !== config.guildId) {
    throw new Error("Configured Discord guild could not be resolved");
  }
  if (!Array.isArray(roles)) {
    throw new Error("Discord guild roles could not be resolved");
  }

  const botMember = await discord.getGuildMember(config.guildId, botUser.id);
  if (!botMember) throw new Error("Bot is not a member of the configured guild");

  const byId = new Map(roles.map((role) => [role.id, role]));
  const everyone = byId.get(config.guildId);
  const builder = byId.get(config.builderRoleId);
  const verified = byId.get(config.verifiedRoleId);
  if (!everyone || !builder || !verified) {
    throw new Error("Configured Discord roles could not all be resolved");
  }
  if (builder.managed) throw new Error("Builder role must not be integration-managed");

  const botRoles = [everyone];
  for (const roleId of Array.isArray(botMember.roles) ? botMember.roles : []) {
    const role = byId.get(roleId);
    if (role) botRoles.push(role);
  }

  const permissions = botRoles.reduce(
    (combined, role) => combined | BigInt(role.permissions),
    0n,
  );
  if ((permissions & ADMINISTRATOR) !== 0n) {
    throw new Error("Bot must not have Administrator");
  }
  if ((permissions & MANAGE_ROLES) === 0n) {
    throw new Error("Bot lacks Manage Roles");
  }

  const highestRole = botRoles.reduce((highest, role) =>
    compareRolePosition(role, highest) > 0 ? role : highest,
  );
  if (compareRolePosition(highestRole, builder) <= 0) {
    throw new Error("Bot's highest role must be above Builder");
  }

  return {
    guildName: String(guild.name || ""),
    builderRoleName: String(builder.name || ""),
    verifiedRoleName: String(verified.name || ""),
    botRoleName: String(highestRole.name || ""),
  };
}

function compareRolePosition(left, right) {
  const difference = Number(left.position) - Number(right.position);
  if (difference !== 0) return difference;
  const leftId = BigInt(left.id);
  const rightId = BigInt(right.id);
  return leftId === rightId ? 0 : leftId < rightId ? 1 : -1;
}

function parseRetryAfter(headers, body) {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body));
    if (typeof parsed.retry_after === "number" && parsed.retry_after >= 0) {
      return parsed.retry_after;
    }
  } catch {
    // Fall through to the response header or a conservative default.
  }
  const header = Number(headers.get("retry-after"));
  return Number.isFinite(header) && header >= 0 ? header : 1;
}

function backoffMilliseconds(attempt, random) {
  return 250 * 2 ** attempt + Math.floor(random() * 100);
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
