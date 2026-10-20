import { createCodeChallenge, randomToken, signPayload } from "../../../lib/utils.js"
import {
  clearSessionCookie,
  deniedPath,
  resolveDiscordRedirectUri,
  safeNextPath
} from "../../../lib/auth.js"

export default function handler(req, res) {
  clearSessionCookie(res)
  const redirectUri = resolveDiscordRedirectUri(req)
  const clientId = process.env.DISCORD_CLIENT_ID || ""

  if (!/^\d{17,22}$/.test(clientId.trim()) || !redirectUri) {
    return res.redirect(deniedPath("config"))
  }

  const nextPath = safeNextPath(typeof req.query.next === "string" ? req.query.next : "/")

  const codeVerifier = randomToken(48)
  const statePayload = {
    codeVerifier,
    nextPath,
    exp: Date.now() + 1000 * 60 * 10 // 10 minutes
  }
  const state = signPayload(statePayload)

  const codeChallenge = createCodeChallenge(codeVerifier)

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "identify",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256"
  })

  // immediate redirect; state is self-contained
  res.redirect(`https://discord.com/api/oauth2/authorize?${params.toString()}`)
}
