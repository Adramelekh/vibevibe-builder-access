const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DISCORD_ID_PATTERN = /^[0-9]{1,20}$/;
const EXPECTED_KEYS = ["discordUserId", "requestId"];

export function parseAssignmentRequest(bodyText) {
  let value;
  try {
    value = JSON.parse(bodyText);
  } catch {
    throw new InvalidRequestError("body must be valid JSON");
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidRequestError("body must be a JSON object");
  }

  const keys = Object.keys(value).sort();
  if (
    keys.length !== EXPECTED_KEYS.length ||
    keys.some((key, index) => key !== EXPECTED_KEYS[index])
  ) {
    throw new InvalidRequestError("body must contain exactly requestId and discordUserId");
  }
  if (typeof value.requestId !== "string" || !UUID_PATTERN.test(value.requestId)) {
    throw new InvalidRequestError("requestId must be a UUID");
  }
  if (
    typeof value.discordUserId !== "string" ||
    !DISCORD_ID_PATTERN.test(value.discordUserId) ||
    BigInt(value.discordUserId) === 0n
  ) {
    throw new InvalidRequestError("discordUserId must be a positive numeric string");
  }

  return Object.freeze({
    requestId: value.requestId,
    discordUserId: value.discordUserId,
  });
}

export class InvalidRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidRequestError";
  }
}
