import { DiscordApiError } from "./discord.js";

export async function assignBuilderRole(config, discord, request) {
  let member;
  try {
    member = await discord.getGuildMember(config.guildId, request.discordUserId);
  } catch {
    return failure("DISCORD_UNAVAILABLE", true);
  }

  if (!member) return failure("NOT_MEMBER", true);
  if (member.pending === true) return failure("MEMBERSHIP_PENDING", true);
  if (!Array.isArray(member.roles)) return failure("DISCORD_UNAVAILABLE", true);
  if (!member.roles.includes(config.verifiedRoleId)) return failure("NOT_VERIFIED", true);

  if (member.roles.includes(config.builderRoleId)) {
    return {
      ok: true,
      status: "ALREADY_ASSIGNED",
      confirmedAt: new Date().toISOString(),
    };
  }

  let assignedAt;
  try {
    await discord.addGuildMemberRole(
      config.guildId,
      request.discordUserId,
      config.builderRoleId,
      `Builder Foundry website OAuth; request ${request.requestId}`,
    );
    assignedAt = new Date().toISOString();
  } catch (error) {
    if (error instanceof DiscordApiError && error.status === 403) {
      return failure("BOT_ROLE_TOO_LOW", false);
    }
    return failure("DISCORD_UNAVAILABLE", true);
  }

  try {
    const updated = await discord.getGuildMember(config.guildId, request.discordUserId);
    if (!updated || !Array.isArray(updated.roles) || !updated.roles.includes(config.builderRoleId)) {
      return failure("DISCORD_UNAVAILABLE", true);
    }
    return {
      ok: true,
      status: "ASSIGNED",
      assignedAt,
      confirmedAt: new Date().toISOString(),
    };
  } catch {
    return failure("DISCORD_UNAVAILABLE", true);
  }
}

function failure(code, retryable) {
  return { ok: false, code, retryable };
}
