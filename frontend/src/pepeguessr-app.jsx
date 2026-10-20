import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import L from "leaflet"
import { BoxGeometry, Mesh, MeshBasicMaterial, PerspectiveCamera, SRGBColorSpace, Scene, TextureLoader, WebGLRenderer } from "three"
import "leaflet/dist/leaflet.css"
import "./styles/pepeguessr.css"

const FACE_IDS = ["front", "right", "back", "left", "up", "down"]
const FACE_LABELS = {
  front: "Front",
  back: "Back",
  left: "Left",
  right: "Right",
  up: "Up",
  down: "Down"
}
const SOLO_SAVE_KEY = "pepeguessr:solo:v4"
const ROOM_SAVE_KEY = "pepeguessr:room:v1"
const PEPEGUESSR_TITLE = "PepeGuesser"
const MIXED_WORLD_ID = "mixed"
const SOLO_ROUND_MS = 60 * 1000
const DUEL_REVEAL_MS = 10 * 1000
const DUEL_REVEAL_COUNTDOWN_MS = 3 * 1000
const DUEL_INTRO_COUNTDOWN_MS = 3 * 1000
const DUEL_ROOM_TIMER_OPTIONS = [
  { value: 15_000, label: "0:15" },
  { value: 60_000, label: "1:00" },
  { value: 120_000, label: "2:00" },
  { value: 0, label: "До гесса" }
]
const SAVE_TTL_MS = 24 * 60 * 60 * 1000
const PROFILE_PRESENCE_INTERVAL_MS = 30_000
const MAP_READY_TIMEOUT_MS = 12_000
const stitchedMapCache = new Map()
const tileImageLoadCache = new Map()
const mapManifestCache = new Map()
const EMPTY_ARRAY = []
const PROFILE_BADGE_ASSETS = {
  developer: new URL("../data/Разработчик.svg", import.meta.url).href,
  streamer: new URL("../data/Стример.svg", import.meta.url).href,
  tester: new URL("../data/Тестировщик.svg", import.meta.url).href
}
const ERROR_404_ASSET = new URL("../data/error 404.svg", import.meta.url).href
const ERROR_405_ASSET = new URL("../data/Error 405.svg", import.meta.url).href

const GAME_SOUND_ASSETS = {
  countdown: new URL("../data/3.2.1.wav", import.meta.url).href,
  guess: new URL("../data/guess.wav", import.meta.url).href,
  no: new URL("../data/no.wav", import.meta.url).href,
  start: new URL("../data/start.wav", import.meta.url).href,
  time: new URL("../data/time.wav", import.meta.url).href
}
const PROFILE_COVER_COLORS = ["#49a5ae", "#101010", "#7c5cff", "#f06a28", "#228b52", "#9d3b3b", "#30353a", "#f2b84b"]
const GAME_SOUND_VOLUME = {
  countdown: 0.72,
  guess: 0.66,
  no: 0.62,
  start: 0.7,
  time: 0.42
}
const DEFAULT_PEPEGUESSR_SETTINGS = {
  mapSize: 1,
  fov: 72,
  uiScale: 1
}
const PEPEGUESSR_ROUTE_PATHS = {
  training: "/training",
  duel: "/duels",
  room: "/room",
  login: "/login",
  profile: "/profile"
}
const gameAudioCache = new Map()
let gameAudioUnlocked = false

function getGameAudio(name) {
  const src = GAME_SOUND_ASSETS[name]
  if (!src || typeof Audio === "undefined") {
    return null
  }
  if (!gameAudioCache.has(name)) {
    const audio = new Audio(src)
    audio.preload = "auto"
    audio.volume = GAME_SOUND_VOLUME[name] ?? 0.65
    gameAudioCache.set(name, audio)
  }
  return gameAudioCache.get(name)
}

function unlockGameAudio() {
  if (gameAudioUnlocked || typeof window === "undefined") {
    return
  }
  gameAudioUnlocked = true
  Object.keys(GAME_SOUND_ASSETS).forEach((name) => {
    const audio = getGameAudio(name)
    if (!audio) {
      return
    }
    const previousMuted = audio.muted
    audio.muted = true
    audio.play()
      .then(() => {
        audio.pause()
        audio.currentTime = 0
        audio.muted = previousMuted
      })
      .catch(() => {
        audio.muted = previousMuted
      })
  })
}

function playGameSound(name) {
  const audio = getGameAudio(name)
  if (!audio) {
    return
  }
  audio.pause()
  audio.currentTime = 0
  audio.muted = false
  audio.play().catch(() => {})
}

function stopGameSound(name) {
  const audio = getGameAudio(name)
  if (!audio) {
    return
  }
  audio.pause()
  audio.currentTime = 0
}

if (typeof window !== "undefined") {
  window.addEventListener("pointerdown", unlockGameAudio, { once: true, passive: true })
  window.addEventListener("keydown", unlockGameAudio, { once: true })
}

function readString(value) {
  return typeof value === "string" ? value.trim() : ""
}

function normalizePepeGuessrSettings(settings = {}) {
  return {
    mapSize: Math.max(0.75, Math.min(1.35, Number(settings?.mapSize) || DEFAULT_PEPEGUESSR_SETTINGS.mapSize)),
    fov: Math.max(42, Math.min(120, Math.round(Number(settings?.fov) || DEFAULT_PEPEGUESSR_SETTINGS.fov))),
    uiScale: Math.max(0.8, Math.min(1.2, Number(settings?.uiScale) || DEFAULT_PEPEGUESSR_SETTINGS.uiScale))
  }
}

function escapeHtml(value) {
  return readString(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

// Same-origin by default; deployments with a separate API set VITE_PEPEGUESSR_API_BASE.
const PEPEGUESSR_API_BASE = readString(import.meta.env?.VITE_PEPEGUESSR_API_BASE).replace(/\/+$/, "")

function readClientSave(key) {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) {
      return null
    }
    const parsed = JSON.parse(raw)
    if (!parsed?.savedAt || Date.now() - Number(parsed.savedAt) > SAVE_TTL_MS) {
      window.localStorage.removeItem(key)
      return null
    }
    return parsed
  } catch {
    return null
  }
}

function writeClientSave(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify({ ...value, savedAt: Date.now() }))
  } catch {
    // localStorage can be blocked in private modes; the game should still run.
  }
}

function clearClientSave(key) {
  try {
    window.localStorage.removeItem(key)
  } catch {
    // Ignore storage failures.
  }
}

async function fetchJson(url, options = {}) {
  const method = readString(options.method || "GET").toUpperCase()
  const headers = {
    ...(method === "GET" || method === "HEAD" ? {} : { "Content-Type": "application/json" }),
    ...(options.headers || {})
  }
  const response = await fetch(url, {
    cache: "no-store",
    credentials: "include",
    headers,
    ...options
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(readString(payload?.message) || `${response.status} ${response.statusText}`)
    error.status = response.status
    throw error
  }
  return payload
}

function fetchMapManifest(src) {
  const key = readString(src)
  if (!key) {
    return Promise.reject(new Error("Missing map manifest"))
  }
  if (!mapManifestCache.has(key)) {
    mapManifestCache.set(key, fetchJson(key).catch((error) => {
      mapManifestCache.delete(key)
      throw error
    }))
  }
  return mapManifestCache.get(key)
}

function getDimensionManifestPath(world, dimensionId) {
  return world?.dimensions?.find((dimension) => dimension.id === dimensionId)?.manifestPath || world?.manifestPath || ""
}

function withPepeGuessrApiBase(path) {
  const cleanPath = readString(path)
  if (!PEPEGUESSR_API_BASE || /^https?:\/\//i.test(cleanPath)) {
    return cleanPath
  }
  return `${PEPEGUESSR_API_BASE}${cleanPath.startsWith("/") ? cleanPath : `/${cleanPath}`}`
}

function pepeApi(path) {
  return withPepeGuessrApiBase(`/api/pepeguessr?path=${encodeURIComponent(readString(path).replace(/^\/+/, ""))}`)
}

function pepeAssetUrl(path) {
  const cleanPath = readString(path)
  if (!cleanPath) {
    return cleanPath
  }

  return cleanPath.startsWith("/pepeguessr/") || cleanPath.startsWith("/api/pepeguessr")
    ? withPepeGuessrApiBase(cleanPath)
    : cleanPath
}

function normalizeAppPath(pathname = window.location.pathname) {
  const rawPath = readString(pathname).replace(/\/+$/, "") || "/"
  if (rawPath === "/pepeguessr") {
    return "/"
  }
  return rawPath.replace(/^\/pepeguessr(?=\/)/i, "") || "/"
}

function absoluteAppUrl(path = PEPEGUESSR_ROUTE_PATHS.training) {
  const cleanPath = readString(path) || PEPEGUESSR_ROUTE_PATHS.training
  if (typeof window === "undefined") {
    return cleanPath
  }
  return new URL(cleanPath, window.location.origin).toString()
}

function discordLoginUrl(nextPath = PEPEGUESSR_ROUTE_PATHS.training) {
  const next = PEPEGUESSR_API_BASE ? absoluteAppUrl(nextPath) : nextPath
  return withPepeGuessrApiBase(`/auth/discord/login?next=${encodeURIComponent(next)}`)
}

function resolveDimensionAssetPath(src, worldId, dimensionId) {
  const source = readString(src)
  const safeWorldId = readString(worldId)
  const safeDimensionId = readString(dimensionId) || "overworld"
  const worldPrefix = `/maps/${safeWorldId}/tiles/`
  if (!source || !safeWorldId || !source.includes(worldPrefix)) {
    return source
  }

  const remainder = source.slice(source.indexOf(worldPrefix) + worldPrefix.length)
  const normalizedRemainder = remainder.replace(/^(overworld|nether|end|pale)\//, "")
  return `${worldPrefix}${safeDimensionId}/${normalizedRemainder}`
}

function mapTileFallbackCandidates(src, worldId, dimensionId) {
  const source = readString(src)
  const safeWorldId = readString(worldId)
  const safeDimensionId = readString(dimensionId) || "overworld"
  const worldPrefix = `/maps/${safeWorldId}/tiles/`
  if (!source || !safeWorldId || !source.includes(worldPrefix)) {
    return source ? [source] : []
  }

  const prefixIndex = source.indexOf(worldPrefix)
  const remainder = source.slice(prefixIndex + worldPrefix.length)
  const normalizedRemainder = remainder.replace(/^(overworld|nether|end|pale)\//, "")
  return [`${worldPrefix}${safeDimensionId}/${normalizedRemainder}`]
}

function resolveManifestForDimension(manifest, worldId, dimensionId) {
  return {
    ...manifest,
    tiles: Array.isArray(manifest?.tiles)
      ? manifest.tiles.map((tile) => ({
          ...tile,
          src: resolveDimensionAssetPath(tile?.src, worldId, dimensionId),
          srcWebp: resolveDimensionAssetPath(tile?.srcWebp, worldId, dimensionId),
          srcPng: resolveDimensionAssetPath(tile?.srcPng, worldId, dimensionId),
          srcCandidates: [
            ...mapTileFallbackCandidates(tile?.srcWebp, worldId, dimensionId),
            ...mapTileFallbackCandidates(tile?.srcPng, worldId, dimensionId),
            ...mapTileFallbackCandidates(tile?.src, worldId, dimensionId)
          ]
        }))
      : []
  }
}

function buildTileMeta(manifest) {
  const bounds = manifest?.bounds && typeof manifest.bounds === "object" ? manifest.bounds : {}
  const width = Number(bounds.width)
  const height = Number(bounds.height)
  const minX = Number(bounds.minX)
  const minZ = Number(bounds.minZ)
  const tileSize = Number(manifest?.tileSize) > 0 ? Number(manifest.tileSize) : 1024
  const tiles = Array.isArray(manifest?.tiles) ? manifest.tiles : []

  if (!Number.isFinite(width) || !Number.isFinite(height) || !Number.isFinite(minX) || !Number.isFinite(minZ) || width <= 0 || height <= 0) {
    return null
  }

  return {
    width,
    height,
    minX,
    minZ,
    tileSize,
    tiles: tiles
      .map((tile, index) => {
        const x = Number(tile?.x)
        const z = Number(tile?.z)
        const srcCandidates = [
          ...(Array.isArray(tile?.srcCandidates) ? tile.srcCandidates.map(readString) : []),
          readString(tile?.srcWebp),
          readString(tile?.srcPng),
          readString(tile?.src)
        ].filter(Boolean)
        const uniqueSrcCandidates = [...new Set(srcCandidates)]
        const src = uniqueSrcCandidates[0]
        if (!Number.isFinite(x) || !Number.isFinite(z) || !src) {
          return null
        }
        const left = x - minX
        const top = z - minZ
        const seamOverlap = 1
        return {
          id: readString(tile?.id) || `tile-${index + 1}`,
          src,
          srcCandidates: uniqueSrcCandidates,
          left,
          top,
          bounds: L.latLngBounds(
            [height - (top + tileSize + seamOverlap), left - seamOverlap],
            [height - top + seamOverlap, left + tileSize + seamOverlap]
          )
        }
      })
      .filter(Boolean)
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.crossOrigin = "anonymous"
    image.onload = () => resolve(image)
    image.onerror = reject
    image.src = src
  })
}

function preloadTileImage(src) {
  const key = readString(src)
  if (!key) {
    return Promise.resolve(false)
  }
  if (!tileImageLoadCache.has(key)) {
    tileImageLoadCache.set(key, loadImage(key).then(() => true).catch(() => false))
  }
  return tileImageLoadCache.get(key)
}

async function preloadMapTiles(tileMeta) {
  const tiles = Array.isArray(tileMeta?.tiles) ? tileMeta.tiles : []
  const results = await Promise.allSettled(tiles.map(async (tile) => {
    const candidates = Array.isArray(tile.srcCandidates) && tile.srcCandidates.length ? tile.srcCandidates : [tile.src]
    for (const src of candidates) {
      if (await preloadTileImage(src)) {
        return { id: tile.id, src }
      }
    }
    return null
  }))
  return new Map(results
    .filter((result) => result.status === "fulfilled" && result.value?.id && result.value?.src)
    .map((result) => [result.value.id, result.value.src]))
}

function canvasToBlobUrl(canvas, type = "image/jpeg", quality = 0.88) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Canvas export failed"))
        return
      }
      resolve(URL.createObjectURL(blob))
    }, type, quality)
  })
}

async function buildStitchedMap(tileMeta) {
  const cacheKey = `${tileMeta.width}:${tileMeta.height}:${tileMeta.tiles.map((tile) => `${tile.id}:${tile.src}`).join("|")}`
  if (stitchedMapCache.has(cacheKey)) {
    return stitchedMapCache.get(cacheKey)
  }

  const maxSize = 8192
  const scale = Math.min(1, maxSize / Math.max(tileMeta.width, tileMeta.height))
  const canvas = document.createElement("canvas")
  canvas.width = Math.max(1, Math.round(tileMeta.width * scale))
  canvas.height = Math.max(1, Math.round(tileMeta.height * scale))
  const context = canvas.getContext("2d", { alpha: false })
  if (!context) {
    return ""
  }
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = "high"

  const loadedTiles = await Promise.allSettled(tileMeta.tiles.map(async (tile) => ({
    tile,
    image: await loadImage(tile.src)
  })))

  loadedTiles.forEach((result) => {
    if (result.status !== "fulfilled") {
      return
    }
    const { tile, image } = result.value
    const crop = 2
    const sx = Math.min(crop, Math.max(0, image.naturalWidth - 1))
    const sy = Math.min(crop, Math.max(0, image.naturalHeight - 1))
    const sw = Math.max(1, image.naturalWidth - sx * 2)
    const sh = Math.max(1, image.naturalHeight - sy * 2)
    const dx = Math.round(tile.left * scale)
    const dy = Math.round(tile.top * scale)
    const dw = Math.ceil(tileMeta.tileSize * scale) + 1
    const dh = Math.ceil(tileMeta.tileSize * scale) + 1
    context.drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh)
  })

  const blobUrl = await canvasToBlobUrl(canvas, "image/jpeg", 0.94)
  stitchedMapCache.set(cacheKey, blobUrl)
  return blobUrl
}

function minecraftToLatLng(point, tileMeta) {
  const x = Math.floor(Number(point?.x) || 0)
  const z = Math.floor(Number(point?.z) || 0)
  return L.latLng(tileMeta.height - (z - tileMeta.minZ + 0.5), x - tileMeta.minX + 0.5)
}

function latLngToMinecraft(latlng, tileMeta) {
  const minX = Number(tileMeta?.minX) || 0
  const minZ = Number(tileMeta?.minZ) || 0
  const maxX = minX + Math.max(1, Number(tileMeta?.width) || 1) - 1
  const maxZ = minZ + Math.max(1, Number(tileMeta?.height) || 1) - 1
  const x = Math.floor(Number(latlng?.lng) + minX)
  const z = Math.floor(Number(tileMeta?.height) - Number(latlng?.lat) + minZ)
  return {
    x: Math.max(minX, Math.min(maxX, x)),
    z: Math.max(minZ, Math.min(maxZ, z))
  }
}

function formatDistance(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return "нет ответа"
  }
  return `${Math.round(Number(value))} блоков`
}

function formatSeconds(ms) {
  const total = Math.max(0, Math.ceil(Number(ms) / 1000) || 0)
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes > 0 ? `${minutes}:${String(seconds).padStart(2, "0")}` : String(seconds)
}

function getPepeGuessrRouteMode(pathname = window.location.pathname) {
  const path = normalizeAppPath(pathname).toLowerCase()
  if (path === "/" || path === "/training") return "training"
  if (path === "/profile" || path.startsWith("/profile/")) return "profile"
  if (path === "/login") return "login"
  if (path === "/room") return "room"
  if (path === "/duels" || path === "/duel") return "duel"
  return "notFound"
}

function getPepeGuessrRoutePath(mode) {
  if (mode === "profile") return PEPEGUESSR_ROUTE_PATHS.profile
  if (mode === "login") return PEPEGUESSR_ROUTE_PATHS.login
  if (mode === "room") return PEPEGUESSR_ROUTE_PATHS.room
  if (mode === "duel") return PEPEGUESSR_ROUTE_PATHS.duel
  return PEPEGUESSR_ROUTE_PATHS.training
}

function getPepeGuessrRouteProfileId(pathname = window.location.pathname) {
  const match = normalizeAppPath(pathname).match(/^\/profile\/([^/?#]+)/i)
  return match ? decodeURIComponent(match[1]) : ""
}

function getPepeGuessrProfilePath(profileOrId) {
  const id = readString(typeof profileOrId === "object" ? profileOrId?.id : profileOrId)
  return id ? `/profile/${encodeURIComponent(id)}` : PEPEGUESSR_ROUTE_PATHS.profile
}

function getPepeGuessrRouteWorldId(worlds, pathname = window.location.pathname, search = window.location.search) {
  const availableWorlds = Array.isArray(worlds) ? worlds : []
  const params = new URLSearchParams(readString(search))
  const requested = readString(params.get("world") || params.get("map"))
  if (requested === MIXED_WORLD_ID) {
    return MIXED_WORLD_ID
  }
  if (availableWorlds.some((world) => world.id === requested)) {
    return requested
  }

  const path = readString(pathname).toLowerCase()
  const match = availableWorlds.find((world) => path.includes(`/${readString(world.id).toLowerCase()}`))
  return match?.id || ""
}

function getPepeGuessrRouteDimensionId(world, search = window.location.search) {
  const params = new URLSearchParams(readString(search))
  const requested = readString(params.get("dimension") || params.get("dim"))
  const dimensions = Array.isArray(world?.dimensions) ? world.dimensions.filter((item) => item.enabled) : []
  if (dimensions.some((dimension) => dimension.id === requested)) {
    return requested
  }
  return ""
}

function minecraftAvatarUrl(name, size = 54) {
  const safeName = readString(name).replace(/[^a-zA-Z0-9_]/g, "")
  return safeName ? `https://mc-heads.net/avatar/${safeName}/${size}` : ""
}

function minecraftBodyRenderUrl(name) {
  const safeName = readString(name).replace(/[^a-zA-Z0-9_]/g, "")
  return safeName ? `https://nmsr.nickac.dev/fullbody/${encodeURIComponent(safeName)}` : ""
}

function stableImageUrl(value) {
  const source = readString(value)
  if (!source) {
    return ""
  }

  try {
    const url = new URL(source, window.location.origin)
    if (url.hostname.includes("discordapp.com") || url.hostname.includes("discordapp.net")) {
      url.search = ""
    }
    return url.toString()
  } catch {
    return source.replace(/\?.*$/, "")
  }
}

function getLocationWorld(catalog, location, fallbackWorld) {
  const worlds = Array.isArray(catalog?.worlds) ? catalog.worlds : []
  const locationWorldId = readString(location?.worldId)
  return worlds.find((world) => world.id === locationWorldId) || fallbackWorld || worlds[0] || null
}

function getProfileAvatarUrl(profile, size = 54) {
  return minecraftAvatarUrl(profile?.minecraftName, size) || stableImageUrl(profile?.avatarUrl)
}

function getProfileDisplayName(profile, fallback = "Игрок") {
  return readString(profile?.displayName || profile?.minecraftName || profile?.username || profile?.id) || fallback
}

function ProfileBadges({ badges, compact = false }) {
  const items = Array.isArray(badges) ? badges : []
  if (!items.length) {
    return null
  }

  return (
    <div className={`pg-profile-badges${compact ? " pg-profile-badges--compact" : ""}`}>
      {items.map((badge) => {
        const id = readString(badge?.id)
        const icon = readString(badge?.iconUrl) || PROFILE_BADGE_ASSETS[id]
        const label = readString(badge?.label) || id
        return (
          <span key={id || label} className={`pg-profile-badge-chip pg-profile-badge-chip--${id}`} aria-label={label}>
            {icon ? <img src={icon} aria-hidden="true" /> : null}
            {!compact ? <b>{label}</b> : null}
            <em className="pg-profile-badge-tooltip">{label}</em>
          </span>
        )
      })}
    </div>
  )
}

function ProfileBadge({ me, onLogout, onProfile, active = false }) {
  if (!me?.authenticated) {
    return (
      <a className="pg-profile-login" href={discordLoginUrl(window.location.pathname || PEPEGUESSR_ROUTE_PATHS.training)}>{"\u0412\u043E\u0439\u0442\u0438 \u0447\u0435\u0440\u0435\u0437 Discord"}</a>
    )
  }

  const avatarSrc = getProfileAvatarUrl(me.profile)

  return (
    <div className="pg-profile-badge">
      <button type="button" className={`pg-profile-main${active ? " is-active" : ""}`} onClick={onProfile}>
        <b>{me.profile.displayName}</b>
        {avatarSrc ? <img src={avatarSrc} alt="" /> : <span className="pg-avatar-fallback" />}
      </button>
      <div>
        <span>{me.profile.stats?.wins || 0}W / {me.profile.stats?.losses || 0}L</span>
        <ProfileBadges badges={me.profile.badges} compact />
      </div>
      <button type="button" onClick={onLogout}>Выйти</button>
    </div>
  )
}

function GameSettingsPanel({ open, settings, saving, onClose, onChange, onSave }) {
  if (!open) {
    return null
  }
  return (
    <div className="pg-settings-backdrop" role="dialog" aria-modal="true" aria-label="Настройки игры">
      <section className="pg-settings-panel">
        <div className="pg-settings-head">
          <span>Настройки</span>
          <button type="button" onClick={onClose} aria-label="Закрыть">×</button>
        </div>
        <label>
          <b>Размер карты</b>
          <input type="range" min="0.75" max="1.35" step="0.05" value={settings.mapSize} onChange={(event) => onChange({ mapSize: Number(event.target.value) })} />
          <small>{Math.round(settings.mapSize * 100)}%</small>
        </label>
        <label>
          <b>FOV по умолчанию</b>
          <input type="range" min="42" max="120" step="1" value={settings.fov} onChange={(event) => onChange({ fov: Number(event.target.value) })} />
          <small>{settings.fov}</small>
        </label>
        <label>
          <b>Размер интерфейса</b>
          <input type="range" min="0.8" max="1.2" step="0.05" value={settings.uiScale} onChange={(event) => onChange({ uiScale: Number(event.target.value) })} />
          <small>{Math.round(settings.uiScale * 100)}%</small>
        </label>
        <div className="pg-settings-actions">
          <button type="button" className="pg-danger" onClick={onClose}>Отмена</button>
          <button type="button" className="pg-primary" onClick={onSave} disabled={saving}>{saving ? "Сохраняю..." : "Сохранить"}</button>
        </div>
      </section>
    </div>
  )
}

function ModeLandingCard({ mode, onStart, actionLabel, actionHref }) {
  const isDuel = mode === "duel"
  const label = actionLabel || "\u041d\u0430\u0447\u0430\u0442\u044c"
  return (
    <section className="pg-mode-landing" aria-label={isDuel ? "Дуэли" : "Тренировка"}>
      <article className="pg-mode-preview">
        <img src={isDuel ? "/pepeguessr/ui/duel.png" : "/pepeguessr/ui/training.png"} alt="" />
        <div className="pg-mode-preview-body">
          <h1>{isDuel ? "Дуэли" : "Тренировка"}</h1>
          <p>
            {isDuel
              ? "Сражение на 6000 HP. Угадывайте одну точку, сравнивайте очки и выбивайте соперника."
              : "Быстрый прогон точек без обязательной регистрации."}
          </p>
          <p>
            {isDuel
              ? "Таймер задается комнатой, а урон растет на 6, 8 и 10 раундах."
              : "Но зарегистрированный игрок получает статистику!"}
          </p>
          {actionHref ? (
            <a className="pg-mode-preview-action" href={actionHref}>{label}</a>
          ) : (
            <button type="button" onClick={onStart}>{label}</button>
          )}
        </div>
      </article>
    </section>
  )
}

function RoomCreateIcon() {
  return (
    <svg viewBox="0 0 66 75" aria-hidden="true" focusable="false">
      <path d="M28.5 61.3301V32.3301M30.5 60.3301L28.5 61.3301L3.0057 47.6994C2.69309 47.5216 2.5 47.1897 2.5 46.8301L2.99996 17.8301L27.9805 2.6458C28.2997 2.45183 28.7003 2.45183 29.0194 2.6458L54 17.8301V39.8301M2.99996 17.8301L28.5 32.3301M28.5 32.3301L54 17.8301" stroke="currentColor" strokeWidth="5" strokeLinecap="round" />
      <path d="M49.5 42.8301C58.0604 42.8301 65 49.7697 65 58.3301C65 66.8905 58.0604 73.8301 49.5 73.8301C40.9396 73.8301 34 66.8905 34 58.3301C34 49.7697 40.9396 42.8301 49.5 42.8301ZM47 55.8301H39V60.8301H47V68.8301H52V60.8301H60V55.8301H52V47.8301H47V55.8301Z" fill="currentColor" stroke="currentColor" />
    </svg>
  )
}

function RoomJoinIcon() {
  return (
    <svg viewBox="0 0 54 57" aria-hidden="true" focusable="false">
      <path d="M16 38.5V51.5C16 53.1569 17.3431 54.5 19 54.5H48.5C50.1569 54.5 51.5 53.1569 51.5 51.5V5.5C51.5 3.84314 50.1569 2.5 48.5 2.5H19C17.3431 2.5 16 3.84315 16 5.5V17.5M2.5 28.5H33.5M24 18L33.5 28.5L24 39" stroke="currentColor" strokeWidth="5" strokeLinecap="round" fill="none" />
    </svg>
  )
}

function CubeViewer({ location }) {
  const [activeFace, setActiveFace] = useState("front")
  const [missingFaces, setMissingFaces] = useState({})
  const cubemap = location?.cubemap || {}
  const activeSrc = pepeAssetUrl(cubemap[activeFace])
  const isMissing = !activeSrc || missingFaces[activeFace]

  useEffect(() => {
    setActiveFace("front")
    setMissingFaces({})
  }, [location?.id])

  return (
    <section className="pg-pano" aria-label="Панорама">
      <div className={`pg-pano-face pg-pano-face--${activeFace}`}>
        {!isMissing ? (
          <img src={activeSrc} alt={`${location?.title || "Панорама"} ${FACE_LABELS[activeFace]}`} onError={() => setMissingFaces((value) => ({ ...value, [activeFace]: true }))} />
        ) : (
          <div className="pg-pano-missing">
            <span>{FACE_LABELS[activeFace]}</span>
            <b>{location?.title || "Пепегессер"}</b>
            <small>Добавь кубмап: {activeFace}.webp</small>
          </div>
        )}
      </div>
      <div className="pg-face-tabs" role="tablist" aria-label="Стороны кубмапа">
        {FACE_IDS.map((face) => (
          <button
            key={face}
            type="button"
            className={face === activeFace ? "is-active" : ""}
            onClick={() => setActiveFace(face)}
          >
            {FACE_LABELS[face]}
          </button>
        ))}
      </div>
    </section>
  )
}

function buildPhotoSphereCubemap(location) {
  const cubemap = location?.cubemap || {}
  const paths = {
    left: pepeAssetUrl(cubemap.left),
    front: pepeAssetUrl(cubemap.front),
    right: pepeAssetUrl(cubemap.right),
    back: pepeAssetUrl(cubemap.back),
    top: pepeAssetUrl(cubemap.up),
    bottom: pepeAssetUrl(cubemap.down)
  }
  const missing = Object.entries(paths)
    .filter(([, value]) => !value)
    .map(([face]) => face)

  return { paths, missing }
}

async function preloadPanoramaLocation(location) {
  const { paths, missing } = buildPhotoSphereCubemap(location)
  if (missing.length) {
    return
  }
  await Promise.allSettled(Object.values(paths).map((path) => preloadTileImage(path)))
}

async function preloadRoundAssets(world, dimensionId, location) {
  const tasks = [preloadPanoramaLocation(location)]
  const manifestPath = getDimensionManifestPath(world, dimensionId)
  if (manifestPath) {
    tasks.push(fetchMapManifest(manifestPath)
      .then((manifest) => buildTileMeta(resolveManifestForDimension(manifest, world.id, dimensionId)))
      .then((tileMeta) => (tileMeta ? preloadMapTiles(tileMeta) : undefined))
      .catch(() => undefined))
  }
  await Promise.allSettled(tasks)
}

function PanoramaViewer({ location, defaultFov = DEFAULT_PEPEGUESSR_SETTINGS.fov, onReady }) {
  const hostRef = useRef(null)
  const [loadError, setLoadError] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [useFallback, setUseFallback] = useState(false)
  const cubemapKey = [
    readString(location?.cubemap?.left),
    readString(location?.cubemap?.front),
    readString(location?.cubemap?.right),
    readString(location?.cubemap?.back),
    readString(location?.cubemap?.up),
    readString(location?.cubemap?.down)
  ].join("|")
  const { paths, missing } = useMemo(() => buildPhotoSphereCubemap(location), [cubemapKey])
  const canRender = missing.length === 0

  useEffect(() => {
    if (!location?.id) {
      return
    }
    if (!canRender) {
      onReady?.()
    }
  }, [canRender, location?.id, onReady])

  useEffect(() => {
    setLoadError("")
    setUseFallback(false)
    setIsLoading(Boolean(location?.id && canRender))
    if (!hostRef.current || !canRender) {
      setIsLoading(false)
      setUseFallback(Boolean(location?.id))
      return undefined
    }

    const host = hostRef.current
    let disposed = false
    let frameId = 0
    let renderer = null
    let resizeObserver = null
      let cubeMesh = null
      let cubeGeometry = null
      let cubeMaterials = []
      let cubeTextures = []
    const clearHost = () => {
      while (host.firstChild) {
        host.firstChild.remove()
      }
    }

    try {
      clearHost()
      const scene = new Scene()
      const startFov = Math.max(42, Math.min(120, Number(defaultFov) || DEFAULT_PEPEGUESSR_SETTINGS.fov))
      const camera = new PerspectiveCamera(startFov, 1, 1, 1200)
      camera.rotation.order = "YXZ"
      const materialPaths = [paths.left, paths.right, paths.top, paths.bottom, paths.back, paths.front]

      renderer = new WebGLRenderer({ antialias: true, alpha: false })
      renderer.setClearColor(0x020503, 1)
      renderer.outputColorSpace = SRGBColorSpace
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
      host.appendChild(renderer.domElement)

      let dragging = false
      let lastX = 0
      let lastY = 0
      let yaw = 0
      let pitch = 0
      let fov = startFov
      const clampPitch = (value) => Math.max(-1.35, Math.min(1.35, value))
      const resize = () => {
        const width = Math.max(1, host.clientWidth || 1)
        const height = Math.max(1, host.clientHeight || 1)
        camera.aspect = width / height
        camera.updateProjectionMatrix()
        renderer?.setSize(width, height, false)
      }
      const render = () => {
        camera.rotation.y = yaw
        camera.rotation.x = pitch
        renderer?.render(scene, camera)
        frameId = window.requestAnimationFrame(render)
      }
      const updateFov = (nextFov) => {
        fov = Math.max(42, Math.min(120, nextFov))
        camera.fov = fov
        camera.updateProjectionMatrix()
      }
      const onPointerDown = (event) => {
        dragging = true
        lastX = event.clientX
        lastY = event.clientY
        host.setPointerCapture?.(event.pointerId)
      }
      const onPointerMove = (event) => {
        if (!dragging) {
          return
        }
        const dx = event.clientX - lastX
        const dy = event.clientY - lastY
        lastX = event.clientX
        lastY = event.clientY
        yaw += dx * 0.0021
        pitch = clampPitch(pitch + dy * 0.0021)
      }
      const stopDrag = (event) => {
        dragging = false
        host.releasePointerCapture?.(event.pointerId)
      }
      const onWheel = (event) => {
        event.preventDefault()
        updateFov(fov + event.deltaY * 0.06)
      }

      host.addEventListener("pointerdown", onPointerDown)
      host.addEventListener("pointermove", onPointerMove)
      host.addEventListener("pointerup", stopDrag)
      host.addEventListener("pointercancel", stopDrag)
      host.addEventListener("wheel", onWheel, { passive: false })
      resizeObserver = new ResizeObserver(resize)
      resizeObserver.observe(host)
      resize()
      render()

      const loader = new TextureLoader()
      loader.setCrossOrigin("anonymous")
      Promise.all(materialPaths.map((path, index) => new Promise((resolve, reject) => {
        loader.load(path, (texture) => {
          texture.colorSpace = SRGBColorSpace
          resolve(texture)
        }, undefined, reject)
      }))).then((textures) => {
        if (disposed) {
          textures.forEach((texture) => texture.dispose())
          return
        }
        cubeTextures = textures
        cubeGeometry = new BoxGeometry(1200, 1200, 1200).scale(1, 1, -1)
        cubeMaterials = textures.map((texture) => new MeshBasicMaterial({ map: texture, depthTest: false, depthWrite: false }))
        cubeMesh = new Mesh(cubeGeometry, cubeMaterials)
        scene.add(cubeMesh)
        setIsLoading(false)
        onReady?.()
      }).catch(() => {
        if (!disposed) {
          setLoadError("Panorama files failed to load.")
          setIsLoading(false)
          setUseFallback(true)
          onReady?.()
        }
      })

      return () => {
        disposed = true
        window.cancelAnimationFrame(frameId)
        resizeObserver?.disconnect()
        host.removeEventListener("pointerdown", onPointerDown)
        host.removeEventListener("pointermove", onPointerMove)
        host.removeEventListener("pointerup", stopDrag)
        host.removeEventListener("pointercancel", stopDrag)
        host.removeEventListener("wheel", onWheel)
        if (cubeMesh) {
          scene.remove(cubeMesh)
        }
        cubeMaterials.forEach((material) => material.dispose())
        cubeTextures.forEach((texture) => texture.dispose())
        cubeGeometry?.dispose()
        renderer?.dispose()
        clearHost()
      }
    } catch (error) {
      setLoadError("Panorama renderer failed.")
      setIsLoading(false)
      setUseFallback(true)
      onReady?.()
      return () => {
        disposed = true
        window.cancelAnimationFrame(frameId)
        resizeObserver?.disconnect()
        if (cubeMesh) {
          scene.remove(cubeMesh)
        }
        cubeMaterials.forEach((material) => material.dispose())
        cubeTextures.forEach((texture) => texture.dispose())
        cubeGeometry?.dispose()
        renderer?.dispose()
        clearHost()
      }
    }
  }, [canRender, location?.id, cubemapKey, onReady])

  return (
    <section className="pg-pano" aria-label="Panorama">
      {useFallback ? <CubeViewer location={location} /> : <div ref={hostRef} className="pg-pano-viewer" />}
      {isLoading ? (
        <div className="pg-pano-loading" aria-live="polite">
          <span />
          <b>Loading panorama</b>
        </div>
      ) : null}
      {!canRender || loadError ? (
        <div className="pg-pano-missing">
          <span>Panorama</span>
          <b>{location?.title || "PepeGuessr"}</b>
          <small>{loadError || `Missing cube faces: ${missing.join(", ")}`}</small>
          <small>Required: panorama_0..panorama_5</small>
        </div>
      ) : null}
    </section>
  )
}
function GuessMap({ world, dimensionId, guess, guessPlayer = null, playerGuesses = EMPTY_ARRAY, actual, actualMarkers = EMPTY_ARRAY, reveal, expanded, locked, onGuess, onSubmit, onInvalidSubmit, canSubmit, submitLabel, statusLabel, className = "", hideChrome = false, hideHeader = false, onReady }) {
  const hostRef = useRef(null)
  const mapRef = useRef(null)
  const layersRef = useRef({ tiles: null, guess: null, actual: null, line: null })
  const lockedRef = useRef(Boolean(locked))
  const onGuessRef = useRef(onGuess)
  const userChangedViewRef = useRef(false)
  const programmaticViewRef = useRef(false)
  const revealRef = useRef(Boolean(reveal))
  const mapViewKeyRef = useRef("")
  const mapLayoutKeyRef = useRef("")
  const revealViewKeyRef = useRef("")
  const revealInteractionCancelledRef = useRef(false)
  const [tileMeta, setTileMeta] = useState(null)
  const [stitchedMap, setStitchedMap] = useState("")
  const [tilesReady, setTilesReady] = useState(false)
  const [loadedTileSrcs, setLoadedTileSrcs] = useState(new Map())
  const [error, setError] = useState("")
  const [isActive, setIsActive] = useState(false)
  const [isPixelZoom, setIsPixelZoom] = useState(false)
  const isExpanded = Boolean(expanded || isActive)

  const fitMapBounds = useCallback((map, bounds, options = {}) => {
    programmaticViewRef.current = true
    map.fitBounds(bounds, options)
    window.setTimeout(() => {
      programmaticViewRef.current = false
    }, options.animate ? 420 : 80)
  }, [])

  useEffect(() => {
    lockedRef.current = Boolean(locked)
    onGuessRef.current = onGuess
    revealRef.current = Boolean(reveal)
  }, [locked, onGuess, reveal])

  useEffect(() => {
    let alive = true
    setError("")
    setTileMeta(null)
    setTilesReady(false)
    setLoadedTileSrcs(new Map())
    async function loadManifest() {
      try {
        const manifest = await fetchMapManifest(getDimensionManifestPath(world, dimensionId))
        if (!alive) {
          return
        }
        setTileMeta(buildTileMeta(resolveManifestForDimension(manifest, world.id, dimensionId)))
      } catch (loadError) {
        if (alive) {
          setTilesReady(true)
          onReady?.()
          setError(loadError instanceof Error ? loadError.message : "Карта не загрузилась")
        }
      }
    }
    if (getDimensionManifestPath(world, dimensionId)) {
      loadManifest()
    }
    return () => {
      alive = false
    }
  }, [world?.id, world?.manifestPath, world?.dimensions, dimensionId, onReady])

  useEffect(() => {
    let alive = true
    setTilesReady(false)
    setLoadedTileSrcs(new Map())
    if (!tileMeta) {
      return undefined
    }
    const readyFallback = window.setTimeout(() => {
      if (alive) {
        setTilesReady(true)
        onReady?.()
      }
    }, MAP_READY_TIMEOUT_MS)
    preloadMapTiles(tileMeta)
      .then((srcs) => {
        if (alive) {
          window.clearTimeout(readyFallback)
          setLoadedTileSrcs(srcs)
          setTilesReady(true)
          onReady?.()
        }
      })
      .catch(() => {
        if (alive) {
          window.clearTimeout(readyFallback)
          setError("Карта не загрузилась")
          setTilesReady(true)
          onReady?.()
        }
      })
    return () => {
      alive = false
      window.clearTimeout(readyFallback)
    }
  }, [onReady, tileMeta])

  useEffect(() => {
    let alive = true
    const useSourceTiles = !reveal || className.includes("pg-solo-result-map") || className.includes("pg-duel-map") || className.includes("pg-duel-result-map")
    setStitchedMap("")
    if (!tileMeta || useSourceTiles) {
      return undefined
    }
    buildStitchedMap(tileMeta)
      .then((src) => {
        if (alive) {
          setStitchedMap(src)
        }
      })
      .catch(() => {
        if (alive) {
          setError("Карта не склеилась")
        }
      })
    return () => {
      alive = false
    }
  }, [className, reveal, tileMeta])

  useEffect(() => {
    if (!hostRef.current || !tileMeta) {
      return
    }

    if (!mapRef.current) {
      mapRef.current = L.map(hostRef.current, {
        crs: L.CRS.Simple,
        zoomControl: true,
        attributionControl: false,
        preferCanvas: false,
        zoomSnap: 0.05,
        zoomDelta: 0.45,
        wheelPxPerZoomLevel: 36,
        doubleClickZoom: false,
        minZoom: -5,
        maxZoom: 12
      })
      mapRef.current.on("movestart zoomstart", () => {
        if (!programmaticViewRef.current) {
          userChangedViewRef.current = true
          if (revealRef.current) {
            revealInteractionCancelledRef.current = true
          }
        }
      })
      layersRef.current.tiles = L.layerGroup().addTo(mapRef.current)
      layersRef.current.guess = L.layerGroup().addTo(mapRef.current)
      layersRef.current.actual = L.layerGroup().addTo(mapRef.current)
      layersRef.current.line = L.layerGroup().addTo(mapRef.current)
    }

    const map = mapRef.current
    const syncPixelZoom = () => {
      setIsPixelZoom(map.getZoom() >= 0)
    }
    syncPixelZoom()
    map.on("zoomend", syncPixelZoom)
    const mapViewKey = `${dimensionId}:${tileMeta.width}:${tileMeta.height}`
    const isNewMapView = mapViewKeyRef.current !== mapViewKey
    const mapLayoutKey = `${mapViewKey}:${isExpanded ? "expanded" : "compact"}`
    const isNewMapLayout = mapLayoutKeyRef.current !== mapLayoutKey
    if (isNewMapView) {
      mapViewKeyRef.current = mapViewKey
      userChangedViewRef.current = false
    }
    if (isNewMapLayout) {
      mapLayoutKeyRef.current = mapLayoutKey
    }
    layersRef.current.tiles.clearLayers()
    const bounds = L.latLngBounds([[0, 0], [tileMeta.height, tileMeta.width]])
    const useSourceTiles = !reveal || className.includes("pg-solo-result-map") || className.includes("pg-duel-map") || className.includes("pg-duel-result-map")
    const canShowMapTiles = useSourceTiles ? tilesReady : Boolean(stitchedMap)
    if (stitchedMap && !useSourceTiles) {
      L.imageOverlay(stitchedMap, bounds, { className: "pg-map-tile pg-map-stitched" }).addTo(layersRef.current.tiles)
    }
    if (canShowMapTiles && (!stitchedMap || useSourceTiles)) {
      tileMeta.tiles.forEach((tile) => {
        const tileSrc = loadedTileSrcs.get(tile.id)
        const tileCandidates = Array.isArray(tile.srcCandidates) && tile.srcCandidates.length ? tile.srcCandidates : [tile.src]
        if (!tileSrc || !tileCandidates.includes(tileSrc)) {
          return
        }
        L.imageOverlay(tileSrc, tile.bounds, { className: "pg-map-tile pg-map-source-tile" }).addTo(layersRef.current.tiles)
      })
    }
    map.setMaxBounds(bounds.pad(0.2))
    if (isNewMapView || !userChangedViewRef.current) {
      fitMapBounds(map, bounds, { animate: false, padding: [24, 24] })
    }
    map.off("click")
    map.on("click", (event) => {
      if (lockedRef.current || typeof onGuessRef.current !== "function") {
        return
      }
      onGuessRef.current(latLngToMinecraft(event.latlng, tileMeta))
    })
    window.setTimeout(() => {
      map.invalidateSize({ pan: false })
    }, 0)

    return () => {
      map.off("click")
      map.off("zoomend", syncPixelZoom)
    }
  }, [className, dimensionId, fitMapBounds, isExpanded, loadedTileSrcs, reveal, tileMeta, tilesReady, stitchedMap])

  useEffect(() => {
    if (!mapRef.current || !tileMeta) {
      return undefined
    }
    let frameId = 0
    const timers = []
    const invalidate = () => {
      const map = mapRef.current
      if (!map) {
        return
      }
      map.invalidateSize({ pan: false })
      if (!reveal && !userChangedViewRef.current) {
        const bounds = L.latLngBounds([[0, 0], [tileMeta.height, tileMeta.width]])
        fitMapBounds(map, bounds, { animate: false, padding: [24, 24] })
      }
    }
    frameId = window.requestAnimationFrame(invalidate)
    timers.push(window.setTimeout(invalidate, 200))
    timers.push(window.setTimeout(invalidate, 700))
    return () => {
      window.cancelAnimationFrame(frameId)
      timers.forEach((timer) => window.clearTimeout(timer))
    }
  }, [dimensionId, fitMapBounds, isExpanded, locked, reveal, stitchedMap, tileMeta])

  useEffect(() => {
    const handleSubmitHotkey = (event) => {
      if (event.code !== "Space" || event.repeat || typeof onSubmit !== "function") {
        return
      }
      const target = event.target
      const tagName = target?.tagName?.toLowerCase()
      if (tagName === "input" || tagName === "textarea" || tagName === "select" || target?.isContentEditable) {
        return
      }
      event.preventDefault()
      if (canSubmit) {
        onSubmit()
      } else {
        onInvalidSubmit?.()
      }
    }

    window.addEventListener("keydown", handleSubmitHotkey)
    return () => {
      window.removeEventListener("keydown", handleSubmitHotkey)
    }
  }, [canSubmit, onInvalidSubmit, onSubmit])

  useEffect(() => {
    if (!mapRef.current || !tileMeta) {
      return
    }
    const { guess: guessLayer, actual: actualLayer, line: lineLayer } = layersRef.current
    guessLayer.clearLayers()
    actualLayer.clearLayers()
    lineLayer.clearLayers()

    const points = []
    const revealGuesses = Array.isArray(playerGuesses) ? playerGuesses : []
    if (guess) {
      const guessLatLng = minecraftToLatLng(guess, tileMeta)
      const avatarSrc = getProfileAvatarUrl(guessPlayer, 34)
      const fallback = readString(guessPlayer?.displayName || guessPlayer?.name || "?").slice(0, 1).toUpperCase()
      points.push(guessLatLng)
      L.marker(guessLatLng, {
        icon: avatarSrc
          ? L.divIcon({
              className: "pg-player-guess-pin pg-player-guess-pin--self",
              html: `<img src="${escapeHtml(avatarSrc)}" alt="">`,
              iconSize: [38, 38],
              iconAnchor: [19, 19]
            })
          : L.divIcon({
              className: "pg-guess-pin",
              html: fallback ? `<span>${escapeHtml(fallback)}</span>` : "<span></span>",
              iconSize: [28, 28],
              iconAnchor: [14, 14]
            })
      }).addTo(guessLayer)
    }
    revealGuesses.forEach((entry, index) => {
      if (!entry?.guess) {
        return
      }
      const playerGuessLatLng = minecraftToLatLng(entry.guess, tileMeta)
      const avatarSrc = getProfileAvatarUrl(entry.player)
      const fallback = readString(entry.player?.displayName || entry.player?.name || "?").slice(0, 1).toUpperCase()
      points.push(playerGuessLatLng)
      L.marker(playerGuessLatLng, {
        icon: L.divIcon({
          className: `pg-player-guess-pin pg-player-guess-pin--${index % 2}`,
          html: avatarSrc ? `<img src="${escapeHtml(avatarSrc)}" alt="">` : `<span>${escapeHtml(fallback)}</span>`,
          iconSize: [38, 38],
          iconAnchor: [19, 19]
        })
      }).addTo(guessLayer)
    })
    const revealActuals = Array.isArray(actualMarkers) ? actualMarkers : []
    revealActuals.forEach((entry, index) => {
      const markerLocation = entry?.location || entry
      if (!markerLocation) {
        return
      }
      const actualLatLng = minecraftToLatLng(markerLocation, tileMeta)
      points.push(actualLatLng)
      L.marker(actualLatLng, {
        icon: L.divIcon({
          className: "pg-actual-pin pg-actual-pin--multi",
          html: `<span>${escapeHtml(readString(entry?.label) || String(index + 1))}</span>`,
          iconSize: [34, 34],
          iconAnchor: [17, 17]
        })
      }).addTo(actualLayer)
    })
    if (reveal && actual) {
      const actualLatLng = minecraftToLatLng(actual, tileMeta)
      points.push(actualLatLng)
      L.marker(actualLatLng, {
        icon: L.divIcon({ className: "pg-actual-pin", html: "<span></span>", iconSize: [32, 32], iconAnchor: [16, 16] })
      }).addTo(actualLayer)
      if (guess) {
        L.polyline([minecraftToLatLng(guess, tileMeta), actualLatLng], { color: "#ffe66d", weight: 3, opacity: 0.9, dashArray: "8 8" }).addTo(lineLayer)
      }
      revealGuesses.forEach((entry, index) => {
        if (!entry?.guess) {
          return
        }
        L.polyline([minecraftToLatLng(entry.guess, tileMeta), actualLatLng], {
          color: index % 2 ? "#67d7ff" : "#ffb24d",
          weight: 3,
          opacity: 0.9,
          dashArray: "8 8"
        }).addTo(lineLayer)
      })
    }
    revealGuesses.forEach((entry, index) => {
      if (!entry?.guess || !entry?.actual) {
        return
      }
      L.polyline([minecraftToLatLng(entry.guess, tileMeta), minecraftToLatLng(entry.actual, tileMeta)], {
        color: index % 2 ? "#67d7ff" : "#ffb24d",
        weight: 3,
        opacity: 0.9,
        dashArray: "8 8"
      }).addTo(lineLayer)
    })

    if (points.length > 1) {
      const pointsBounds = L.latLngBounds(points)
      const revealKey = `${reveal ? "1" : "0"}:${className}:${actual?.x ?? ""}:${actual?.z ?? ""}:${guess?.x ?? ""}:${guess?.z ?? ""}:${revealGuesses.map((entry) => `${entry?.player?.id || ""}:${entry?.guess?.x ?? ""}:${entry?.guess?.z ?? ""}:${entry?.actual?.x ?? ""}:${entry?.actual?.z ?? ""}`).join("|")}:${revealActuals.map((entry) => `${entry?.location?.x ?? entry?.x ?? ""}:${entry?.location?.z ?? entry?.z ?? ""}`).join("|")}`
      const shouldRevealFit = reveal && revealViewKeyRef.current !== revealKey
      if (shouldRevealFit) {
        revealViewKeyRef.current = revealKey
        userChangedViewRef.current = false
        revealInteractionCancelledRef.current = false
      }
      const fitToPoints = () => {
        const map = mapRef.current
        if (!map || revealInteractionCancelledRef.current || userChangedViewRef.current) {
          return
        }
        map.invalidateSize({ pan: false })
        if (className.includes("pg-solo-result-map") || className.includes("pg-duel-result-map")) {
          const center = pointsBounds.getCenter()
          const minSpan = Math.min(tileMeta.width, tileMeta.height) * (className.includes("pg-duel-result-map") ? 0.032 : 0.038)
          const latSpan = Math.max(Math.abs(pointsBounds.getNorth() - pointsBounds.getSouth()), minSpan)
          const lngSpan = Math.max(Math.abs(pointsBounds.getEast() - pointsBounds.getWest()), minSpan)
          const resultBounds = L.latLngBounds(
            [center.lat - latSpan / 2, center.lng - lngSpan / 2],
            [center.lat + latSpan / 2, center.lng + lngSpan / 2]
          )
          fitMapBounds(map, resultBounds.pad(className.includes("pg-duel-result-map") ? 0.06 : 0.05), { animate: true })
        } else {
          fitMapBounds(map, pointsBounds.pad(0.55), { animate: true })
        }
      }
      if (shouldRevealFit || !userChangedViewRef.current) {
        fitToPoints()
      }
      if (shouldRevealFit) {
        window.requestAnimationFrame(fitToPoints)
        window.setTimeout(fitToPoints, 220)
        window.setTimeout(fitToPoints, 520)
      }
    }
  }, [actual, actualMarkers, className, fitMapBounds, guess, guessPlayer, playerGuesses, reveal, tileMeta])

  useEffect(() => () => {
    if (mapRef.current) {
      mapRef.current.remove()
      mapRef.current = null
    }
  }, [])

  return (
    <section
      className={`pg-map-panel${className ? ` ${className}` : ""}${isExpanded ? " is-expanded" : ""}${hideChrome ? " is-chromeless" : ""}${hideHeader ? " is-headless" : ""}${!tilesReady ? " is-map-loading" : ""}${isPixelZoom ? " is-pixel-zoom" : ""}`}
      onPointerEnter={() => setIsActive(true)}
      onPointerLeave={() => {
        if (!expanded) {
          setIsActive(false)
        }
      }}
      onFocus={() => setIsActive(true)}
      onBlur={() => {
        if (!expanded) {
          setIsActive(false)
        }
      }}
    >
      {!hideHeader ? (
      <div className="pg-map-head">
        <b>Карта</b>
        <span>{statusLabel || (guess ? "\u041c\u0435\u0442\u043a\u0430 \u043f\u043e\u0441\u0442\u0430\u0432\u043b\u0435\u043d\u0430" : "\u041f\u043e\u0441\u0442\u0430\u0432\u044c \u043c\u0435\u0442\u043a\u0443")}</span>
      </div>
      ) : null}
      <div ref={hostRef} className="pg-map" />
      {onSubmit && !hideChrome ? (
        <button
          type="button"
          className="pg-map-submit"
          onClick={() => {
            if (canSubmit) {
              onSubmit()
            } else {
              onInvalidSubmit?.()
            }
          }}
          aria-disabled={!canSubmit}
        >
          {submitLabel || "Submit"}
        </button>
      ) : null}
      {error ? <p className="pg-map-error">{error}</p> : null}
    </section>
  )
}

function WorldPicker({ catalog, worldId, dimensionId, onWorldId, onDimensionId }) {
  const worlds = Array.isArray(catalog?.worlds) ? catalog.worlds : []
  const world = worldId === MIXED_WORLD_ID ? worlds[0] : worlds.find((item) => item.id === worldId) || worlds[0]
  const dimensions = Array.isArray(world?.dimensions) ? world.dimensions.filter((item) => item.enabled) : []

  useEffect(() => {
    if (world && !dimensions.some((item) => item.id === dimensionId)) {
      onDimensionId(dimensions[0]?.id || "overworld")
    }
  }, [dimensionId, dimensions, onDimensionId, world])

  return (
    <div className="pg-picker">
      <label>
        <span>Мир</span>
        <select value={worldId} onChange={(event) => onWorldId(event.target.value)}>
          <option value={MIXED_WORLD_ID}>Mix MP1 / MP2</option>
          {worlds.map((item) => (
            <option key={item.id} value={item.id}>{item.label || item.id}</option>
          ))}
        </select>
      </label>
      <label>
        <span>Измерение</span>
        <select value={dimensionId} onChange={(event) => onDimensionId(event.target.value)}>
          {dimensions.map((item) => (
            <option key={item.id} value={item.id}>{item.label || item.id}</option>
          ))}
        </select>
      </label>
    </div>
  )
}

function ProfilePanel({ me, profileId = "", onProfileUpdated, onError }) {
  const ownProfileId = readString(me?.profile?.id)
  const viewedProfileId = readString(profileId) || ownProfileId
  const [publicProfile, setPublicProfile] = useState(null)
  const [history, setHistory] = useState([])
  const [loadingProfile, setLoadingProfile] = useState(false)
  const viewedProfile = !profileId && me?.profile ? me.profile : publicProfile
  const stats = viewedProfile?.stats || {}
  const canEdit = Boolean(me?.authenticated && ownProfileId && viewedProfile?.id === ownProfileId)
  const [minecraftName, setMinecraftName] = useState(me?.profile?.minecraftName || "")
  const [profileCoverColor, setProfileCoverColor] = useState(me?.profile?.profileCoverColor || PROFILE_COVER_COLORS[0])
  const [profileCoverColor2, setProfileCoverColor2] = useState(me?.profile?.profileCoverColor2 || me?.profile?.profileCoverColor || PROFILE_COVER_COLORS[0])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [copied, setCopied] = useState(false)
  const [inviteNotice, setInviteNotice] = useState("")
  const registeredAt = viewedProfile?.createdAt
    ? new Date(viewedProfile.createdAt).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" })
    : ""
  const matchesPlayed = Number(stats.matchesPlayed) || 0
  const wins = Number(stats.wins) || 0
  const losses = Number(stats.losses) || Math.max(0, matchesPlayed - wins)
  const totalGuesses = Number(stats.totalGuesses) || 0
  const totalScore = Number(stats.totalScore) || 0
  const totalDistance = Number(stats.totalDistance) || 0
  const accuracy = totalGuesses > 0 ? Math.round(Math.max(0, Math.min(100, (totalScore / (totalGuesses * 5000)) * 100))) : 0
  const averageError = totalGuesses > 0 ? Math.round(totalDistance / totalGuesses) : 0
  const viewedProfileOnline = Boolean(viewedProfile?.online)
  const canInvite = Boolean(me?.authenticated && viewedProfile?.id && viewedProfile.id !== ownProfileId && viewedProfileOnline)
  const activeProfileCoverColor = readString(viewedProfile?.profileCoverColor) || PROFILE_COVER_COLORS[0]
  const activeProfileCoverColor2 = readString(viewedProfile?.profileCoverColor2) || activeProfileCoverColor
  const discordName = readString(viewedProfile?.discordUsername || viewedProfile?.username || viewedProfile?.displayName).replace(/^@+/, "")
  const hasBoosty = Boolean(viewedProfile?.boostyActive || viewedProfile?.subscription?.boosty)

  useEffect(() => {
    setMinecraftName(me?.profile?.minecraftName || "")
  }, [me?.profile?.minecraftName])

  useEffect(() => {
    setProfileCoverColor(me?.profile?.profileCoverColor || PROFILE_COVER_COLORS[0])
    setProfileCoverColor2(me?.profile?.profileCoverColor2 || me?.profile?.profileCoverColor || PROFILE_COVER_COLORS[0])
  }, [me?.profile?.profileCoverColor, me?.profile?.profileCoverColor2])

  useEffect(() => {
    let alive = true
    setPublicProfile(null)
    setHistory([])
    if (!viewedProfileId) {
      return undefined
    }
    const refreshProfile = (showLoading = false) => {
      if (showLoading) setLoadingProfile(true)
      return fetchJson(pepeApi(`profiles/${encodeURIComponent(viewedProfileId)}`))
        .then((payload) => {
          if (!alive) return
          setPublicProfile(payload.profile || null)
          setHistory(Array.isArray(payload.history) ? payload.history : [])
        })
        .catch((error) => {
          if (alive && showLoading) onError(error.message)
        })
        .finally(() => {
          if (alive && showLoading) setLoadingProfile(false)
        })
    }
    refreshProfile(true)
    const interval = window.setInterval(() => refreshProfile(false), PROFILE_PRESENCE_INTERVAL_MS)
    return () => {
      alive = false
      window.clearInterval(interval)
    }
  }, [onError, viewedProfileId])

  const saveMinecraftName = useCallback(async (event) => {
    event.preventDefault()
    setSaving(true)
    try {
      const payload = await fetchJson(pepeApi("profile"), {
        method: "PATCH",
        body: JSON.stringify({ minecraftName, profileCoverColor, profileCoverColor2 })
      })
      onProfileUpdated(payload.profile)
      setPublicProfile(payload.profile)
    } catch (error) {
      onError(error.message)
    } finally {
      setSaving(false)
    }
  }, [minecraftName, onError, onProfileUpdated, profileCoverColor, profileCoverColor2])

  const copyProfileLink = useCallback(async () => {
    if (!viewedProfile?.id) return
    const href = `${window.location.origin}${getPepeGuessrProfilePath(viewedProfile)}`
    try {
      await navigator.clipboard?.writeText(href)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      onError("Не получилось скопировать ссылку")
    }
  }, [onError, viewedProfile])

  const requestDuelInvite = useCallback(() => {
    setInviteNotice("Инвайты появятся сверху, когда подключим онлайн-статус игрока.")
  }, [])

  return (
    <section className="pg-profile-page">
      {viewedProfile ? (
        <div className="pg-profile-layout">
          <article className="pg-profile-card">
            <div
              className="pg-profile-cover"
              style={{
                "--pg-profile-cover": activeProfileCoverColor,
                "--pg-profile-cover-2": activeProfileCoverColor2
              }}
            >
              <div className="pg-profile-cover-glow" />
              <div className="pg-profile-cover-shade" />
              <div className="pg-profile-identity">
                {getProfileAvatarUrl(viewedProfile, 92) ? <img src={getProfileAvatarUrl(viewedProfile, 92)} alt="" /> : <span className="pg-avatar-fallback" />}
                <div>
                  <h2 className={hasBoosty ? "pg-profile-name--boosty" : ""}>{viewedProfile.displayName}<ProfileBadges badges={viewedProfile.badges} compact /></h2>
                </div>
              </div>
            </div>
            <div className="pg-profile-meta">
              <span className={`pg-profile-presence${viewedProfileOnline ? " is-online" : ""}`}>
                <i aria-hidden="true" />
                {viewedProfileOnline ? "Онлайн" : "Офлайн"}
              </span>
              {discordName ? <span>@{discordName}</span> : null}
              {registeredAt ? <span>С нами с {registeredAt}</span> : null}
            </div>
            <dl className="pg-profile-stats-list">
              <div><dt>Матчей:</dt><dd>{matchesPlayed}</dd></div>
              <div><dt>Рекорд:</dt><dd>{stats.longestDuelRounds || 0} раундов</dd></div>
              <div><dt>Точность:</dt><dd>{accuracy}%</dd></div>
              <div><dt>Побед:</dt><dd>{wins}</dd></div>
              <div><dt>Поражений:</dt><dd>{losses}</dd></div>
              <div><dt>Средняя ошибка:</dt><dd>{averageError} блоков</dd></div>
            </dl>
            <div className="pg-profile-card-actions">
              {canEdit ? <button type="button" className="pg-primary" onClick={() => setSettingsOpen(true)}>Настройки профиля</button> : null}
              <button type="button" className="pg-primary" onClick={copyProfileLink}>{copied ? "Скопировано" : "Скопировать ссылку на профиль"}</button>
              {me?.authenticated && viewedProfile?.id && viewedProfile.id !== ownProfileId ? (
                <button
                  type="button"
                  className="pg-primary pg-profile-invite"
                  onClick={requestDuelInvite}
                  disabled={!canInvite}
                >
                  {canInvite ? "Вызвать на дуэль" : "Игрок офлайн"}
                </button>
              ) : null}
            </div>
            {inviteNotice ? <p className="pg-profile-note">{inviteNotice}</p> : null}
            {settingsOpen ? (
              <div className="pg-profile-settings-backdrop" role="presentation" onMouseDown={(event) => {
                if (event.target === event.currentTarget) setSettingsOpen(false)
              }}>
                <form className="pg-profile-settings-modal" onSubmit={saveMinecraftName}>
                  <div className="pg-profile-settings-head">
                    <div>
                      <h3>Настройки профиля</h3>
                      <p>{discordName ? `@${discordName}` : "Аккаунт подключен"}</p>
                    </div>
                    <button type="button" onClick={() => setSettingsOpen(false)} aria-label="Закрыть">x</button>
                  </div>
                  <label>
                    <span>Minecraft ник</span>
                    <input
                      value={minecraftName}
                      onChange={(event) => setMinecraftName(event.target.value.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 16))}
                      placeholder="MinecraftNick"
                      minLength={1}
                      maxLength={16}
                    />
                  </label>
                  <div className="pg-profile-color-field">
                    <span>Первый цвет фона</span>
                    <div className="pg-profile-color-picker" aria-label="Цвет фона профиля">
                      {PROFILE_COVER_COLORS.map((color) => (
                        <button
                          type="button"
                          className={`pg-profile-color-swatch${profileCoverColor === color ? " is-active" : ""}`}
                          style={{ "--profile-color": color }}
                          onClick={() => setProfileCoverColor(color)}
                          aria-label={`Цвет ${color}`}
                          key={color}
                        />
                      ))}
                    </div>
                    <label className="pg-profile-custom-color">
                      <span>Свой цвет</span>
                      <input
                        type="color"
                        value={/^#[0-9a-fA-F]{6}$/.test(profileCoverColor) ? profileCoverColor : PROFILE_COVER_COLORS[0]}
                        onChange={(event) => setProfileCoverColor(event.target.value)}
                      />
                    </label>
                  </div>
                  <div className="pg-profile-color-field">
                    <span>Второй цвет фона</span>
                    <div className="pg-profile-color-picker" aria-label="Второй цвет фона профиля">
                      {PROFILE_COVER_COLORS.map((color) => (
                        <button
                          type="button"
                          className={`pg-profile-color-swatch${profileCoverColor2 === color ? " is-active" : ""}`}
                          style={{ "--profile-color": color }}
                          onClick={() => setProfileCoverColor2(color)}
                          aria-label={`Второй цвет ${color}`}
                          key={color}
                        />
                      ))}
                    </div>
                    <label className="pg-profile-custom-color">
                      <span>Свой цвет</span>
                      <input
                        type="color"
                        value={/^#[0-9a-fA-F]{6}$/.test(profileCoverColor2) ? profileCoverColor2 : PROFILE_COVER_COLORS[0]}
                        onChange={(event) => setProfileCoverColor2(event.target.value)}
                      />
                    </label>
                  </div>
                  <div className={`pg-profile-boosty-box${hasBoosty ? " is-active" : ""}`}>
                    <b>Boosty оформление</b>
                    <p>{hasBoosty ? "Доступен переливающийся текст и своя фоновая картинка." : "С подпиской Boosty можно будет включить переливающийся текст и загрузить свою картинку фона."}</p>
                    <button type="button" disabled={!hasBoosty}>Загрузить фон</button>
                  </div>
                  <div className="pg-profile-settings-actions">
                    <a className="pg-secondary" href={discordLoginUrl(getPepeGuessrProfilePath(viewedProfile))}>Перепривязать Discord</a>
                    <button type="button" className="pg-danger" onClick={() => setSettingsOpen(false)}>Отмена</button>
                    <button type="submit" className="pg-primary" disabled={saving}>{saving ? "..." : "Сохранить"}</button>
                  </div>
                </form>
              </div>
            ) : null}
          </article>
          <section className="pg-match-history">
            <h3>{"\u0418\u0441\u0442\u043E\u0440\u0438\u044F \u0438\u0433\u0440:"}</h3>
            {history.length ? (
              <div className="pg-match-history-list">
                {history.map((match) => {
                  const players = Array.isArray(match.players) ? match.players.slice(0, 2) : []
                  const leftPlayer = players[0] || null
                  const rightPlayer = players[1] || null
                  return (
                  <article className={`pg-match-history-card pg-match-history-card--${match.result || "draw"}`} key={match.id}>
                    <b>{match.result === "win" ? "\u041F\u043E\u0431\u0435\u0434\u0430" : match.result === "loss" ? "\u041F\u043E\u0440\u0430\u0436\u0435\u043D\u0438\u0435" : "\u041D\u0438\u0447\u044C\u044F"}</b>
                    <span>{match.roundCount || 0} {"\u0440\u0430\u0443\u043D\u0434\u043E\u0432"}</span>
                    <small>{match.finishedAt ? new Date(match.finishedAt).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit" }) : ""}</small>
                    <div>
                      <a href={getPepeGuessrProfilePath(leftPlayer)} aria-label={getProfileDisplayName(leftPlayer)}>
                        <span>{getProfileDisplayName(leftPlayer)}</span>
                        {getProfileAvatarUrl(leftPlayer, 32) ? <img src={getProfileAvatarUrl(leftPlayer, 32)} alt="" /> : <i />}
                      </a>
                      <a href={getPepeGuessrProfilePath(rightPlayer)} aria-label={getProfileDisplayName(rightPlayer)}>
                        {getProfileAvatarUrl(rightPlayer, 32) ? <img src={getProfileAvatarUrl(rightPlayer, 32)} alt="" /> : <i />}
                        <span>{getProfileDisplayName(rightPlayer)}</span>
                      </a>
                    </div>
                  </article>
                  )
                })}
              </div>
            ) : (
              <p className="pg-match-history-empty">{loadingProfile ? "\u0413\u0440\u0443\u0437\u0438\u043C..." : "\u0418\u0441\u0442\u043E\u0440\u0438\u0438 \u043F\u043E\u043A\u0430 \u043D\u0435\u0442"}</p>
            )}
          </section>
        </div>
      ) : !viewedProfileId ? (
        <div className="pg-empty-profile">
          <p>{"\u0412\u043E\u0439\u0434\u0438 \u0447\u0435\u0440\u0435\u0437 Discord, \u0447\u0442\u043E\u0431\u044B \u0441\u043E\u0445\u0440\u0430\u043D\u044F\u0442\u044C \u0441\u0442\u0430\u0442\u0438\u0441\u0442\u0438\u043A\u0443 \u0438 \u0438\u0433\u0440\u0430\u0442\u044C 1v1."}</p>
        <a href={discordLoginUrl(PEPEGUESSR_ROUTE_PATHS.profile)}>{"\u0412\u043E\u0439\u0442\u0438 \u0447\u0435\u0440\u0435\u0437 Discord"}</a>
        </div>
      ) : (
        <section className="pg-loading">{loadingProfile ? "\u0417\u0430\u0433\u0440\u0443\u0437\u043A\u0430..." : "\u041F\u0440\u043E\u0444\u0438\u043B\u044C \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D"}</section>
      )}
    </section>
  )
}
function LoginPanel({ me }) {
  if (me?.authenticated) {
    return (
      <section className="pg-mode-card">
        <h2>Discord подключен</h2>
        <p>Профиль Пепегессера уже привязан. Теперь можно создавать и продолжать 1v1 комнаты.</p>
        <a className="pg-primary pg-link-button" href={PEPEGUESSR_ROUTE_PATHS.training}>Вернуться в игру</a>
      </section>
    )
  }

  return (
    <section className="pg-mode-card">
      <h2>Вход в Пепегессер</h2>
      <p>Discord нужен для профиля, сохранения статистики и батлов 1v1. Solo можно запускать без входа.</p>
      <a className="pg-primary pg-link-button" href={discordLoginUrl(PEPEGUESSR_ROUTE_PATHS.training)}>Войти через Discord</a>
    </section>
  )
}

function ErrorScreen({ type = "404", onHome }) {
  const isServerDown = type === "405"
  return (
    <section className="pg-error-page" aria-label={isServerDown ? "Сервер не отвечает" : "Страница не найдена"}>
      <article className="pg-error-card">
        <div className="pg-error-code" aria-hidden="true">{isServerDown ? "405" : "404"}</div>
        <img src={isServerDown ? ERROR_405_ASSET : ERROR_404_ASSET} alt="" />
        <h1>{isServerDown ? "Сервер не отвечает,\nпопробуй позже." : "Неизвестное место,\nя не знаю где ты."}</h1>
        <button type="button" className="pg-primary" onClick={onHome}>Вернуться на главную</button>
      </article>
    </section>
  )
}

function formatSoloRoundTitle(index) {
  const titles = [
    "\u041f\u0435\u0440\u0432\u044b\u0439 \u0440\u0430\u0443\u043d\u0434",
    "\u0412\u0442\u043e\u0440\u043e\u0439 \u0440\u0430\u0443\u043d\u0434",
    "\u0422\u0440\u0435\u0442\u0438\u0439 \u0440\u0430\u0443\u043d\u0434",
    "\u0427\u0435\u0442\u0432\u0435\u0440\u0442\u044b\u0439 \u0440\u0430\u0443\u043d\u0434",
    "\u041f\u044f\u0442\u044b\u0439 \u0440\u0430\u0443\u043d\u0434"
  ]
  return titles[index] || `\u0420\u0430\u0443\u043d\u0434 ${index + 1}`
}

function getSoloPlayerName(me) {
  return me?.profile?.minecraftName || me?.profile?.displayName || "Игрок"
}

function SoloPlayerBadge({ me, score }) {
  if (!me?.authenticated || !me?.profile) {
    return null
  }
  const name = getSoloPlayerName(me)
  const avatarSrc = getProfileAvatarUrl(me.profile)
  return (
    <section className="pg-solo-player-badge">
      {avatarSrc ? <img src={avatarSrc} alt="" /> : <span className="pg-solo-avatar-fallback" />}
      <div className="pg-solo-player-name">
        <b>{name}</b>
        <ProfileBadges badges={me.profile.badges} compact />
      </div>
      <span>{"\u0412\u0441\u0435\u0433\u043e \u0431\u0430\u043b\u043b\u043e\u0432:"}</span>
      <strong>{score}</strong>
    </section>
  )
}

function DuelPlayerAvatar({ player }) {
  const avatarSrc = getProfileAvatarUrl(player)
  return avatarSrc ? <img className="pg-player-avatar" src={avatarSrc} alt="" /> : <span className="pg-player-avatar pg-solo-avatar-fallback" />
}

function DuelIntroPlayer({ player, side, fallbackName }) {
  const bodySrc = minecraftBodyRenderUrl(player?.minecraftName)
  const avatarSrc = getProfileAvatarUrl(player, 96)
  const name = player?.displayName || player?.minecraftName || fallbackName
  if (!player) {
    return (
      <section className={`pg-duel-intro-player pg-duel-intro-player--${side} is-searching`}>
        <div className="pg-duel-intro-render is-searching">
          <i />
          <i />
          <i />
        </div>
        <div className="pg-duel-intro-name">
          <b>{fallbackName}</b>
        </div>
      </section>
    )
  }

  return (
    <section className={`pg-duel-intro-player pg-duel-intro-player--${side}`}>
      <div className={`pg-duel-intro-render${bodySrc ? "" : " is-avatar"}`}>
        {bodySrc ? (
          <img src={bodySrc} alt="" loading="eager" />
        ) : avatarSrc ? (
          <img src={avatarSrc} alt="" loading="eager" />
        ) : (
          <span className="pg-player-avatar pg-solo-avatar-fallback" />
        )}
      </div>
      <div className="pg-duel-intro-name">
        <b>{name}</b>
        <ProfileBadges badges={player?.badges} compact />
      </div>
    </section>
  )
}

function DuelIntroOverlay({ leftPlayer, rightPlayer, panoramaReady, mapReady, roundIndex = 0, countdownNumber = 0, readySent = false }) {
  const roundTitle = roundIndex <= 0 ? "\u041F\u0435\u0440\u0432\u044B\u0439 \u0440\u0430\u0443\u043D\u0434" : `\u0420\u0430\u0443\u043D\u0434 ${roundIndex + 1}`
  const assetsReady = Boolean(panoramaReady && mapReady)
  const hasOpponent = Boolean(rightPlayer)
  const statusText = countdownNumber
    ? "\u0421\u0442\u0430\u0440\u0442 \u0447\u0435\u0440\u0435\u0437"
    : !hasOpponent
      ? "Поиск соперника"
    : readySent
      ? "\u0416\u0434\u0435\u043c \u0441\u043e\u043f\u0435\u0440\u043d\u0438\u043a\u0430"
      : assetsReady
        ? "\u0413\u043e\u0442\u043e\u0432\u043e"
        : "Загрузка"
  return (
    <div className="pg-duel-intro" aria-live="polite">
      <DuelIntroPlayer player={leftPlayer} side="left" fallbackName="Player 1" />
      <div className="pg-duel-intro-center">
        <img src="/pepe-brand-icon.svg" alt="" />
        <span>{roundTitle}</span>
        {countdownNumber ? <strong className="pg-duel-intro-countdown">{countdownNumber}</strong> : null}
        <small className="pg-duel-intro-status">{statusText}</small>
      </div>
      <DuelIntroPlayer player={rightPlayer} side="right" fallbackName={rightPlayer ? "Player 2" : "\u041F\u043E\u0438\u0441\u043A"} />
    </div>
  )
}

function DuelPlayerCard({ player, fallbackName, side, isReveal }) {
  const hp = player?.hp ?? 6000
  const maxHp = player?.maxHp || 6000
  const damage = Math.round(Number(player?.lastDamage) || 0)
  return (
    <section className={`pg-player-card pg-player-card--${side}`}>
      <DuelPlayerAvatar player={player} />
      <div className="pg-player-card-title">
        <div className="pg-player-name">
          {player?.id ? (
            <a href={getPepeGuessrProfilePath(player)}>{player?.displayName || fallbackName}</a>
          ) : (
            <b>{player?.displayName || fallbackName}</b>
          )}
          <ProfileBadges badges={player?.badges} compact />
        </div>
        <span>{hp} HP{player?.hasGuessed && !isReveal ? " / \u0433\u043e\u0442\u043e\u0432" : ""}</span>
      </div>
      <div className="pg-score-track" aria-hidden="true">
        <i style={{ width: `${Math.max(0, Math.min(100, ((hp / maxHp) * 100)))}%` }} />
      </div>
      {isReveal && damage > 0 ? <em className={`pg-damage-pop pg-damage-pop--${side}`}>-{damage}</em> : null}
    </section>
  )
}

function SoloGame({ catalog, worldId, dimensionId, currentWorld, me, settings = DEFAULT_PEPEGUESSR_SETTINGS, autoStartKey = 0, onExit, onError, onOpenSettings }) {
  const restoredRef = useRef(false)
  const submittingRef = useRef(false)
  const autoStartedRef = useRef(0)
  const soloRoundStartSoundRef = useRef("")
  const soloTimeWarningRef = useRef("")
  const [match, setMatch] = useState(null)
  const [roundIndex, setRoundIndex] = useState(0)
  const [guess, setGuess] = useState(null)
  const [hasPlacedGuess, setHasPlacedGuess] = useState(false)
  const [result, setResult] = useState(null)
  const [soloRoundResults, setSoloRoundResults] = useState([])
  const [soloFinished, setSoloFinished] = useState(false)
  const [score, setScore] = useState(0)
  const [loading, setLoading] = useState(false)
  const [roundEndsAt, setRoundEndsAt] = useState(0)
  const [roundStartedAt, setRoundStartedAt] = useState(0)
  const [now, setNow] = useState(Date.now())
  const [resultShownAt, setResultShownAt] = useState(0)
  const [panoramaReady, setPanoramaReady] = useState(false)
  const [mapReady, setMapReady] = useState(false)

  const round = match?.rounds?.[roundIndex]
  const location = result?.location || round?.location
  const locationWorld = getLocationWorld(catalog, location, currentWorld)
  const locationDimensionId = readString(location?.dimensionId) || dimensionId
  const timeLeftMs = match && !result && roundStartedAt ? Math.max(0, roundEndsAt ? roundEndsAt - now : SOLO_ROUND_MS) : 0
  const timerProgress = roundStartedAt && roundEndsAt
    ? Math.max(0, Math.min(1, timeLeftMs / Math.max(1, roundEndsAt - roundStartedAt)))
    : 1
  const soloRevealMapLocked = false

  const markPanoramaReady = useCallback((readyRoundId) => {
    if (!readyRoundId || readyRoundId === round?.id) {
      setPanoramaReady(true)
    }
  }, [round?.id])

  const markMapReady = useCallback((readyRoundId) => {
    if (!readyRoundId || readyRoundId === round?.id) {
      setMapReady(true)
    }
  }, [round?.id])
  const markCurrentRoundPanoramaReady = useCallback(() => {
    markPanoramaReady(round?.id)
  }, [markPanoramaReady, round?.id])
  const markCurrentRoundMapReady = useCallback(() => {
    markMapReady(round?.id)
  }, [markMapReady, round?.id])

  useEffect(() => {
    if (restoredRef.current) {
      return
    }
    restoredRef.current = true
    const save = readClientSave(SOLO_SAVE_KEY)
    if (!save?.match || save.worldId !== worldId || save.dimensionId !== dimensionId) {
      return
    }
    setMatch(save.match)
    setRoundIndex(Number.isFinite(Number(save.roundIndex)) ? Number(save.roundIndex) : 0)
    setGuess(save.guess || null)
    setHasPlacedGuess(Boolean(save.guess))
    setResult(save.result || null)
    setSoloRoundResults(Array.isArray(save.soloRoundResults) ? save.soloRoundResults : [])
    setSoloFinished(Boolean(save.soloFinished))
    setResultShownAt(save.result ? (Number.isFinite(Number(save.resultShownAt)) ? Number(save.resultShownAt) : Date.now()) : 0)
    setScore(Number.isFinite(Number(save.score)) ? Number(save.score) : 0)
    if (save.result) {
      const savedRoundEndsAt = Number.isFinite(Number(save.roundEndsAt)) ? Number(save.roundEndsAt) : Date.now()
      setRoundEndsAt(savedRoundEndsAt)
      setRoundStartedAt(Number.isFinite(Number(save.roundStartedAt)) ? Number(save.roundStartedAt) : savedRoundEndsAt - SOLO_ROUND_MS)
    } else {
      setRoundEndsAt(0)
      setRoundStartedAt(0)
    }
  }, [dimensionId, worldId])

  useEffect(() => {
    if (!match) {
      return
    }
    writeClientSave(SOLO_SAVE_KEY, {
      match,
      roundIndex,
      guess,
      hasPlacedGuess,
      result,
      soloRoundResults,
      soloFinished,
      score,
      roundEndsAt,
      roundStartedAt,
      resultShownAt,
      worldId,
      dimensionId
    })
  }, [dimensionId, guess, hasPlacedGuess, match, result, resultShownAt, roundEndsAt, roundIndex, roundStartedAt, score, soloFinished, soloRoundResults, worldId])

  useEffect(() => {
    setPanoramaReady(false)
    setMapReady(false)
  }, [round?.id])

  useEffect(() => {
    if (!result || !match) {
      return
    }
    const nextRound = match.rounds?.[roundIndex + 1]
    if (!nextRound?.location) {
      return
    }
    preloadRoundAssets(getLocationWorld(catalog, nextRound.location, currentWorld), readString(nextRound.location?.dimensionId) || dimensionId, nextRound.location)
  }, [catalog, currentWorld, dimensionId, match, result, roundIndex])

  useEffect(() => {
    if (!match || !round || result || roundStartedAt || !panoramaReady || !mapReady) {
      return
    }
    const roundStart = Date.now()
    setNow(roundStart)
    setRoundStartedAt(roundStart)
    setRoundEndsAt(roundStart + SOLO_ROUND_MS)
  }, [mapReady, match, panoramaReady, result, round, roundStartedAt])

  useEffect(() => {
    if (!roundStartedAt || !round?.id || result) {
      return
    }
    const key = `${round.id}:${roundStartedAt}`
    if (soloRoundStartSoundRef.current === key) {
      return
    }
    soloRoundStartSoundRef.current = key
    playGameSound("start")
  }, [result, round?.id, roundStartedAt])

  useEffect(() => {
    if (!round?.id || result || !roundStartedAt || !roundEndsAt || timeLeftMs > 5000) {
      return
    }
    if (soloTimeWarningRef.current === round.id) {
      return
    }
    soloTimeWarningRef.current = round.id
    playGameSound("time")
  }, [result, round?.id, roundEndsAt, roundStartedAt, timeLeftMs])

  useEffect(() => {
    if (result || soloFinished || !match) {
      stopGameSound("time")
    }
  }, [match, result, soloFinished])

  const start = useCallback(async () => {
    setLoading(true)
    setResult(null)
    setGuess(null)
    setHasPlacedGuess(false)
    setSoloRoundResults([])
    setSoloFinished(false)
    setScore(0)
    setRoundEndsAt(0)
    setRoundStartedAt(0)
    setResultShownAt(0)
    clearClientSave(SOLO_SAVE_KEY)
    try {
      const payload = await fetchJson(pepeApi("solo/start"), {
        method: "POST",
        body: JSON.stringify({ worldId, dimensionId })
      })
      setMatch(payload.match)
      setRoundIndex(0)
    } catch (error) {
      onError(error.message)
    } finally {
      setLoading(false)
    }
  }, [dimensionId, onError, worldId])

  useEffect(() => {
    if (!autoStartKey || autoStartedRef.current === autoStartKey || match || loading) {
      return
    }
    autoStartedRef.current = autoStartKey
    clearClientSave(SOLO_SAVE_KEY)
    start()
  }, [autoStartKey, loading, match, start])

  const submit = useCallback(async () => {
    if (!round || result || submittingRef.current) {
      playGameSound("no")
      return
    }
    if (!roundStartedAt) {
      playGameSound("no")
      return
    }
    if (!hasPlacedGuess && roundEndsAt && Date.now() < roundEndsAt) {
      playGameSound("no")
      return
    }
    submittingRef.current = true
    const submittedGuess = guess ? { x: guess.x, z: guess.z } : null
    try {
      const payload = await fetchJson(pepeApi("solo/guess"), {
        method: "POST",
        body: JSON.stringify({ locationId: round.location.id, x: guess?.x, z: guess?.z })
      })
      if (submittedGuess) {
        playGameSound("guess")
      }
      const isFinalSoloRound = roundIndex + 1 >= match.rounds.length
      setSoloRoundResults((items) => {
        const nextItems = [...items]
        nextItems[roundIndex] = {
          roundId: round.id,
          title: formatSoloRoundTitle(roundIndex),
          score: Number(payload.result?.score) || 0,
          distance: payload.result?.distance,
          guess: submittedGuess,
          actual: payload.result?.location || round.location
        }
        return nextItems
      })
      setScore((value) => value + payload.result.score)
      if (isFinalSoloRound) {
        setResult(null)
        setResultShownAt(0)
        setRoundEndsAt(0)
        setRoundStartedAt(0)
        setSoloFinished(true)
      } else {
        setResultShownAt(Date.now())
        setResult(payload.result)
      }
    } catch (error) {
      onError(error.message)
    } finally {
      submittingRef.current = false
    }
  }, [guess, hasPlacedGuess, match, onError, result, round, roundEndsAt, roundIndex, roundStartedAt])

  useEffect(() => {
    if (!match || result || !roundEndsAt || !roundStartedAt || now < roundEndsAt) {
      return
    }
    submit()
  }, [match, now, result, roundEndsAt, roundStartedAt, submit])

  const next = useCallback(() => {
    if (!match) {
      return
    }
    if (roundIndex + 1 >= match.rounds.length) {
      setSoloFinished(true)
      setResult(null)
      setResultShownAt(0)
      setRoundEndsAt(0)
      setRoundStartedAt(0)
      return
    }
    setRoundIndex((value) => value + 1)
    setGuess(null)
    setHasPlacedGuess(false)
    setResult(null)
    setResultShownAt(0)
    setRoundEndsAt(0)
    setRoundStartedAt(0)
  }, [match, roundIndex])

  useEffect(() => {
    if (!match || result) {
      return undefined
    }
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [match, result, roundIndex])

  if (soloFinished && match) {
    const finalWorld = getLocationWorld(catalog, soloRoundResults.find((entry) => entry?.actual)?.actual || round?.location, currentWorld)
    const finalGuesses = soloRoundResults
      .filter((entry) => entry?.guess)
      .map((entry, index) => ({
        guess: entry.guess,
        actual: entry.actual,
        player: {
          ...(me?.authenticated ? me.profile : {}),
          displayName: `${index + 1}`
        }
      }))
    const finalActuals = soloRoundResults
      .filter((entry) => entry?.actual)
      .map((entry, index) => ({ location: entry.actual, label: index + 1 }))

    return (
      <div className="pg-game pg-game--solo pg-game--solo-final">
        <div className="pg-solo-final-panel">
          <SoloPlayerBadge me={me} score={score} />
          <button type="button" className="pg-settings-button pg-game-settings-button" onClick={onOpenSettings} aria-label="Настройки">⚙</button>
          <div className="pg-solo-final-summary">
            <img src="/pepe-brand-icon.svg" alt="" />
            <span>{"\u0424\u0438\u043d\u0430\u043b \u0442\u0440\u0435\u043d\u0438\u0440\u043e\u0432\u043a\u0438"}</span>
            <strong>{score}</strong>
            <small>{soloRoundResults.filter(Boolean).length} / {match.rounds.length} {"\u0440\u0430\u0443\u043d\u0434\u043e\u0432"}</small>
            {!me?.authenticated ? <em>{"\u0412\u043e\u0439\u0434\u0438 \u0432 \u0430\u043a\u043a\u0430\u0443\u043d\u0442, \u0447\u0442\u043e\u0431\u044b \u0440\u0430\u0443\u043d\u0434\u044b \u0438 \u0441\u0442\u0430\u0442\u0438\u0441\u0442\u0438\u043a\u0430 \u0441\u043e\u0445\u0440\u0430\u043d\u044f\u043b\u0438\u0441\u044c."}</em> : null}
          </div>
          <div className="pg-solo-final-actions">
            <button type="button" className="pg-primary" onClick={start}>{"\u041d\u043e\u0432\u0430\u044f \u0442\u0440\u0435\u043d\u0438\u0440\u043e\u0432\u043a\u0430"}</button>
            <button type="button" className="pg-danger" onClick={onExit}>{"\u0412\u044b\u0439\u0442\u0438"}</button>
          </div>
        </div>
        <GuessMap
          key={`solo-final-${match.id}`}
          world={finalWorld}
          dimensionId={readString(finalActuals[0]?.location?.dimensionId) || dimensionId}
          guess={null}
          playerGuesses={finalGuesses}
          actual={null}
          actualMarkers={finalActuals}
          reveal
          expanded
          locked={false}
          className="pg-solo-final-map pg-solo-result-map"
          hideChrome
        />
      </div>
    )
  }

  if (!match || !round) {
    return (
      <section className="pg-mode-card">
        <h2>Solo тренировка</h2>
        <p>Быстрый прогон точек без обязательного профиля. Авторизованный игрок получает статистику.</p>
        <button type="button" className="pg-primary" onClick={start} disabled={loading}>
          {loading ? "Запуск..." : "Начать solo"}
        </button>
      </section>
    )
  }

  if (result) {
    return (
      <div className="pg-game pg-game--solo pg-game--solo-result">
        <div className="pg-solo-result-top">
          <SoloPlayerBadge me={me} score={score} />
          <button type="button" className="pg-settings-button pg-game-settings-button" onClick={onOpenSettings} aria-label="Настройки">⚙</button>
          <div className="pg-solo-result-center">
            <img src="/pepe-brand-icon.svg" alt="" />
            <b>{formatSoloRoundTitle(roundIndex)}</b>
          </div>
          <div className="pg-solo-result-points">
            +{result.score} {"\u0431\u0430\u043b\u043b\u043e\u0432"}
          </div>
        </div>
        <GuessMap
          key={`solo-result-${match.id}-${round.id}`}
          world={locationWorld}
          dimensionId={locationDimensionId}
          guess={guess}
          guessPlayer={me?.authenticated ? me.profile : null}
          actual={result.location}
          reveal
          expanded
          locked={soloRevealMapLocked}
          className="pg-solo-result-map"
          hideChrome
        />
        <div className="pg-solo-result-actions pg-solo-result-actions--round">
          <button type="button" className="pg-primary" onClick={next}>{"\u041f\u0440\u043e\u0434\u043e\u043b\u0436\u0438\u0442\u044c"}</button>
          <button type="button" className="pg-danger" onClick={onExit}>{"\u0412\u044b\u0439\u0442\u0438"}</button>
        </div>
      </div>
    )
  }

  return (
    <div className="pg-game pg-game--solo pg-game--solo-play">
      <div className="pg-solo-play-hud">
        <SoloPlayerBadge me={me} score={score} />
        <div className={`pg-solo-timer${roundStartedAt ? "" : " pg-solo-timer--pending"}`} style={{ "--timer-progress": timerProgress }}>
          {roundStartedAt ? formatSeconds(timeLeftMs) : "..."}
        </div>
        <button type="button" className="pg-settings-button pg-game-settings-button" onClick={onOpenSettings} aria-label="Настройки">⚙</button>
      </div>
      <div className="pg-playfield pg-solo-playfield">
        <PanoramaViewer key={`solo-panorama-${match.id}-${round.id}`} location={location} defaultFov={settings.fov} onReady={markCurrentRoundPanoramaReady} />
        <GuessMap
          key={`solo-play-${match.id}-${round.id}`}
          world={locationWorld}
          dimensionId={locationDimensionId}
          guess={guess}
          guessPlayer={me?.authenticated ? me.profile : null}
          actual={null}
          reveal={false}
          locked={!roundStartedAt}
          onGuess={(value) => {
            if (!roundStartedAt) {
              return
            }
            setHasPlacedGuess(true)
            setGuess(value)
          }}
          onSubmit={submit}
          onInvalidSubmit={() => playGameSound("no")}
          canSubmit={hasPlacedGuess && Boolean(roundStartedAt)}
          submitLabel={!roundStartedAt ? "\u0417\u0430\u0433\u0440\u0443\u0437\u043a\u0430..." : hasPlacedGuess ? "\u0413\u0435\u0441\u0441" : "\u041f\u043e\u043c\u0435\u0441\u0442\u0438\u0442\u0435 \u0441\u0432\u043e\u044e \u043e\u0442\u043c\u0435\u0442\u043a\u0443 \u043d\u0430 \u043a\u0430\u0440\u0442\u0435"}
          className="pg-solo-minimap"
          onReady={markCurrentRoundMapReady}
        />
        {!roundStartedAt ? (
          <div className="pg-round-loading" aria-live="polite">
            <span />
            <b>{"\u0417\u0430\u0433\u0440\u0443\u0437\u043a\u0430 \u0440\u0430\u0443\u043d\u0434\u0430"}</b>
            <small>{panoramaReady ? "\u041f\u0430\u043d\u043e\u0440\u0430\u043c\u0430 \u0433\u043e\u0442\u043e\u0432\u0430" : "\u0413\u0440\u0443\u0437\u0438\u043c \u043f\u0430\u043d\u043e\u0440\u0430\u043c\u0443"} В· {mapReady ? "\u041a\u0430\u0440\u0442\u0430 \u0433\u043e\u0442\u043e\u0432\u0430" : "\u0413\u0440\u0443\u0437\u0438\u043c \u043a\u0430\u0440\u0442\u0443"}</small>
          </div>
        ) : null}
      </div>
      {result ? (
        <div className="pg-reveal-bar">
          <span>{"\u041f\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u043E\u0435 \u043C\u0435\u0441\u0442\u043E \u043F\u043E\u043A\u0430\u0437\u0430\u043D\u043E \u043D\u0430 \u043A\u0430\u0440\u0442\u0435"}</span>
          <button type="button" className="pg-primary" onClick={next}>{roundIndex + 1 >= match.rounds.length ? "Завершить" : "Следующий раунд"}</button>
        </div>
      ) : null}
    </div>
  )
}

function DuelGame({ catalog, me, worldId, dimensionId, currentWorld, settings = DEFAULT_PEPEGUESSR_SETTINGS, reducedMotion = false, lobbyKind = "search", onExit, onTraining, onError, onOpenSettings, onActiveRoomChange }) {
  const restoredRef = useRef(false)
  const [roomCodeInput, setRoomCodeInput] = useState("")
  const [room, setRoom] = useState(null)
  const [guess, setGuess] = useState(null)
  const [loading, setLoading] = useState(false)
  const [matchmaking, setMatchmaking] = useState(false)
  const [matchmakingStartedAt, setMatchmakingStartedAt] = useState(0)
  const [matchmakingNow, setMatchmakingNow] = useState(Date.now())
  const [roomWaitingStartedAt, setRoomWaitingStartedAt] = useState(0)
  const [roomRoundTimeMs, setRoomRoundTimeMs] = useState(60_000)
  const [roomDamageEnabled, setRoomDamageEnabled] = useState(true)
  const autoSubmitKeyRef = useRef("")
  const autoNextKeyRef = useRef("")
  const guessRef = useRef(null)
  const readyRoundKeyRef = useRef("")
  const submittingGuessRef = useRef(false)
  const duelRoundStartSoundRef = useRef("")
  const duelTimeWarningRef = useRef("")
  const duelCountdownSoundRef = useRef("")
  const duelGraceTimerSoundRef = useRef("")
  const duelRevealCountdownSoundRef = useRef("")
  const [duelPanoramaReady, setDuelPanoramaReady] = useState(false)
  const [duelMapReady, setDuelMapReady] = useState(false)
  const [duelRevealNow, setDuelRevealNow] = useState(Date.now())
  const [duelIntroStartedAt, setDuelIntroStartedAt] = useState(0)
  const [duelIntroNow, setDuelIntroNow] = useState(Date.now())
  const [preloadedDuelRoundKey, setPreloadedDuelRoundKey] = useState("")
  const activeGuess = room?.round?.guesses?.[room.viewerPlayerId] || guess
  const isReveal = room?.status === "reveal" || room?.status === "finished"
  const hasSubmitted = Boolean(room?.round?.guesses?.[room.viewerPlayerId])
  const roomIsActive = Boolean(room)
  const [now, setNow] = useState(Date.now())
  const roundStartedAt = Number(room?.round?.startedAt) || 0
  const activeRoundTimeMs = Math.max(0, Math.round(Number(room?.roundTimeMs) || 0))
  const roomGuessGraceMs = Math.max(0, Math.round(Number(room?.guessGraceMs) || 0))
  const roundFirstGuessAt = Number(room?.round?.firstGuessAt) || 0
  const roundEndsAt = Number(room?.round?.endsAt) || 0
  const revealStartedAt = Number(room?.round?.revealedAt) || 0
  const revealElapsedMs = isReveal && revealStartedAt ? Math.max(0, duelRevealNow - revealStartedAt) : 0
  const revealProgress = isReveal && room?.status !== "finished" ? Math.max(0, Math.min(1, revealElapsedMs / DUEL_REVEAL_MS)) : 1
  const revealRemainingMs = isReveal && room?.status !== "finished" ? Math.max(0, DUEL_REVEAL_MS - revealElapsedMs) : 0
  const revealCountdownNumber = isReveal && room?.status !== "finished" && revealRemainingMs <= DUEL_REVEAL_COUNTDOWN_MS
    ? Math.min(3, Math.max(1, Math.ceil(revealRemainingMs / 1000)))
    : 0
  const revealPhase = !isReveal
    ? "play"
    : !reducedMotion && revealElapsedMs < 2800
      ? "map"
      : revealRemainingMs <= DUEL_REVEAL_COUNTDOWN_MS
        ? "countdown"
        : "damage"
  const revealMapLocked = isReveal && room?.status !== "finished" && !reducedMotion && revealElapsedMs < 2800
  const hasRoundDeadline = room?.status === "playing" && roundStartedAt && roundEndsAt > 0
  const isInfiniteDuelRound = activeRoundTimeMs === 0
  const isGraceDuelTimer = hasRoundDeadline && isInfiniteDuelRound && roundFirstGuessAt > 0
  const shouldShowDuelTimer = hasRoundDeadline && (!isInfiniteDuelRound || roundFirstGuessAt > 0)
  const viewerGuess = room?.round?.guesses?.[room?.viewerPlayerId]
  const graceStartedByOpponent = isGraceDuelTimer && roundFirstGuessAt > 0 && !viewerGuess
  const timerDurationMs = hasRoundDeadline && activeRoundTimeMs === 0 && roundFirstGuessAt > 0
    ? Math.max(1, roomGuessGraceMs || roundEndsAt - roundFirstGuessAt)
    : Math.max(1, activeRoundTimeMs || roundEndsAt - roundStartedAt)
  const timeLeftMs = hasRoundDeadline ? Math.max(0, roundEndsAt - now) : 0
  const timerProgress = hasRoundDeadline
    ? Math.max(0, Math.min(1, (roundEndsAt - now) / timerDurationMs))
    : 1
  const duelRoundReadyKey = room?.code && room?.round?.id
    ? `${room.code}:${room.currentRoundIndex}:${room.round.id}`
    : ""
  const duelIntroAssetsReady = room?.status === "loading" && duelPanoramaReady && duelMapReady
  const duelIntroElapsedMs = duelIntroStartedAt ? Math.max(0, duelIntroNow - duelIntroStartedAt) : 0
  const duelIntroCountdownMs = duelIntroAssetsReady ? Math.max(0, DUEL_INTRO_COUNTDOWN_MS - duelIntroElapsedMs) : DUEL_INTRO_COUNTDOWN_MS
  const duelIntroCountdownNumber = duelIntroAssetsReady && duelIntroCountdownMs > 0
    ? Math.max(1, Math.ceil(duelIntroCountdownMs / 1000))
    : 0
  const duelIntroReadyToSend = duelIntroAssetsReady && duelIntroStartedAt && duelIntroElapsedMs >= DUEL_INTRO_COUNTDOWN_MS
  const duelReadyWasSent = duelRoundReadyKey && readyRoundKeyRef.current === duelRoundReadyKey
  const isFirstDuelRound = Math.max(0, Math.round(Number(room?.currentRoundIndex) || 0)) <= 0
  const nextDuelPreloadKey = room?.nextRoundLocation?.id
    ? `${room.code}:${room.currentRoundIndex}:${room.nextRoundLocation.id}`
    : ""
  const isNextDuelRoundPreloaded = !nextDuelPreloadKey || preloadedDuelRoundKey === nextDuelPreloadKey
  const matchmakingElapsedMs = matchmakingStartedAt ? Math.max(0, matchmakingNow - matchmakingStartedAt) : 0
  const roomWaitingElapsedMs = roomWaitingStartedAt ? Math.max(0, matchmakingNow - roomWaitingStartedAt) : 0
  const isMatchmakingRoom = Boolean(room?.matchmaking)
  const matchmakingLongWait = isMatchmakingRoom && roomWaitingElapsedMs >= 5 * 60 * 1000
  const duelWorld = useMemo(() => {
    const worlds = Array.isArray(catalog?.worlds) ? catalog.worlds : []
    const roomWorldId = readString(room?.worldId) || worldId
    return worlds.find((world) => world.id === roomWorldId) || currentWorld || worlds[0] || null
  }, [catalog?.worlds, currentWorld, room?.worldId, worldId])
  const roomDimensionId = readString(room?.dimensionId) || dimensionId

  const loadRoom = useCallback(async (code) => {
    const normalizedCode = readString(code).toUpperCase()
    const payload = await fetchJson(pepeApi(`rooms/${normalizedCode}`))
    setRoom(payload.room)
    setRoomCodeInput(payload.room.code)
    writeClientSave(ROOM_SAVE_KEY, { code: payload.room.code })
    return payload.room
  }, [])

  const resetRoomState = useCallback(() => {
    clearClientSave(ROOM_SAVE_KEY)
    setRoom(null)
    setGuess(null)
    setRoomCodeInput("")
    setMatchmaking(false)
    setMatchmakingStartedAt(0)
    setRoomWaitingStartedAt(0)
  }, [])

  useEffect(() => {
    if (restoredRef.current || !me?.authenticated) {
      return
    }
    restoredRef.current = true
    const save = readClientSave(ROOM_SAVE_KEY)
    if (!save?.code) {
      return
    }
    setRoomCodeInput(readString(save.code).toUpperCase())
    loadRoom(save.code).catch(() => {
      resetRoomState()
    })
  }, [loadRoom, me?.authenticated, resetRoomState])

  useEffect(() => {
    if (!room?.code) {
      return undefined
    }
    const timer = window.setInterval(() => {
      loadRoom(room.code).catch(() => {
        // Keep the room locally on transient API/network failures.
      })
    }, room.status === "playing" || room.status === "reveal" ? 2000 : 3500)
    return () => window.clearInterval(timer)
  }, [loadRoom, resetRoomState, room?.code, room?.status])

  useEffect(() => {
    if (room?.status !== "playing") {
      return undefined
    }
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [room?.round?.id, room?.status])

  useEffect(() => {
    onActiveRoomChange?.(roomIsActive)
    return () => onActiveRoomChange?.(false)
  }, [onActiveRoomChange, roomIsActive])

  useEffect(() => {
    if (!matchmakingStartedAt && !roomWaitingStartedAt) {
      return undefined
    }
    setMatchmakingNow(Date.now())
    const timer = window.setInterval(() => setMatchmakingNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [matchmakingStartedAt, roomWaitingStartedAt])

  useEffect(() => {
    if (room?.status === "waiting") {
      setRoomWaitingStartedAt((startedAt) => startedAt || Date.now())
      return
    }
    setRoomWaitingStartedAt(0)
  }, [room?.code, room?.status])

  useEffect(() => {
    if (!isReveal || room?.status === "finished" || !revealStartedAt) {
      return undefined
    }
    let frame = 0
    const tick = () => {
      setDuelRevealNow(Date.now())
      frame = window.requestAnimationFrame(tick)
    }
    tick()
    return () => window.cancelAnimationFrame(frame)
  }, [isReveal, revealStartedAt, room?.status])

  useEffect(() => {
    setGuess(null)
    guessRef.current = null
    autoSubmitKeyRef.current = ""
  }, [room?.currentRoundIndex, room?.code])

  useEffect(() => {
    guessRef.current = guess
  }, [guess])

  useEffect(() => {
    setDuelPanoramaReady(false)
    setDuelMapReady(false)
    setDuelIntroStartedAt(0)
    setDuelIntroNow(Date.now())
    readyRoundKeyRef.current = ""
    autoNextKeyRef.current = ""
  }, [room?.round?.id])

  useEffect(() => {
    if (!isFirstDuelRound) {
      setDuelIntroStartedAt(0)
      setDuelIntroNow(Date.now())
      return
    }
    if (!duelIntroAssetsReady) {
      setDuelIntroStartedAt(0)
      setDuelIntroNow(Date.now())
      return
    }
    setDuelIntroStartedAt((startedAt) => startedAt || Date.now())
  }, [duelIntroAssetsReady, isFirstDuelRound, room?.round?.id])

  useEffect(() => {
    if (!isFirstDuelRound || !duelIntroStartedAt || room?.status !== "loading") {
      return undefined
    }
    setDuelIntroNow(Date.now())
    const timer = window.setInterval(() => setDuelIntroNow(Date.now()), 120)
    return () => window.clearInterval(timer)
  }, [duelIntroStartedAt, isFirstDuelRound, room?.status])

  useEffect(() => {
    if (!isFirstDuelRound || !duelIntroAssetsReady || !duelIntroStartedAt || !room?.round?.id) {
      return
    }
    const key = `${room.code}:${room.currentRoundIndex}:${room.round.id}:countdown`
    if (duelCountdownSoundRef.current === key) {
      return
    }
    duelCountdownSoundRef.current = key
    playGameSound("countdown")
  }, [duelIntroAssetsReady, duelIntroStartedAt, isFirstDuelRound, room?.code, room?.currentRoundIndex, room?.round?.id])

  useEffect(() => {
    const nextLocation = room?.nextRoundLocation
    if (!isReveal || room?.status === "finished" || !duelWorld || !nextLocation) {
      return
    }
    const preloadKey = `${room.code}:${room.currentRoundIndex}:${nextLocation.id}`
    let disposed = false
    setPreloadedDuelRoundKey((currentKey) => (currentKey === preloadKey ? currentKey : ""))
    preloadRoundAssets(getLocationWorld(catalog, nextLocation, duelWorld), readString(nextLocation?.dimensionId) || roomDimensionId, nextLocation)
      .then(() => {
        if (!disposed) {
          setPreloadedDuelRoundKey(preloadKey)
        }
      })
    return () => {
      disposed = true
    }
  }, [catalog, duelWorld, isReveal, room?.code, room?.currentRoundIndex, room?.nextRoundLocation, roomDimensionId, room?.status])

  useEffect(() => {
    const currentLocation = room?.round?.location
    if (!currentLocation || !duelWorld || (room?.status !== "loading" && room?.status !== "playing")) {
      return
    }
    preloadRoundAssets(getLocationWorld(catalog, currentLocation, duelWorld), readString(currentLocation?.dimensionId) || roomDimensionId, currentLocation)
  }, [catalog, duelWorld, room?.round?.id, room?.round?.location, room?.status, roomDimensionId])

  const createRoom = useCallback(async () => {
    setLoading(true)
    try {
      const payload = await fetchJson(pepeApi("rooms"), {
        method: "POST",
        body: JSON.stringify({ worldId, dimensionId, roundTimeMs: roomRoundTimeMs, damageMultiplierEnabled: roomDamageEnabled })
      })
      setRoom(payload.room)
      setRoomCodeInput(payload.room.code)
      writeClientSave(ROOM_SAVE_KEY, { code: payload.room.code })
    } catch (error) {
      onError(error.message)
    } finally {
      setLoading(false)
    }
  }, [dimensionId, onError, roomDamageEnabled, roomRoundTimeMs, worldId])

  const startMatchmaking = useCallback(async () => {
    const startedAt = Date.now()
    setMatchmaking(true)
    setMatchmakingStartedAt(startedAt)
    setMatchmakingNow(startedAt)
    try {
      const payload = await fetchJson(pepeApi("rooms/matchmake"), {
        method: "POST",
        body: JSON.stringify({ worldId, dimensionId, roundTimeMs: 0 })
      })
      setRoom(payload.room)
      setRoomCodeInput(payload.room.code)
      writeClientSave(ROOM_SAVE_KEY, { code: payload.room.code })
    } catch (error) {
      onError(error.message)
    } finally {
      setMatchmaking(false)
      setMatchmakingStartedAt(0)
    }
  }, [dimensionId, onError, worldId])

  const joinRoom = useCallback(async () => {
    const code = readString(roomCodeInput).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5)
    if (!code) {
      return
    }
    setLoading(true)
    try {
      const payload = await fetchJson(pepeApi(`rooms/${code}/join`), { method: "POST" })
      setRoom(payload.room)
      setRoomCodeInput(payload.room.code)
      writeClientSave(ROOM_SAVE_KEY, { code: payload.room.code })
    } catch (error) {
      onError(error.message)
    } finally {
      setLoading(false)
    }
  }, [onError, roomCodeInput])

  const submitGuess = useCallback(async (guessOverride = null) => {
    const overrideGuess = Number.isFinite(Number(guessOverride?.x)) && Number.isFinite(Number(guessOverride?.z)) ? guessOverride : null
    const submittedGuess = overrideGuess || guessRef.current || guess
    if (!room?.code || !submittedGuess || room.status !== "playing" || !roundStartedAt || hasSubmitted || submittingGuessRef.current) {
      playGameSound("no")
      return
    }
    submittingGuessRef.current = true
    try {
      const payload = await fetchJson(pepeApi(`rooms/${room.code}/guess`), {
        method: "POST",
        body: JSON.stringify({ x: submittedGuess.x, z: submittedGuess.z })
      })
      playGameSound("guess")
      setRoom(payload.room)
    } catch (error) {
      onError(error.message)
    } finally {
      submittingGuessRef.current = false
    }
  }, [guess, hasSubmitted, onError, room?.code, room?.status, roundStartedAt])

  const markDuelPanoramaReady = useCallback((readyKey) => {
    if (!readyKey || readyKey !== duelRoundReadyKey) {
      return
    }
    setDuelPanoramaReady(true)
  }, [duelRoundReadyKey])

  const markDuelMapReady = useCallback((readyKey) => {
    if (!readyKey || readyKey !== duelRoundReadyKey) {
      return
    }
    setDuelMapReady(true)
  }, [duelRoundReadyKey])

  const markCurrentDuelPanoramaReady = useCallback(() => {
    markDuelPanoramaReady(duelRoundReadyKey)
  }, [duelRoundReadyKey, markDuelPanoramaReady])

  const markCurrentDuelMapReady = useCallback(() => {
    markDuelMapReady(duelRoundReadyKey)
  }, [duelRoundReadyKey, markDuelMapReady])

  useEffect(() => {
    const readyForFirstRoundIntro = isFirstDuelRound ? duelIntroReadyToSend : true
    if (room?.status !== "loading" || !room?.code || !duelPanoramaReady || !duelMapReady || !readyForFirstRoundIntro) {
      return
    }
    const key = `${room.code}:${room.currentRoundIndex}:${room.round?.id || "round"}`
    if (readyRoundKeyRef.current === key) {
      return
    }
    readyRoundKeyRef.current = key
    fetchJson(pepeApi(`rooms/${room.code}/ready`), { method: "POST" })
      .then((payload) => {
        setRoom(payload.room)
      })
      .catch((error) => {
        readyRoundKeyRef.current = ""
        onError(error.message)
      })
  }, [duelIntroReadyToSend, duelMapReady, duelPanoramaReady, isFirstDuelRound, onError, room?.code, room?.currentRoundIndex, room?.round?.id, room?.status])

  useEffect(() => {
    if (room?.status !== "playing" || !roundStartedAt || !room?.round?.id) {
      return
    }
    const key = `${room.code}:${room.currentRoundIndex}:${room.round.id}:${roundStartedAt}`
    if (duelRoundStartSoundRef.current === key) {
      return
    }
    duelRoundStartSoundRef.current = key
    playGameSound("start")
  }, [room?.status, room?.code, room?.currentRoundIndex, room?.round?.id, roundStartedAt])

  useEffect(() => {
    if (!hasRoundDeadline || isGraceDuelTimer || isReveal || room?.status !== "playing" || !room?.round?.id || timeLeftMs > 5000) {
      return
    }
    const key = `${room.code}:${room.currentRoundIndex}:${room.round.id}`
    if (duelTimeWarningRef.current === key) {
      return
    }
    duelTimeWarningRef.current = key
    playGameSound("time")
  }, [hasRoundDeadline, isGraceDuelTimer, isReveal, room?.code, room?.currentRoundIndex, room?.round?.id, room?.status, timeLeftMs])

  useEffect(() => {
    if (!graceStartedByOpponent || !room?.round?.id || !roundFirstGuessAt || room?.status !== "playing") {
      return
    }
    const key = `${room.code}:${room.currentRoundIndex}:${room.round.id}:${roundFirstGuessAt}:grace`
    if (duelGraceTimerSoundRef.current === key) {
      return
    }
    duelGraceTimerSoundRef.current = key
    playGameSound("guess")
  }, [graceStartedByOpponent, room?.code, room?.currentRoundIndex, room?.round?.id, room?.status, roundFirstGuessAt])

  useEffect(() => {
    if (room?.status === "reveal" || room?.status === "finished" || room?.status === "abandoned" || !room) {
      stopGameSound("time")
    }
  }, [room, room?.status, room?.round?.id])

  useEffect(() => {
    if (!revealCountdownNumber || !room?.round?.id || room?.status !== "reveal") {
      return
    }
    const key = `${room.code}:${room.currentRoundIndex}:${room.round.id}:reveal-countdown`
    if (duelRevealCountdownSoundRef.current === key) {
      return
    }
    duelRevealCountdownSoundRef.current = key
    playGameSound("countdown")
  }, [revealCountdownNumber, room?.code, room?.currentRoundIndex, room?.round?.id, room?.status])

  useEffect(() => {
    const pendingGuess = guessRef.current || guess
    if (room?.status !== "playing" || hasSubmitted || !pendingGuess || !roundStartedAt || !roundEndsAt || now < roundEndsAt - 1500) {
      return
    }
    const key = `${room.code}:${room.currentRoundIndex}:${pendingGuess.x}:${pendingGuess.z}`
    if (autoSubmitKeyRef.current === key) {
      return
    }
    autoSubmitKeyRef.current = key
    submitGuess(pendingGuess)
  }, [guess, hasSubmitted, now, room?.code, room?.currentRoundIndex, room?.status, roundEndsAt, roundStartedAt, submitGuess])

  const nextRound = useCallback(async () => {
    if (!room?.code) {
      return
    }
    try {
      const payload = await fetchJson(pepeApi(`rooms/${room.code}/next`), { method: "POST" })
      setRoom(payload.room)
    } catch (error) {
      onError(error.message)
    }
  }, [onError, room?.code])

  useEffect(() => {
    if (!isReveal || room?.status !== "reveal" || !revealStartedAt || revealElapsedMs < DUEL_REVEAL_MS || !isNextDuelRoundPreloaded) {
      return
    }
    const key = `${room.code}:${room.currentRoundIndex}:${room.round?.id || "round"}`
    if (autoNextKeyRef.current === key) {
      return
    }
    autoNextKeyRef.current = key
    nextRound()
  }, [isNextDuelRoundPreloaded, isReveal, nextRound, revealElapsedMs, revealStartedAt, room?.code, room?.currentRoundIndex, room?.round?.id, room?.status])

  const leaveRoom = useCallback(async () => {
    const code = room?.code
    resetRoomState()
    if (onExit) {
      onExit()
    }
    if (!code) {
      return
    }
    try {
      await fetchJson(pepeApi(`rooms/${code}/leave`), { method: "POST" })
    } catch (error) {
      onError(error.message)
    }
  }, [onError, onExit, resetRoomState, room?.code])

  if (!me?.authenticated) {
    const authTitle = lobbyKind === "room" ? "Комната" : "Дуэли"
    const authText = lobbyKind === "room"
      ? "Чтобы создавать комнату и входить по коду, сначала войди в профиль."
      : "Для дуэли нужен профиль, чтобы сохранять победы и не терять комнату."
    return (
      <section className="pg-mode-card">
        <h2>{authTitle}</h2>
        <p>{authText}</p>
        <a className="pg-primary pg-link-button" href={discordLoginUrl(PEPEGUESSR_ROUTE_PATHS.duel)}>Войти через Discord</a>
      </section>
    )
  }

  if (!room) {
    const isRoomLobby = lobbyKind === "room"
    return (
      <section className={`pg-mode-card pg-duel-lobby-card${isRoomLobby ? " pg-room-lobby-card" : " pg-search-lobby-card"}`}>
        <div className="pg-duel-lobby-head">
          <span>1v1</span>
          <h2>{isRoomLobby ? "Комната" : "Поиск соперника"}</h2>
          <p>{isRoomLobby ? "Создай приватную комнату или войди по коду друга." : "Автоподбор найдет соперника и начнет матч автоматически."}</p>
        </div>
        {isRoomLobby ? (
          <div className="pg-room-lobby-grid">
            <section className="pg-room-card pg-room-card--create">
              <div className="pg-room-card-head">
                <span className="pg-room-card-icon pg-room-card-icon--create"><RoomCreateIcon /></span>
                <div>
                  <h3>Создать комнату</h3>
                  <p>Настройки комнаты</p>
                </div>
              </div>
              <label className="pg-duel-timer-picker">
                <span>Время игры:</span>
                <div>
                  {DUEL_ROOM_TIMER_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={roomRoundTimeMs === option.value ? "is-active" : ""}
                      onClick={() => setRoomRoundTimeMs(option.value)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </label>
              <label className="pg-room-damage-row">
                <span>Множитель урона:</span>
                <input
                  type="checkbox"
                  checked={roomDamageEnabled}
                  onChange={(event) => setRoomDamageEnabled(event.target.checked)}
                  aria-label="Множитель урона"
                />
              </label>
              <button type="button" className="pg-primary pg-duel-create-button" onClick={createRoom} disabled={loading || matchmaking}>
                {loading ? "..." : "Создать"}
              </button>
            </section>
            <section className="pg-room-card pg-room-card--join">
              <div className="pg-room-card-head">
                <span className="pg-room-card-icon pg-room-card-icon--join"><RoomJoinIcon /></span>
                <div>
                  <h3>Войти в комнату</h3>
                  <p>Код комнаты</p>
                </div>
              </div>
              <label className="pg-room-code-label">
                <span>Введи код комнаты:</span>
                <div className="pg-room-code-control">
                  <input
                    value={roomCodeInput}
                    onChange={(event) => setRoomCodeInput(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5))}
                    aria-label="Код комнаты"
                    maxLength={5}
                    autoComplete="off"
                    spellCheck="false"
                  />
                  <div className="pg-room-code-slots" aria-hidden="true">
                    {Array.from({ length: 5 }).map((_, index) => (
                      <span key={index}>{roomCodeInput[index] || ""}</span>
                    ))}
                  </div>
                </div>
              </label>
              <p className="pg-room-help">Код комнаты можно получить от друга. Или сразу присоединиться к нему через профиль.</p>
              <button type="button" className="pg-primary pg-room-join-button" onClick={joinRoom} disabled={loading || matchmaking || roomCodeInput.length < 5}>Войти</button>
            </section>
          </div>
        ) : (
          <div className="pg-duel-lobby-panel">
            <button type="button" className="pg-matchmake-button" onClick={startMatchmaking} disabled={loading || matchmaking}>
              <span>{matchmaking ? "Ищем соперника..." : "Автоподбор"}</span>
              <small>{matchmaking ? "Ищем соперника" : "Найдет открытую дуэль или создаст ожидание"}</small>
              {matchmaking ? <em>{formatSeconds(matchmakingElapsedMs)}</em> : null}
            </button>
            <p className="pg-duel-lobby-note">Поиск работает без кода комнаты. Матч начнется автоматически, когда найдется второй игрок.</p>
          </div>
        )}
        {isRoomLobby ? null : <div className="pg-duel-rules">
          <b>Множитель урона</b>
          <span>x1: 1-5 В· x2: 6-7 В· x3: 8-9 В· x4: 10+</span>
        </div>}
      </section>
    )
  }

  const location = room.round?.location
  const roundWorld = getLocationWorld(catalog, location, duelWorld)
  const roundDimensionId = readString(location?.dimensionId) || roomDimensionId
  const players = Array.isArray(room.players) ? room.players : []
  const viewerPlayer = players.find((player) => player.id === room.viewerPlayerId) || null
  const leftPlayer = viewerPlayer || players[0] || null
  const rightPlayer = players.find((player) => player.id && player.id !== leftPlayer?.id) || null
  const visiblePlayers = [leftPlayer, rightPlayer].filter(Boolean)
  const opponentLeft = room.status === "abandoned"
  const viewerLeft = opponentLeft && room.leftPlayerId && room.leftPlayerId === room.viewerPlayerId
  const opponentLeftWin = opponentLeft && room.viewerResult === "win"
  const opponentLeftName = room.leftPlayerName || rightPlayer?.displayName || "Соперник"
  const duelGuessMarkers = isReveal
    ? visiblePlayers
        .map((player, index) => {
          const roundGuess = room.round?.guesses?.[player.id]
          return roundGuess ? { id: player.id, player, guess: roundGuess, index } : null
        })
        .filter(Boolean)
    : []
  const hasPlayableRound = room.status === "waiting" || Boolean(location && roundWorld)
  const isDuelRoundLoading = room.status === "loading" || (room.status === "playing" && !roundStartedAt)
  if (opponentLeft) {
    return (
      <section className="pg-waiting pg-duel-waiting pg-duel-abandoned">
        <div className="pg-duel-abandoned-card">
          <DuelPlayerCard player={leftPlayer} fallbackName="Player 1" side="left" />
          <div className="pg-duel-abandoned-copy">
            <span>{viewerLeft ? "Матч остановлен" : opponentLeftWin ? "Победа засчитана" : "Соперник вышел"}</span>
            <h2>{viewerLeft ? "Вы вышли из комнаты" : `${opponentLeftName} вышел из игры`}</h2>
            <p>{viewerLeft ? "Комната больше не активна для этой сессии." : "Раунд остановлен, победа у оставшегося игрока."}</p>
            <button type="button" className="pg-danger" onClick={leaveRoom}>{"\u0412\u044b\u0439\u0442\u0438"}</button>
          </div>
          <DuelPlayerCard player={rightPlayer} fallbackName={opponentLeftName} side="right" />
        </div>
      </section>
    )
  }
  if (isReveal && hasPlayableRound && location && roundWorld) {
    const leftDamage = Math.round(Number(leftPlayer?.lastDamage) || 0)
    const rightDamage = Math.round(Number(rightPlayer?.lastDamage) || 0)
    const totalDamage = Math.max(leftDamage, rightDamage)
    const leftRoundScore = Math.max(0, Math.round(Number(room.round?.guesses?.[leftPlayer?.id]?.score) || 0))
    const rightRoundScore = Math.max(0, Math.round(Number(room.round?.guesses?.[rightPlayer?.id]?.score) || 0))
    const damageTarget = leftDamage > rightDamage ? "left" : rightDamage > leftDamage ? "right" : "none"
    const viewerOutcome = room.viewerResult === "win" ? "Победа" : room.viewerResult === "loss" ? "Поражение" : ""
    return (
      <div className={`pg-game pg-game--duel-result pg-duel-result--${revealPhase}${reducedMotion ? " pg-reduced-motion" : ""}`}>
        {room.status !== "finished" ? (
          <div className="pg-duel-result-timeline" style={{ "--reveal-progress": revealProgress }}>
            <span />
          </div>
        ) : null}
        <div className="pg-duel-result-top">
          <DuelPlayerCard player={leftPlayer} fallbackName="Player 1" side="left" isReveal={isReveal} />
          <button type="button" className="pg-settings-button pg-game-settings-button" onClick={onOpenSettings} aria-label="Настройки">⚙</button>
          <div className="pg-solo-result-center pg-duel-result-center">
            <img src="/pepe-brand-icon.svg" alt="" />
            <b>{room.status === "finished" ? "\u041c\u0430\u0442\u0447 \u0437\u0430\u0432\u0435\u0440\u0448\u0435\u043d" : `\u0420\u0430\u0443\u043d\u0434 ${room.currentRoundIndex + 1}`}</b>
            {viewerOutcome ? <strong className={`pg-duel-outcome pg-duel-outcome--${room.viewerResult}`}>{viewerOutcome}</strong> : null}
            <small>{room.status === "finished" ? `${room.roundCount} \u0440\u0430\u0443\u043d\u0434\u043e\u0432` : `x${room.round?.damageMultiplier || 1} \u0443\u0440\u043e\u043d`}</small>
          </div>
          <DuelPlayerCard player={rightPlayer} fallbackName="Player 2" side="right" isReveal={isReveal} />
          <div className="pg-solo-result-points pg-duel-result-damage">
            <div className={`pg-duel-score-fight pg-duel-score-fight--${damageTarget}`}>
              <span className={damageTarget === "left" ? "is-hit" : ""}>{leftRoundScore}</span>
              <i>VS</i>
              <span className={damageTarget === "right" ? "is-hit" : ""}>{rightRoundScore}</span>
              <b>{totalDamage > 0 ? `-${totalDamage} HP` : "\u041d\u0435\u0442 \u0443\u0440\u043e\u043d\u0430"}</b>
            </div>
          </div>
        </div>
        <GuessMap
          key={`duel-result-${room.code}-${room.currentRoundIndex}-${room.round?.id || "waiting"}-${room.status}`}
          world={roundWorld}
          dimensionId={roundDimensionId}
          guess={null}
          playerGuesses={duelGuessMarkers}
          actual={location}
          reveal
          expanded
          locked={revealMapLocked}
          className="pg-duel-result-map"
          hideChrome
          hideHeader
        />
        {revealCountdownNumber ? <div className="pg-duel-countdown" key={revealCountdownNumber}>{revealCountdownNumber}</div> : null}
        {room.status === "finished" ? (
          <div className="pg-solo-result-actions pg-duel-result-actions pg-duel-result-actions--finished">
            <button type="button" className="pg-danger" onClick={leaveRoom}>{"\u0412\u044b\u0439\u0442\u0438"}</button>
          </div>
        ) : null}
      </div>
    )
  }

  if (room.status === "waiting") {
    return (
      <section className={`pg-waiting pg-duel-waiting${isMatchmakingRoom ? " pg-duel-waiting--matchmaking" : ""}`}>
        <DuelIntroOverlay leftPlayer={leftPlayer} rightPlayer={rightPlayer} panoramaReady={false} mapReady={false} roundIndex={room.currentRoundIndex || 0} />
        <h2>{isMatchmakingRoom ? "Поиск соперника" : `Код комнаты: ${room.code}`}</h2>
        <strong className="pg-duel-search-elapsed">Поиск идет {formatSeconds(roomWaitingElapsedMs)}</strong>
        <p>
          {isMatchmakingRoom
            ? (matchmakingLongWait ? "Игроков пока нет. Можно перейти в тренировку и вернуться позже." : "Матч начнется автоматически, когда найдется второй игрок.")
            : "Отправь код второму игроку. Матч начнется автоматически после входа."}
        </p>
        <div className="pg-duel-waiting-actions">
          {matchmakingLongWait ? <button type="button" className="pg-primary" onClick={onTraining}>{"В тренировку"}</button> : null}
          <button type="button" className="pg-danger" onClick={leaveRoom}>{"Выйти"}</button>
        </div>
      </section>
    )
  }

  return (
    <div className={`pg-game${isDuelRoundLoading ? " pg-game--duel-loading" : ""}`}>
      <div className="pg-hud pg-game-hud pg-game-hud--duel">
        <div className="pg-round-banner">
          <span>{isMatchmakingRoom ? "\u0410\u0432\u0442\u043e\u043f\u043e\u0434\u0431\u043e\u0440" : "\u0414\u0443\u044d\u043b\u044c"}</span>
          <b>{room.status === "waiting" ? "\u041e\u0436\u0438\u0434\u0430\u043d\u0438\u0435" : `\u0420\u0430\u0443\u043d\u0434 ${room.currentRoundIndex + 1}`}</b>
        </div>
        <button type="button" className="pg-settings-button pg-game-settings-button" onClick={onOpenSettings} aria-label="Настройки">⚙</button>
        <div className="pg-versus-row">
          <DuelPlayerCard player={leftPlayer} fallbackName="Player 1" side="left" isReveal={isReveal} />
          <div className="pg-center-score">
            {room.status === "playing" && roundStartedAt ? (
              shouldShowDuelTimer ? (
                <span className={`pg-duel-timer${isGraceDuelTimer ? " pg-duel-timer--grace" : ""}`} style={{ "--timer-progress": timerProgress }}>{formatSeconds(timeLeftMs)}</span>
              ) : (
                <span className="pg-duel-timer-spacer" aria-hidden="true" />
              )
            ) : (
              <span className="pg-duel-timer-spacer" aria-hidden="true" />
            )}
            <small>{room.status === "finished" ? `${room.roundCount} \u0440\u0430\u0443\u043d\u0434\u043e\u0432` : room.round?.damageMultiplier ? `x${room.round.damageMultiplier} \u0443\u0440\u043e\u043d` : ""}</small>
          </div>
          <DuelPlayerCard player={rightPlayer} fallbackName="Player 2" side="right" isReveal={isReveal} />
        </div>
      </div>
      {room.status === "waiting" ? (
        <section className={`pg-waiting pg-duel-waiting${isMatchmakingRoom ? " pg-duel-waiting--matchmaking" : ""}`}>
          <DuelIntroOverlay leftPlayer={leftPlayer} rightPlayer={rightPlayer} panoramaReady={false} mapReady={false} roundIndex={room.currentRoundIndex || 0} />
          <h2>{isMatchmakingRoom ? "Поиск соперника" : `Код комнаты: ${room.code}`}</h2>
          <strong className="pg-duel-search-elapsed">Поиск идет {formatSeconds(roomWaitingElapsedMs)}</strong>
          <p>
            {isMatchmakingRoom
              ? (matchmakingLongWait ? "Игроков пока нет. Можно перейти в тренировку и вернуться позже." : "Матч начнется автоматически, когда найдется второй игрок.")
              : "Отправь код второму игроку. Матч начнется автоматически после входа."}
          </p>
          <div className="pg-duel-waiting-actions">
            {matchmakingLongWait ? <button type="button" className="pg-primary" onClick={onTraining}>{"В тренировку"}</button> : null}
            <button type="button" className="pg-danger" onClick={leaveRoom}>{"\u0412\u044b\u0439\u0442\u0438"}</button>
          </div>
        </section>
      ) : !hasPlayableRound ? (
        <section className="pg-waiting">
          <h2>{"\u0417\u0430\u0433\u0440\u0443\u0437\u043A\u0430 \u0440\u0430\u0443\u043D\u0434\u0430"}</h2>
          <p>{"\u041A\u0430\u0440\u0442\u0430 \u0438 \u043F\u0430\u043D\u043E\u0440\u0430\u043C\u0430 \u0434\u043B\u044F \u044D\u0442\u043E\u0439 \u043A\u043E\u043C\u043D\u0430\u0442\u044B \u0435\u0449\u0435 \u043D\u0435 \u0433\u043E\u0442\u043E\u0432\u044B."}</p>
        </section>
      ) : (
        <>
          <div className="pg-playfield">
            <PanoramaViewer key={`duel-panorama-${duelRoundReadyKey || "waiting"}`} location={location} defaultFov={settings.fov} onReady={markCurrentDuelPanoramaReady} />
            <GuessMap
              key={`duel-${room.code}-${room.currentRoundIndex}-${room.round?.id || "waiting"}-${room.status}`}
              world={roundWorld}
              dimensionId={roundDimensionId}
              guess={isReveal ? null : activeGuess}
              guessPlayer={viewerPlayer}
              playerGuesses={duelGuessMarkers}
              actual={isReveal ? location : null}
              reveal={isReveal}
              expanded={isReveal}
              locked={isReveal || hasSubmitted || room.status !== "playing" || !roundStartedAt}
              onGuess={(value) => {
                guessRef.current = value
                setGuess(value)
              }}
              onSubmit={!isReveal && room.status === "playing" && roundStartedAt ? submitGuess : null}
              onInvalidSubmit={() => playGameSound("no")}
              canSubmit={Boolean(guessRef.current || guess) && !hasSubmitted && room.status === "playing" && Boolean(roundStartedAt)}
              submitLabel={hasSubmitted ? "\u0416\u0434\u0435\u043c" : room.status === "playing" && roundStartedAt ? "\u0413\u0435\u0441\u0441" : "\u0417\u0430\u0433\u0440\u0443\u0437\u043a\u0430..."}
              className="pg-duel-map"
              hideHeader
              onReady={markCurrentDuelMapReady}
            />
            {isDuelRoundLoading && isFirstDuelRound ? (
              <DuelIntroOverlay
                leftPlayer={leftPlayer}
                rightPlayer={rightPlayer}
                panoramaReady={duelPanoramaReady}
                mapReady={duelMapReady}
                roundIndex={room.currentRoundIndex || 0}
                countdownNumber={duelIntroCountdownNumber}
                readySent={Boolean(duelReadyWasSent)}
              />
            ) : null}
            {false ? (
              <div className="pg-round-loading" aria-live="polite">
                <span />
                <b>{"\u0416\u0434\u0435\u043c \u0433\u043e\u0442\u043e\u0432\u043d\u043e\u0441\u0442\u044c \u043e\u0431\u043e\u0438\u0445"}</b>
                <small>{duelPanoramaReady ? "\u041f\u0430\u043d\u043e\u0440\u0430\u043c\u0430 \u0433\u043e\u0442\u043e\u0432\u0430" : "\u0413\u0440\u0443\u0437\u0438\u043c \u043f\u0430\u043d\u043e\u0440\u0430\u043c\u0443"} В· {duelMapReady ? "\u041a\u0430\u0440\u0442\u0430 \u0433\u043e\u0442\u043e\u0432\u0430" : "\u0413\u0440\u0443\u0437\u0438\u043c \u043a\u0430\u0440\u0442\u0443"}</small>
              </div>
            ) : null}
          </div>
          {isReveal ? (
            <div className="pg-reveal-bar pg-duel-reveal-bar">
              <span>{"\u041f\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u043E\u0435 \u043C\u0435\u0441\u0442\u043E \u043F\u043E\u043A\u0430\u0437\u0430\u043D\u043E \u043D\u0430 \u043A\u0430\u0440\u0442\u0435"}</span>
              {visiblePlayers.map((player) => {
                const roundGuess = room.round?.guesses?.[player.id]
                return (
                  <b className="pg-duel-reveal-choice" key={player.id}>
                    <DuelPlayerAvatar player={player} />
                    <span>
                      {roundGuess
                        ? `${player.displayName}: ${Math.round(roundGuess.score || 0)} \u043e\u0447\u043a. / -${Math.round(player.lastDamage || 0)} HP / ${formatDistance(roundGuess.distance)}`
                        : `${player.displayName}: \u043d\u0435\u0442 \u043c\u0435\u0442\u043a\u0438`}
                    </span>
                  </b>
                )
              })}
              {room.status === "finished" ? <b>Матч завершен</b> : null}
              {room.status === "finished" ? (
                <div className="pg-duel-finished-actions">
                  <button type="button" className="pg-primary" onClick={nextRound}>{"\u041f\u0440\u043e\u0434\u043e\u043b\u0436\u0438\u0442\u044c"}</button>
                  <button type="button" className="pg-danger" onClick={leaveRoom}>{"\u0412\u044b\u0439\u0442\u0438"}</button>
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}

export default function PepeGuessrApp() {
  const [catalog, setCatalog] = useState(null)
  const [me, setMe] = useState({ authenticated: false, profile: null })
  const [mode, setMode] = useState(() => getPepeGuessrRouteMode())
  const [profileId, setProfileId] = useState(() => getPepeGuessrRouteProfileId())
  const [worldId, setWorldId] = useState(MIXED_WORLD_ID)
  const [dimensionId, setDimensionId] = useState("overworld")
  const [soloAutoStartKey, setSoloAutoStartKey] = useState(0)
  const [error, setError] = useState("")
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [gameSettings, setGameSettings] = useState(DEFAULT_PEPEGUESSR_SETTINGS)
  const [roomGameActive, setRoomGameActive] = useState(false)
  const [serverDown, setServerDown] = useState(false)
  const [loadRetryKey, setLoadRetryKey] = useState(0)

  const loadMe = useCallback(async () => {
    const payload = await fetchJson(pepeApi("me"))
    setMe(payload)
  }, [])

  useEffect(() => {
    if (!me?.authenticated) {
      return undefined
    }

    let alive = true
    const heartbeat = () => {
      if (document.visibilityState === "hidden") {
        return
      }
      fetchJson(pepeApi("presence"), { method: "POST" })
        .then((payload) => {
          if (alive && payload?.profile) {
            setMe({ authenticated: true, profile: payload.profile })
          }
        })
        .catch(() => {})
    }

    heartbeat()
    const interval = window.setInterval(heartbeat, PROFILE_PRESENCE_INTERVAL_MS)
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") heartbeat()
    }
    window.addEventListener("focus", heartbeat)
    document.addEventListener("visibilitychange", onVisibilityChange)

    return () => {
      alive = false
      window.clearInterval(interval)
      window.removeEventListener("focus", heartbeat)
      document.removeEventListener("visibilitychange", onVisibilityChange)
    }
  }, [me?.authenticated, me?.profile?.id])

  useEffect(() => {
    if (mode !== "notFound") {
      fetchJson(pepeApi("catalog"))
        .then((payload) => {
          setServerDown(false)
          setCatalog(payload)
          const worlds = Array.isArray(payload.worlds) ? payload.worlds : []
          const routeWorldId = getPepeGuessrRouteWorldId(worlds)
          const nextWorldId = routeWorldId || MIXED_WORLD_ID
          const nextWorld = worlds.find((world) => world.id === nextWorldId) || worlds[0] || null
          const routeDimensionId = getPepeGuessrRouteDimensionId(nextWorld)
          setWorldId(nextWorldId)
          setDimensionId(routeDimensionId || payload.defaultDimensionId || nextWorld?.dimensions?.find((dimension) => dimension.enabled)?.id || "overworld")
        })
        .catch(() => setServerDown(true))
    } else {
      setServerDown(false)
    }
    loadMe().catch(() => setServerDown(true))
    return undefined
  }, [loadMe, mode, loadRetryKey])

  const currentWorld = useMemo(() => {
    const worlds = Array.isArray(catalog?.worlds) ? catalog.worlds : []
    return worlds.find((world) => world.id === worldId) || worlds[0] || null
  }, [catalog?.worlds, worldId])

  useEffect(() => {
    setGameSettings(normalizePepeGuessrSettings(me?.profile?.settings || gameSettings))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.profile?.id, me?.profile?.settings])

  const updateGameSettings = useCallback((patch) => {
    setGameSettings((value) => normalizePepeGuessrSettings({ ...value, ...patch }))
  }, [])

  const saveGameSettings = useCallback(async () => {
    const nextSettings = normalizePepeGuessrSettings(gameSettings)
    setSettingsSaving(true)
    try {
      if (me?.authenticated) {
        const payload = await fetchJson(pepeApi("profile"), {
          method: "PATCH",
          body: JSON.stringify({ settings: nextSettings })
        })
        setMe({ authenticated: true, profile: payload.profile })
      }
      setGameSettings(nextSettings)
      setSettingsOpen(false)
    } catch (saveError) {
      setError(saveError.message)
    } finally {
      setSettingsSaving(false)
    }
  }, [gameSettings, me?.authenticated])

  const logout = useCallback(async () => {
    await fetchJson(pepeApi("logout"), { method: "POST" })
    setMe({ authenticated: false, profile: null })
  }, [])

  const navigate = useCallback((nextMode) => {
    setRoomGameActive(false)
    const nextPath = getPepeGuessrRoutePath(nextMode)
    if (window.location.pathname !== nextPath) {
      window.history.pushState({}, "", nextPath)
    }
    setProfileId(getPepeGuessrRouteProfileId(nextPath))
    setMode(nextMode)
  }, [])

  useEffect(() => {
    document.title = PEPEGUESSR_TITLE
    const normalizedPath = normalizeAppPath()
    if (window.location.pathname !== normalizedPath) {
      window.history.replaceState({}, "", normalizedPath)
    }
    if (normalizedPath === "/") {
      window.history.replaceState({}, "", PEPEGUESSR_ROUTE_PATHS.training)
      setMode("training")
    }
    const onPopState = () => {
      const nextMode = getPepeGuessrRouteMode()
      if (nextMode !== "room") {
        setRoomGameActive(false)
      }
      setMode(nextMode)
      setProfileId(getPepeGuessrRouteProfileId())
    }
    window.addEventListener("popstate", onPopState)
    return () => window.removeEventListener("popstate", onPopState)
  }, [])

  const showTraining = mode === "training" || mode === "soloGame"
  const showDuel = mode === "duel" || mode === "duelGame"
  const showRoom = mode === "room"
  const isErrorMode = serverDown || mode === "notFound"
  const isGameMode = !isErrorMode && (mode === "soloGame" || mode === "duelGame" || ((mode === "duel" || mode === "room") && roomGameActive))

  return (
    <main
      className={`pg-shell${isGameMode ? " pg-shell--game" : ""}`}
      style={{
        "--pg-map-scale": gameSettings.mapSize,
        "--pg-ui-scale": gameSettings.uiScale
      }}
    >
      {!isGameMode ? (
        <header className="pg-topbar">
          <a href={PEPEGUESSR_ROUTE_PATHS.training} className="pg-brand" onClick={(event) => { event.preventDefault(); navigate("training") }}>
            <img className="pg-app-logo" src="/pepe-brand-icon.svg" alt="" />
          </a>
          <nav className="pg-main-tabs">
            <button type="button" className={showTraining ? "is-active" : ""} onClick={() => navigate("training")}>{"Тренировка"}</button>
            <span className="pg-tab-separator" aria-hidden="true" />
            <button type="button" className={showDuel ? "is-active" : ""} onClick={() => navigate("duel")}>{"Дуэли"}</button>
            <span className="pg-tab-separator" aria-hidden="true" />
            <button type="button" className={showRoom ? "is-active" : ""} onClick={() => navigate("room")}>{"Комната"}</button>
          </nav>
          <ProfileBadge me={me} onLogout={logout} onProfile={() => navigate("profile")} active={mode === "profile"} />
        </header>
      ) : null}

      <GameSettingsPanel
        open={settingsOpen}
        settings={gameSettings}
        saving={settingsSaving}
        onClose={() => setSettingsOpen(false)}
        onChange={updateGameSettings}
        onSave={saveGameSettings}
      />

      {error ? <div className="pg-error">{error}<button type="button" onClick={() => setError("")}>{"\u0417\u0430\u043A\u0440\u044B\u0442\u044C"}</button></div> : null}

      {serverDown ? (
        <ErrorScreen type="405" onHome={() => { setServerDown(false); navigate("training"); setLoadRetryKey((value) => value + 1) }} />
      ) : mode === "notFound" ? (
        <ErrorScreen type="404" onHome={() => navigate("training")} />
      ) : !catalog || !currentWorld ? (
        <section className="pg-loading">{"\u0417\u0430\u0433\u0440\u0443\u0437\u043A\u0430..."}</section>
      ) : mode === "login" ? (
        <LoginPanel me={me} />
      ) : mode === "profile" ? (
        <ProfilePanel
          me={me}
          profileId={profileId}
          onError={setError}
          onProfileUpdated={(profile) => setMe({ authenticated: true, profile })}
        />
      ) : mode === "duelGame" || mode === "duel" ? (
        <DuelGame
          catalog={catalog}
          me={me}
          worldId={worldId}
          dimensionId={dimensionId}
          currentWorld={currentWorld}
          settings={gameSettings}
          lobbyKind="search"
          onExit={() => navigate("duel")}
          onTraining={() => navigate("training")}
          onError={setError}
          onOpenSettings={() => setSettingsOpen(true)}
          onActiveRoomChange={setRoomGameActive}
        />
      ) : mode === "room" ? (
        <DuelGame
          catalog={catalog}
          me={me}
          worldId={worldId}
          dimensionId={dimensionId}
          currentWorld={currentWorld}
          settings={gameSettings}
          lobbyKind="room"
          onExit={() => navigate("room")}
          onTraining={() => navigate("training")}
          onError={setError}
          onOpenSettings={() => setSettingsOpen(true)}
          onActiveRoomChange={setRoomGameActive}
        />
      ) : mode === "soloGame" ? (
        <SoloGame catalog={catalog} worldId={worldId} dimensionId={dimensionId} currentWorld={currentWorld} me={me} settings={gameSettings} autoStartKey={soloAutoStartKey} onExit={() => navigate("training")} onError={setError} onOpenSettings={() => setSettingsOpen(true)} />
      ) : (
        <ModeLandingCard mode="training" onStart={() => {
          clearClientSave(SOLO_SAVE_KEY)
          setSoloAutoStartKey((value) => value + 1)
          setMode("soloGame")
        }} />
      )}
    </main>
  )
}
