const SIGNATURE_PATTERN = /^sha256=([a-f0-9]{64})$/;
const TIMESTAMP_PATTERN = /^[0-9]{1,12}$/;

export async function verifyServiceRequest({
  rawBody,
  timestampHeader,
  signatureHeader,
  secret,
  nowSeconds = Math.floor(Date.now() / 1000),
  maxAgeSeconds = 300,
  maxFutureSeconds = 30,
  cryptoImplementation = globalThis.crypto,
}) {
  if (
    typeof timestampHeader !== "string" ||
    !TIMESTAMP_PATTERN.test(timestampHeader)
  ) {
    return false;
  }

  const timestamp = Number(timestampHeader);
  if (
    !Number.isSafeInteger(timestamp) ||
    timestamp < nowSeconds - maxAgeSeconds ||
    timestamp > nowSeconds + maxFutureSeconds
  ) {
    return false;
  }

  if (typeof signatureHeader !== "string") return false;
  const match = SIGNATURE_PATTERN.exec(signatureHeader);
  if (!match?.[1] || !cryptoImplementation?.subtle) return false;

  const encoder = new TextEncoder();
  const prefix = encoder.encode(`${timestampHeader}.`);
  const message = new Uint8Array(prefix.byteLength + rawBody.byteLength);
  message.set(prefix, 0);
  message.set(rawBody, prefix.byteLength);

  const key = await cryptoImplementation.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );

  return cryptoImplementation.subtle.verify(
    "HMAC",
    key,
    hexToBytes(match[1]),
    message,
  );
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
