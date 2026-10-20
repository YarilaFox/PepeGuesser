import crypto from "crypto"
import { randomToken, signPayload, verifyPayload } from "./utils.js"

export const ADMIN_DISCORD_ID = process.env.ADMIN_DISCORD_ID || ""
const SESSION_COOKIE_NAME = "session"
const SESSION_TTL_SECONDS = 60 * 60 * 12
const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1000

function readString(value) {
  return typeof value === "string" ? value.trim() : ""
}

function normalizeOrigin(value) {
  const input = readString(value)
  if (!input) {
    return ""
  }

  try {
    return new URL(input).origin
  } catch (error) {
    return ""
  }
}

function configuredFrontendOrigins() {
  const origins = [
    process.env.FRONTEND_ORIGIN || "",
    ...(process.env.CORS_ORIGINS || process.env.CORS_ORIGIN || "").split(",")
  ]
    .map(normalizeOrigin)
    .filter(Boolean)

  if (process.env.NODE_ENV !== "production") {
    origins.push("http://localhost:5174", "http://127.0.0.1:5174")
  }

  return [...new Set(origins)]
}

function isAllowedFrontendOrigin(origin) {
  const normalizedOrigin = normalizeOrigin(origin)
  return Boolean(normalizedOrigin && configuredFrontendOrigins().includes(normalizedOrigin))
}

function getCookieValue(req, cookieName) {
  const cookieHeader = readString(req?.headers?.cookie)
  if (!cookieHeader) {
    return ""
  }

  const parts = cookieHeader.split(";")
  for (const part of parts) {
    const [nameRaw, ...valueParts] = part.trim().split("=")
    if (readString(nameRaw) !== cookieName) {
      continue
    }

    const value = valueParts.join("=")
    try {
      return decodeURIComponent(value)
    } catch (error) {
      return value
    }
  }

  return ""
}

function buildSessionCookie(value, maxAgeSeconds) {
  const sameSite = normalizedCookieSameSite()
  const isProduction = process.env.NODE_ENV === "production"
  const attrs = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    `SameSite=${sameSite}`,
    `Max-Age=${maxAgeSeconds}`
  ]
  const domain = readString(process.env.SESSION_COOKIE_DOMAIN)
  if (domain) {
    attrs.push(`Domain=${domain}`)
  }

  if (isProduction || sameSite.toLowerCase() === "none") {
    attrs.push("Secure")
  }

  return attrs.join("; ")
}

function normalizedCookieSameSite() {
  const value = readString(process.env.SESSION_COOKIE_SAMESITE).toLowerCase()
  if (["lax", "strict", "none"].includes(value)) {
    return value.charAt(0).toUpperCase() + value.slice(1)
  }

  return "Lax"
}

export function safeNextPath(value) {
  const input = readString(value)
  const frontendOrigin = normalizeOrigin(process.env.FRONTEND_ORIGIN)
  if (!input) {
    return frontendOrigin ? `${frontendOrigin}/` : "/"
  }

  if (input.startsWith("/") && !input.startsWith("//")) {
    if (input.startsWith("/api") || input.startsWith("/auth")) {
      return frontendOrigin ? `${frontendOrigin}/` : "/"
    }

    return frontendOrigin ? `${frontendOrigin}${input}` : input
  }

  try {
    const url = new URL(input)
    if (isAllowedFrontendOrigin(url.origin)) {
      return url.toString()
    }
  } catch (error) {
    // Fall back to the default path below.
  }

  return frontendOrigin ? `${frontendOrigin}/` : "/"
}

export function deniedPath(reason = "generic") {
  return `/404?staff=denied&reason=${encodeURIComponent(reason)}`
}

export function resolveDiscordRedirectUri(req) {
  const configured = readString(process.env.DISCORD_REDIRECT_URI)
  if (configured) {
    return configured
  }

  const host = readString(req?.headers?.["x-forwarded-host"]) || readString(req?.headers?.host)
  const protocol = readString(req?.headers?.["x-forwarded-proto"]) || "https"

  if (!host) {
    return ""
  }

  return `${protocol}://${host}/api/auth/discord/callback`
}

export function createOwnerSession(userId) {
  const now = Date.now()
  return {
    userId,
    discordId: userId,
    isOwner: true,
    csrfToken: randomToken(24),
    createdAt: now,
    exp: now + SESSION_TTL_MS
  }
}

export function createPlayerSession(profile, isOwner = false) {
  const now = Date.now()
  return {
    userId: readString(profile?.discordId) || readString(profile?.id),
    discordId: readString(profile?.discordId) || readString(profile?.id),
    displayName: readString(profile?.displayName) || "Игрок",
    avatarUrl: readString(profile?.avatarUrl),
    isOwner: Boolean(isOwner),
    csrfToken: randomToken(24),
    createdAt: now,
    exp: now + SESSION_TTL_MS
  }
}

export function setSessionCookie(res, sessionPayload) {
  const token = signPayload(sessionPayload)
  res.setHeader("Set-Cookie", buildSessionCookie(token, SESSION_TTL_SECONDS))
}

export function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", buildSessionCookie("", 0))
}

export function getSessionFromRequest(req) {
  const raw = getCookieValue(req, SESSION_COOKIE_NAME)
  if (!raw) {
    return null
  }

  const session = verifyPayload(raw)
  if (!session || typeof session !== "object") {
    return null
  }

  const exp = Number(session.exp)
  if (!Number.isFinite(exp) || exp <= Date.now()) {
    return null
  }

  return session
}

export function getOwnerSessionFromRequest(req) {
  const session = getSessionFromRequest(req)
  if (!session || !session.isOwner || readString(session.userId) !== readString(ADMIN_DISCORD_ID)) {
    return null
  }

  return session
}

export function requireOwnerSession(req, res) {
  const session = getOwnerSessionFromRequest(req)
  if (!session) {
    res.status(401).json({ message: "Требуется авторизация" })
    return null
  }

  return session
}

export function requireCsrf(req, res, session) {
  const headerToken = readString(req?.headers?.["x-csrf-token"])
  const sessionToken = readString(session?.csrfToken)

  if (!headerToken || !sessionToken) {
    res.status(403).json({ message: "Неверный CSRF токен" })
    return false
  }

  const a = Buffer.from(headerToken)
  const b = Buffer.from(sessionToken)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    res.status(403).json({ message: "Неверный CSRF токен" })
    return false
  }

  return true
}
