const SNOWFLAKE_PATTERN = /^[0-9]{1,20}$/;

export function loadConfig(environment) {
  const config = {
    applicationId: snowflake(environment, "DISCORD_APPLICATION_ID"),
    botToken: required(environment, "DISCORD_BOT_TOKEN"),
    guildId: snowflake(environment, "DISCORD_GUILD_ID"),
    builderRoleId: snowflake(environment, "DISCORD_BUILDER_ROLE_ID"),
    verifiedRoleId: snowflake(environment, "DISCORD_VERIFIED_ROLE_ID"),
    hmacSecret: required(environment, "WEBSITE_SERVICE_HMAC_SECRET"),
  };

  if (config.builderRoleId === config.verifiedRoleId) {
    throw new Error("DISCORD_BUILDER_ROLE_ID and DISCORD_VERIFIED_ROLE_ID must differ");
  }
  if (new TextEncoder().encode(config.hmacSecret).byteLength < 32) {
    throw new Error("WEBSITE_SERVICE_HMAC_SECRET must contain at least 32 bytes");
  }

  return Object.freeze(config);
}

function required(environment, name) {
  const value = environment?.[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function snowflake(environment, name) {
  const value = required(environment, name);
  if (!SNOWFLAKE_PATTERN.test(value) || BigInt(value) === 0n) {
    throw new Error(`${name} must be a positive numeric Discord snowflake string`);
  }
  return value;
}
