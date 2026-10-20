import "dotenv/config"
import express from "express"
import path from "node:path"
import { fileURLToPath } from "node:url"
import gameHandler from "../lib/pepeguessr-api.js"
import loginHandler from "../api/auth/discord/login.js"
import callbackHandler from "../api/auth/discord/callback.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const frontendDist = path.resolve(root, "../frontend/dist")
const app = express()

if (process.env.NODE_ENV === "production" && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === "replace-with-a-long-random-secret")) {
  throw new Error("Set a strong SESSION_SECRET before starting PepeGuesser in production")
}
const allowedOrigins = new Set([process.env.FRONTEND_ORIGIN, ...(process.env.CORS_ORIGINS || "").split(",")].filter(Boolean).map((value) => value.trim()))

app.disable("x-powered-by")
app.use((req, res, next) => {
  const origin = req.headers.origin
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin)
    res.setHeader("Access-Control-Allow-Credentials", "true")
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type")
    res.vary("Origin")
  }
  if (req.method === "OPTIONS") return res.sendStatus(204)
  next()
})
app.use(express.json({ limit: "1mb" }))

// The game handler uses Vercel-style query paths; keep the same URL in local and hosted builds.
app.all("/api/pepeguessr", (req, res) => gameHandler(req, res))
app.get("/auth/discord/login", (req, res) => loginHandler(req, res))
app.get("/auth/discord/callback", (req, res) => callbackHandler(req, res))
app.use(express.static(frontendDist))
app.get("/{*path}", (req, res) => res.sendFile(path.join(frontendDist, "index.html")))

const port = Number(process.env.PORT || 8787)
app.listen(port, () => console.log(`PepeGuesser API listening on http://127.0.0.1:${port}`))
