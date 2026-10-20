import crypto from "crypto"

const SECRET = process.env.SESSION_SECRET || "dev-session-secret"

export function randomToken(size = 32) {
  return crypto.randomBytes(size).toString("base64url")
}

// simple HMAC-signed JSON blob helper
export function signPayload(obj) {
  const data = Buffer.from(JSON.stringify(obj)).toString("base64url")
  const mac = crypto.createHmac("sha256", SECRET).update(data).digest("base64url")
  return `${data}.${mac}`
}

export function verifyPayload(str) {
  if (!str || typeof str !== "string") return null
  const parts = str.split(".")
  if (parts.length !== 2) return null
  const [data, mac] = parts
  const expected = crypto.createHmac("sha256", SECRET).update(data).digest("base64url")
  const actualBytes = Buffer.from(mac)
  const expectedBytes = Buffer.from(expected)
  if (actualBytes.length !== expectedBytes.length || !crypto.timingSafeEqual(actualBytes, expectedBytes)) return null
  try {
    return JSON.parse(Buffer.from(data, "base64url").toString())
  } catch (err) {
    return null
  }
}

export function createCodeChallenge(verifier) {
  return crypto.createHash("sha256").update(verifier).digest("base64url")
}
