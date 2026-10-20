import fs from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import { ADMIN_DISCORD_ID, clearSessionCookie, getSessionFromRequest } from "./auth.js"

const DATA_DIR = path.join(process.cwd(), "data")
const STORAGE_DIR = path.join(process.cwd(), "server", "storage")
const LOCATIONS_FILE = path.join(DATA_DIR, "pepeguessr", "locations.json")
const PANORAMAS_DIR = path.join(process.cwd(), "public", "pepeguessr", "panoramas")
const PROFILES_FILE = path.join(STORAGE_DIR, "pepeguessr-profiles.json")
const ROOMS_FILE = path.join(STORAGE_DIR, "pepeguessr-rooms.json")
const MATCHES_FILE = path.join(STORAGE_DIR, "pepeguessr-matches.json")
const MAP_CATALOG_FILE = path.join(process.cwd(), "public", "maps", "catalog.json")

const ROUND_COUNT = 5
const ROUND_TIME_MS = 60_000
const GUESS_GRACE_MS = 15_000
const ROUND_READY_TIMEOUT_MS = 15_000
const ROOM_TTL_MS = 1000 * 60 * 60 * 3
const DUEL_ROUND_TIME_OPTIONS_MS = new Set([0, 15_000, 60_000, 120_000])
const SCORE_MAX = 5000
const SCORE_DECAY = 900
const DUEL_MAX_HP = 6000
const PLAYER_STALE_MS = 60_000
const TESTER_BADGE_FROM = process.env.PEPEGUESSR_TESTER_BADGE_FROM || "2026-01-01T00:00:00.000Z"
const TESTER_BADGE_TO = process.env.PEPEGUESSR_TESTER_BADGE_TO || "2026-06-14T23:59:59.999Z"
const PROFILE_ONLINE_WINDOW_MS = 90_000
const STREAMER_DISCORD_IDS = parseDiscordIdSet(process.env.PEPEGUESSR_STREAMER_DISCORD_IDS || process.env.STREAMER_DISCORD_IDS || "")
const DEVELOPER_DISCORD_IDS = parseDiscordIdSet(`${ADMIN_DISCORD_ID},${process.env.PEPEGUESSR_DEVELOPER_DISCORD_IDS || process.env.DEVELOPER_DISCORD_IDS || ""}`)
const FACE_IDS = ["front", "back", "left", "right", "up", "down"]
const IMAGE_EXTS = [".webp", ".png", ".jpg", ".jpeg"]
const FACE_ALIASES = {
  front: ["front", "panorama_2", "2"],
  left: ["left", "panorama_1", "1"],
  back: ["back", "panorama_0", "0"],
  right: ["right", "panorama_3", "3"],
  up: ["up", "top", "panorama_4", "4"],
  down: ["down", "bottom", "panorama_5", "5"]
}
function readString(value) {
  return typeof value === "string" ? value.trim() : ""
}

function parseDiscordIdSet(value) {
  return new Set(readString(value)
    .split(",")
    .map((item) => readString(item))
    .filter(Boolean))
}

function parseDateMs(value) {
  const timestamp = Date.parse(readString(value))
  return Number.isFinite(timestamp) ? timestamp : null
}

async function readLocalJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"))
  } catch {
    return fallback
  }
}

async function writeLocalJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

async function readStore(_key, filePath, fallback) {
  return readLocalJson(filePath, fallback)
}

async function writeStore(_key, filePath, value) {
  await writeLocalJson(filePath, value)
}

function defaultStats() {
  return {
    matchesPlayed: 0,
    wins: 0,
    losses: 0,
    longestDuelRounds: 0,
    soloRounds: 0,
    totalDistance: 0,
    totalGuesses: 0,
    bestRoundDistance: null,
    totalScore: 0
  }
}

function normalizeStats(stats) {
  const source = stats && typeof stats === "object" ? stats : {}
  const best = Number(source.bestRoundDistance)
  return {
    matchesPlayed: Math.max(0, Math.round(Number(source.matchesPlayed) || 0)),
    wins: Math.max(0, Math.round(Number(source.wins) || 0)),
    losses: Math.max(0, Math.round(Number(source.losses) || 0)),
    longestDuelRounds: Math.max(0, Math.round(Number(source.longestDuelRounds) || 0)),
    soloRounds: Math.max(0, Math.round(Number(source.soloRounds) || 0)),
    totalDistance: Math.max(0, Number(source.totalDistance) || 0),
    totalGuesses: Math.max(0, Math.round(Number(source.totalGuesses) || 0)),
    bestRoundDistance: Number.isFinite(best) && best >= 0 ? best : null,
    totalScore: Math.max(0, Math.round(Number(source.totalScore) || 0))
  }
}

function normalizeProfile(profile, index = 0) {
  const timestamp = new Date().toISOString()
  const discordId = readString(profile?.discordId || profile?.id)
  const profileCoverColor = normalizeProfileCoverColor(profile?.profileCoverColor || profile?.coverColor)
  return {
    id: readString(profile?.id) || (discordId ? `discord-${discordId}` : `profile-${index + 1}`),
    discordId,
    discordUsername: readString(profile?.discordUsername || profile?.username).replace(/^@+/, "").slice(0, 32),
    displayName: (readString(profile?.displayName) || "Игрок").slice(0, 32),
    minecraftName: readString(profile?.minecraftName).replace(/[^a-zA-Z0-9_]/g, "").slice(0, 16),
    avatarUrl: readString(profile?.avatarUrl),
    profileCoverColor,
    profileCoverColor2: normalizeProfileCoverColor(profile?.profileCoverColor2 || profile?.coverColor2 || profileCoverColor),
    createdAt: readString(profile?.createdAt) || timestamp,
    lastSeenAt: readString(profile?.lastSeenAt) || readString(profile?.createdAt),
    settings: normalizeSettings(profile?.settings),
    stats: normalizeStats(profile?.stats)
  }
}

function normalizeSettings(settings = {}) {
  const mapSize = Math.max(0.75, Math.min(1.35, Number(settings?.mapSize) || 1))
  const fov = Math.max(42, Math.min(120, Math.round(Number(settings?.fov) || 72)))
  const uiScale = Math.max(0.8, Math.min(1.2, Number(settings?.uiScale) || 1))
  return { mapSize, fov, uiScale }
}

function normalizeProfileCoverColor(value) {
  const color = readString(value).trim().toLowerCase()
  return /^#[0-9a-f]{6}$/.test(color) ? color : "#49a5ae"
}

function getProfileBadges(profile) {
  const discordId = readString(profile?.discordId)
  const registeredAt = parseDateMs(profile?.createdAt)
  const testerFrom = parseDateMs(TESTER_BADGE_FROM)
  const testerTo = parseDateMs(TESTER_BADGE_TO)
  const badges = []

  if (discordId && DEVELOPER_DISCORD_IDS.has(discordId)) {
    badges.push({ id: "developer", label: "Разработчик" })
  }

  if (discordId && STREAMER_DISCORD_IDS.has(discordId)) {
    badges.push({ id: "streamer", label: "Стример" })
  }

  if (
    Number.isFinite(registeredAt) &&
    Number.isFinite(testerFrom) &&
    Number.isFinite(testerTo) &&
    registeredAt >= testerFrom &&
    registeredAt <= testerTo
  ) {
    badges.push({ id: "tester", label: "Тестировщик" })
  }

  return badges
}

function publicProfile(profile) {
  const normalizedProfile = normalizeProfile(profile)
  const lastSeenAt = Date.parse(normalizedProfile.lastSeenAt)
  return {
    ...normalizedProfile,
    online: Number.isFinite(lastSeenAt) && Date.now() - lastSeenAt <= PROFILE_ONLINE_WINDOW_MS,
    badges: getProfileBadges(normalizedProfile)
  }
}

async function publicMatchHistory(profileId, limit = 5) {
  const id = readString(profileId)
  if (!id) return []
  const matches = await readStore("matches", MATCHES_FILE, [])
  return (Array.isArray(matches) ? matches : [])
    .filter((match) => Array.isArray(match?.players) && match.players.some((player) => player?.id === id))
    .slice(0, limit)
    .map((match) => {
      const winnerId = readString(match?.winnerId)
      return {
        id: readString(match?.id) || `match-${readString(match?.code || match?.roomCode)}`,
        mode: readString(match?.mode) || "duel",
        code: readString(match?.code || match?.roomCode),
        worldId: readString(match?.worldId),
        dimensionId: readString(match?.dimensionId),
        winnerId,
        result: winnerId ? (winnerId === id ? "win" : "loss") : "draw",
        roundCount: Math.max(0, Math.round(Number(match?.roundCount) || 0)),
        finishedAt: readString(match?.finishedAt),
        players: (Array.isArray(match?.players) ? match.players : []).map((player) => ({
          id: readString(player?.id),
          displayName: readString(player?.displayName) || "Игрок",
          avatarUrl: readString(player?.avatarUrl),
          minecraftName: readString(player?.minecraftName),
          score: Number(player?.score) || 0,
          hp: Number.isFinite(Number(player?.hp)) ? Number(player.hp) : DUEL_MAX_HP,
          badges: getProfileBadges(player)
        }))
      }
    })
}

function normalizeMinecraftName(value) {
  const name = readString(value).replace(/[^a-zA-Z0-9_]/g, "").slice(0, 16)
  return name.length >= 1 ? name : ""
}

function avatarUrl(user) {
  const id = readString(user?.id)
  const avatar = readString(user?.avatar)
  if (!id || !avatar) return ""
  return `https://cdn.discordapp.com/avatars/${id}/${avatar}.${avatar.startsWith("a_") ? "gif" : "png"}`
}

async function readProfiles() {
  const payload = await readStore("profiles", PROFILES_FILE, [])
  return Array.isArray(payload) ? payload.map(normalizeProfile) : []
}

async function writeProfiles(profiles) {
  await writeStore("profiles", PROFILES_FILE, profiles.map(normalizeProfile))
}

export async function upsertPepeGuessrProfileFromDiscord(user) {
  const discordId = readString(user?.id)
  if (!discordId) return null
  const profiles = await readProfiles()
  const index = profiles.findIndex((profile) => profile.discordId === discordId)
  const existing = index >= 0 ? profiles[index] : null
  const timestamp = new Date().toISOString()
  const profile = normalizeProfile({
    ...(existing || {}),
    id: existing?.id || `discord-${discordId}`,
    discordId,
    discordUsername: readString(user?.username),
    displayName: readString(user?.global_name) || readString(user?.username) || existing?.displayName || "Игрок",
    avatarUrl: avatarUrl(user) || existing?.avatarUrl || "",
    createdAt: existing?.createdAt || timestamp,
    lastSeenAt: timestamp,
    stats: existing?.stats || defaultStats()
  })
  if (index >= 0) profiles[index] = profile
  else profiles.push(profile)
  await writeProfiles(profiles)
  return profile
}

async function profileFromSession(req) {
  const session = getSessionFromRequest(req)
  const discordId = readString(session?.discordId || session?.userId)
  if (!discordId) return null
  return (await readProfiles()).find((profile) => profile.discordId === discordId) || null
}

function normalizeLocation(location, index = 0) {
  const cubemap = {}
  FACE_IDS.forEach((face) => {
    cubemap[face] = readString(location?.cubemap?.[face])
  })
  return {
    id: readString(location?.id) || `location-${index + 1}`,
    title: readString(location?.title) || `Точка ${index + 1}`,
    worldId: readString(location?.worldId) || "build_2",
    dimensionId: readString(location?.dimensionId) || "overworld",
    x: Number(location?.x) || 0,
    z: Number(location?.z) || 0,
    difficulty: readString(location?.difficulty) || "normal",
    tags: Array.isArray(location?.tags) ? location.tags.map(readString).filter(Boolean) : [],
    cubemap,
    enabled: location?.enabled !== false
  }
}

function normalizeDimensionId(value) {
  const input = readString(value).toLowerCase()
  if (input === "owerworld" || input === "over" || input === "world") return "overworld"
  if (["overworld", "nether", "end", "pale"].includes(input)) return input
  return input || "overworld"
}

function slugifyId(value) {
  return readString(value)
    .toLowerCase()
    .replace(/[^a-z0-9а-яё_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || `panorama-${Date.now()}`
}

function parsePanoramaFolderName(folderName) {
  const name = readString(folderName)
  const spacedMatch = name.match(/^(\S+)\s+(\S+)\s+(-?\d+)\s+(-?\d+)(?:\s+(.+))?$/)
  const underscoredMatch = name.match(/^(.+?)_(overworld|owerworld|nether|end|pale)_(-?\d+)_(-?\d+)(?:_(.+))?$/i)
  const match = spacedMatch || underscoredMatch
  if (!match) return null
  const x = Number(match[3])
  const z = Number(match[4])
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null
  return {
    worldId: readString(match[1]) || "build_2",
    dimensionId: normalizeDimensionId(match[2]),
    x,
    z,
    title: readString(match[5]) || `${readString(match[1]) || "build_2"} ${normalizeDimensionId(match[2])} X ${x} Z ${z}`
  }
}

function findFaceFile(fileNames, face) {
  const aliases = FACE_ALIASES[face] || [face]
  return fileNames.find((candidate) => {
    const ext = path.extname(candidate).toLowerCase()
    const base = path.basename(candidate, ext).toLowerCase()
    return aliases.includes(base) && IMAGE_EXTS.includes(ext)
  })
}

async function readPanoramaLocations() {
  let entries = []
  try {
    entries = await fs.readdir(PANORAMAS_DIR, { withFileTypes: true })
  } catch {
    return []
  }

  const locations = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const parsed = parsePanoramaFolderName(entry.name)
    if (!parsed) continue

    let files = []
    try {
      files = await fs.readdir(path.join(PANORAMAS_DIR, entry.name), { withFileTypes: true })
    } catch {
      continue
    }

    const fileNames = files.filter((file) => file.isFile()).map((file) => file.name)
    const cubemap = {}
    FACE_IDS.forEach((face) => {
      const fileName = findFaceFile(fileNames, face)
      cubemap[face] = fileName ? `/pepeguessr/panoramas/${encodeURIComponent(entry.name)}/${encodeURIComponent(fileName)}` : ""
    })

    if (!Object.values(cubemap).some(Boolean)) continue
    locations.push(normalizeLocation({
      id: `folder-${slugifyId(entry.name)}`,
      title: parsed.title,
      worldId: parsed.worldId,
      dimensionId: parsed.dimensionId,
      x: parsed.x,
      z: parsed.z,
      difficulty: "custom",
      tags: ["folder", "custom"],
      cubemap,
      enabled: true
    }))
  }

  return locations
}

async function readLocations() {
  const payload = await readLocalJson(LOCATIONS_FILE, { items: [] })
  const items = Array.isArray(payload?.items) ? payload.items : []
  const locations = items.map(normalizeLocation).filter((location) => location.enabled)
  // Folder names encode coordinates; complete panorama folders need no hand-written location entry.
  for (const location of await readPanoramaLocations()) {
    if (!locations.some((item) => item.id === location.id)) {
      locations.push(location)
    }
  }
  return locations
}

function publicLocation(location, reveal = false) {
  return {
    id: location.id,
    title: location.title,
    worldId: location.worldId,
    dimensionId: location.dimensionId,
    difficulty: location.difficulty,
    tags: location.tags,
    cubemap: publicCubemap(location),
    ...(reveal ? { x: location.x, z: location.z } : {})
  }
}

function publicCubemap(location) {
  const locationId = encodeURIComponent(locationToken(location))
  const result = {}
  FACE_IDS.forEach((face) => {
    result[face] = locationId ? `/api/pepeguessr?path=panoramas/${locationId}/${face}` : ""
  })
  return result
}

function locationToken(location) {
  const id = readString(location?.id)
  return id ? crypto.createHash("sha256").update(id).digest("hex").slice(0, 16) : ""
}

function contentTypeForAssetPath(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === ".png") return "image/png"
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg"
  if (ext === ".webp") return "image/webp"
  return "application/octet-stream"
}

function panoramaAssetFilePath(assetPath) {
  const source = readString(assetPath)
  const prefix = "/pepeguessr/panoramas/"
  if (!source.startsWith(prefix)) return ""
  const parts = source.slice(prefix.length).split("/").map((part) => decodeURIComponent(part))
  return path.join(PANORAMAS_DIR, ...parts)
}

function shuffle(items) {
  return [...items].sort(() => Math.random() - 0.5)
}

function playableLocationsForScope(locations, worldId, dimensionId) {
  const safeWorldId = readString(worldId)
  const safeDimensionId = readString(dimensionId)
  const scoped = locations.filter((location) => {
    if (safeWorldId && safeWorldId !== "mixed" && location.worldId !== safeWorldId) return false
    if (safeDimensionId && location.dimensionId !== safeDimensionId) return false
    return true
  })
  const folderLocations = scoped.filter((location) => Array.isArray(location.tags) && location.tags.includes("folder"))
  return folderLocations.length ? folderLocations : scoped
}

function chooseDuelLocation(locations, worldId, dimensionId) {
  return shuffle(playableLocationsForScope(locations, worldId, dimensionId))[0] || null
}

function createDuelRound(location, index) {
  return {
    id: `round-${index}-${location.id}-${Date.now()}`,
    index,
    status: index === 0 ? "waiting" : "pending",
    startedAt: 0,
    firstGuessAt: 0,
    revealedAt: 0,
    location,
    guesses: {},
    readyPlayers: {},
    loadingStartedAt: 0,
    damageApplied: false,
    damageMultiplier: undefined
  }
}

function prepareNextDuelRound(room, locations) {
  if (!room || room.finalRound || room.preparedRound) return null
  const nextLocation = chooseDuelLocation(locations, room.worldId, room.dimensionId)
  if (!nextLocation) return null
  room.preparedRound = createDuelRound(nextLocation, Number(room.currentRoundIndex || 0) + 1)
  room.preparedRound.status = "pending"
  return room.preparedRound
}

function score(location, guess) {
  const x = Number(guess?.x)
  const z = Number(guess?.z)
  if (!Number.isFinite(x) || !Number.isFinite(z)) return { distance: null, score: 0 }
  const distance = Math.sqrt((x - location.x) ** 2 + (z - location.z) ** 2)
  // Exponential decay keeps close guesses rewarding without a hard distance cutoff.
  return {
    distance: Number(distance.toFixed(2)),
    score: Math.max(0, Math.round(SCORE_MAX * Math.exp(-distance / SCORE_DECAY)))
  }
}

function duelDamageMultiplier(roundIndex = 0) {
  const roundNumber = Math.max(1, Math.round(Number(roundIndex) || 0) + 1)
  if (roundNumber >= 10) return 4
  if (roundNumber >= 8) return 3
  if (roundNumber >= 6) return 2
  return 1
}

function normalizeDamageMultiplierEnabled(value) {
  if (typeof value === "undefined") return true
  if (value === false) return false
  const text = readString(value).toLowerCase()
  return !["0", "false", "no", "off"].includes(text)
}

function roomDamageMultiplier(room, roundIndex = 0) {
  return normalizeDamageMultiplierEnabled(room?.damageMultiplierEnabled) ? duelDamageMultiplier(roundIndex) : 1
}

function normalizeDuelRoundTimeMs(value) {
  if (typeof value === "undefined") return ROUND_TIME_MS
  const text = readString(value).toLowerCase()
  if (value === null || text === "infinite" || text === "none" || text === "0") return 0
  const numeric = Math.round(Number(value))
  return DUEL_ROUND_TIME_OPTIONS_MS.has(numeric) ? numeric : ROUND_TIME_MS
}

function roomRoundTimeMs(room) {
  return normalizeDuelRoundTimeMs(Object.prototype.hasOwnProperty.call(room || {}, "roundTimeMs") ? room.roundTimeMs : undefined)
}

function roomRoundEndAt(room, round) {
  const startedAt = Number(round?.startedAt)
  if (!Number.isFinite(startedAt) || startedAt <= 0) return 0
  const roundTimeMs = roomRoundTimeMs(room)
  if (roundTimeMs > 0) return startedAt + roundTimeMs
  const firstGuessAt = Number(round?.firstGuessAt)
  return Number.isFinite(firstGuessAt) && firstGuessAt > 0 ? firstGuessAt + GUESS_GRACE_MS : 0
}

async function readRooms() {
  const payload = await readStore("rooms", ROOMS_FILE, [])
  const rooms = Array.isArray(payload) ? payload : []
  return rooms.filter((room) => Number(room?.expiresAt) > Date.now())
}

async function writeRooms(rooms) {
  await writeStore("rooms", ROOMS_FILE, rooms)
}

function isRoomJoinable(room) {
  return Boolean(room && Number(room.expiresAt) > Date.now() && ["waiting", "loading", "playing", "reveal"].includes(room.status))
}

function findActiveRoomForProfile(rooms, profileId, exceptCode = "") {
  const id = readString(profileId)
  const skipCode = readString(exceptCode).toUpperCase()
  if (!id) return null
  return rooms.find((room) =>
    isRoomJoinable(room) &&
    readString(room.code).toUpperCase() !== skipCode &&
    Array.isArray(room.players) &&
    room.players.some((player) => player.id === id)
  ) || null
}

function touchRoomPlayer(room, profileId, timestamp = Date.now()) {
  const player = room?.players?.find((item) => item.id === profileId)
  if (player) player.lastSeenAt = timestamp
  return player
}

function maybeMarkStaleOpponent(room, viewerId) {
  if (!room || !["loading", "playing", "reveal"].includes(room.status) || !Array.isArray(room.players) || room.players.length < 2) {
    return room
  }
  const currentTime = Date.now()
  const stalePlayer = room.players.find((player) => {
    if (player.id === viewerId) return false
    const seenAt = Number(player.lastSeenAt || room.createdAt || currentTime)
    return Number.isFinite(seenAt) && currentTime - seenAt >= PLAYER_STALE_MS
  })
  if (!stalePlayer) return room
  const winner = room.players.find((player) => player.id !== stalePlayer.id)
  room.status = "abandoned"
  room.winnerId = winner?.id || ""
  room.leftPlayerId = stalePlayer.id
  room.leftPlayerName = readString(stalePlayer.displayName) || "Соперник"
  room.leftAt = currentTime
  room.expiresAt = currentTime + ROOM_TTL_MS
  const round = currentRound(room)
  if (round) round.status = "abandoned"
  return room
}

async function updateStats(profileId, updater) {
  const profiles = await readProfiles()
  const index = profiles.findIndex((profile) => profile.id === profileId)
  if (index === -1) return
  profiles[index] = normalizeProfile({ ...profiles[index], stats: updater(normalizeStats(profiles[index].stats)), lastSeenAt: new Date().toISOString() })
  await writeProfiles(profiles)
}

async function recordGuess(profileId, result, mode) {
  if (!profileId || result.distance === null) return
  await updateStats(profileId, (stats) => ({
    ...stats,
    soloRounds: mode === "solo" ? stats.soloRounds + 1 : stats.soloRounds,
    totalDistance: stats.totalDistance + result.distance,
    totalGuesses: stats.totalGuesses + 1,
    bestRoundDistance: stats.bestRoundDistance === null ? result.distance : Math.min(stats.bestRoundDistance, result.distance),
    totalScore: stats.totalScore + result.score
  }))
}

function roomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  return Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("")
}

function currentRound(room) {
  return room?.rounds?.[room.currentRoundIndex || 0] || null
}

function maybeStartReadyTimedOutRound(room) {
  if (!room || room.status !== "loading" || !Array.isArray(room.players) || room.players.length < 2) return room
  const round = currentRound(room)
  if (!round) return room
  round.readyPlayers = round.readyPlayers && typeof round.readyPlayers === "object" ? round.readyPlayers : {}
  const readyTimes = Object.values(round.readyPlayers)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0)
  const allReady = room.players.every((player) => round.readyPlayers[player.id])
  const loadingStartedAt = Number(round.loadingStartedAt) || Math.min(...readyTimes, Date.now())
  const forceStart = readyTimes.length > 0 && Date.now() - loadingStartedAt >= ROUND_READY_TIMEOUT_MS
  if (!allReady && !forceStart) return room
  room.status = "playing"
  round.status = "playing"
  round.startedAt = Date.now()
  round.firstGuessAt = 0
  return room
}

function maybeReveal(room) {
  if (room.status !== "playing") return room
  const round = currentRound(room)
  if (!round || !Number.isFinite(Number(round.startedAt)) || Number(round.startedAt) <= 0) return room
  const guesses = round?.guesses || {}
  const allAnswered = room.players.every((player) => guesses[player.id])
  const roundEndAt = roomRoundEndAt(room, round)
  const timedOut = roundEndAt > 0 && roundEndAt <= Date.now()
  if (allAnswered || timedOut) {
    // Polling can revisit this round; apply duel damage only once.
    if (!round.damageApplied) {
      const multiplier = roomDamageMultiplier(room, room.currentRoundIndex)
      const scoredPlayers = room.players.map((player) => ({
        player,
        score: Math.max(0, Math.round(Number(guesses[player.id]?.score) || 0))
      }))
      const bestScore = Math.max(...scoredPlayers.map((entry) => entry.score))
      for (const entry of scoredPlayers) {
        const damage = entry.score < bestScore ? Math.round((bestScore - entry.score) * multiplier) : 0
        entry.player.lastDamage = damage
        entry.player.damage = (Number(entry.player.damage) || 0) + damage
        entry.player.hp = Math.max(0, (Number.isFinite(Number(entry.player.hp)) ? Number(entry.player.hp) : DUEL_MAX_HP) - damage)
      }
      round.damageApplied = true
      round.damageMultiplier = multiplier
      room.finalRound = room.players.some((player) => Number(player.hp) <= 0)
    }
    round.status = "reveal"
    round.revealedAt = round.revealedAt || Date.now()
    room.status = "reveal"
  }
  return room
}

function publicRoom(room, viewerId) {
  const safeRoom = maybeReveal(JSON.parse(JSON.stringify(room)))
  const round = currentRound(safeRoom)
  const isReveal = safeRoom.status === "reveal" || safeRoom.status === "finished"
  return {
    code: safeRoom.code,
    status: safeRoom.status,
    mode: "duel",
    matchmaking: Boolean(safeRoom.matchmaking),
    damageMultiplierEnabled: normalizeDamageMultiplierEnabled(safeRoom.damageMultiplierEnabled),
    worldId: safeRoom.worldId,
    dimensionId: safeRoom.dimensionId,
    roundCount: safeRoom.rounds.length,
    currentRoundIndex: safeRoom.currentRoundIndex,
    roundTimeMs: roomRoundTimeMs(safeRoom),
    guessGraceMs: GUESS_GRACE_MS,
    viewerPlayerId: viewerId,
    winnerId: readString(safeRoom.winnerId),
    leftPlayerId: readString(safeRoom.leftPlayerId),
    leftPlayerName: readString(safeRoom.leftPlayerName),
    leftAt: Number(safeRoom.leftAt) || null,
    viewerResult: safeRoom.status === "abandoned"
      ? (readString(safeRoom.leftPlayerId) && readString(safeRoom.leftPlayerId) !== viewerId ? "win" : "left")
      : readString(safeRoom.winnerId)
        ? (readString(safeRoom.winnerId) === viewerId ? "win" : "loss")
        : "",
    players: safeRoom.players.map((player) => ({
      id: player.id,
      displayName: player.displayName,
      avatarUrl: player.avatarUrl,
      minecraftName: readString(player.minecraftName),
      badges: getProfileBadges(player),
      score: Number(player.score) || 0,
      hp: Number.isFinite(Number(player.hp)) ? Number(player.hp) : DUEL_MAX_HP,
      maxHp: DUEL_MAX_HP,
      damage: Number(player.damage) || 0,
      lastDamage: Number(player.lastDamage) || 0,
      hasGuessed: Boolean(round?.guesses?.[player.id])
    })),
    round: round ? {
      id: round.id,
      startedAt: round.startedAt,
      revealedAt: Number(round.revealedAt) || 0,
      firstGuessAt: Number(round.firstGuessAt) || null,
      endsAt: roomRoundEndAt(safeRoom, round),
      damageMultiplier: Number(round.damageMultiplier) || roomDamageMultiplier(safeRoom, safeRoom.currentRoundIndex),
      status: round.status,
      location: publicLocation(normalizeLocation(round.location), isReveal),
      guesses: isReveal ? round.guesses : viewerId && round.guesses?.[viewerId] ? { [viewerId]: round.guesses[viewerId] } : {}
    } : null,
    nextRoundLocation: isReveal && !safeRoom.finalRound && safeRoom.preparedRound?.location
      ? publicLocation(normalizeLocation(safeRoom.preparedRound.location))
      : null
  }
}

function send(res, status, payload) {
  res.status(status).json(payload)
}

export default async function handler(req, res) {
  const rawPath = req.query.path
  const decodedPath = Array.isArray(rawPath)
    ? rawPath.map((part) => {
        try {
          return decodeURIComponent(readString(part))
        } catch {
          return readString(part)
        }
      }).join("/")
    : (() => {
        const value = readString(rawPath)
        try {
          return decodeURIComponent(value)
        } catch {
          return value
        }
      })()
  const pathParts = decodedPath.split("/").map(readString).filter(Boolean)
  const [part, code, action] = pathParts

  try {
    if (req.method === "GET" && part === "panoramas" && code && action) {
      if (!FACE_IDS.includes(action)) return send(res, 404, { message: "Not found" })
      const locations = await readLocations()
      const location = locations.find((item) => item.id === code || locationToken(item) === code)
      const filePath = panoramaAssetFilePath(location?.cubemap?.[action])
      if (!filePath) return send(res, 404, { message: "Not found" })
      try {
        const buffer = await fs.readFile(filePath)
        res.setHeader("Access-Control-Allow-Origin", "*")
        res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS")
        res.setHeader("Access-Control-Allow-Headers", "Content-Type")
        res.setHeader("Cross-Origin-Resource-Policy", "cross-origin")
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable")
        res.setHeader("Content-Type", contentTypeForAssetPath(filePath))
        return res.status(200).send(buffer)
      } catch {
        return send(res, 404, { message: "Not found" })
      }
    }

    if (req.method === "GET" && part === "me") {
      const profile = await profileFromSession(req)
      return send(res, 200, { authenticated: Boolean(profile), profile: profile ? publicProfile(profile) : null })
    }

    if (req.method === "POST" && part === "presence") {
      const profile = await profileFromSession(req)
      if (!profile) return send(res, 401, { message: "Требуется вход" })
      const profiles = await readProfiles()
      const index = profiles.findIndex((item) => item.id === profile.id)
      if (index === -1) return send(res, 404, { message: "Профиль не найден" })
      profiles[index] = normalizeProfile({ ...profiles[index], lastSeenAt: new Date().toISOString() })
      await writeProfiles(profiles)
      return send(res, 200, { ok: true, profile: publicProfile(profiles[index]) })
    }

    if (req.method === "GET" && part === "profiles" && code) {
      const profiles = await readProfiles()
      const profile = profiles.find((item) => item.id === code || item.discordId === code)
      if (!profile) return send(res, 404, { message: "Профиль не найден" })
      return send(res, 200, {
        profile: publicProfile(profile),
        history: await publicMatchHistory(profile.id, 5)
      })
    }

    if (req.method === "PATCH" && part === "profile") {
      const profile = await profileFromSession(req)
      if (!profile) return send(res, 401, { message: "Войдите через Discord, чтобы менять профиль" })
      const profiles = await readProfiles()
      const index = profiles.findIndex((item) => item.id === profile.id)
      if (index === -1) return send(res, 404, { message: "Профиль не найден" })
      const hasMinecraftName = Object.prototype.hasOwnProperty.call(req.body || {}, "minecraftName")
      const minecraftName = normalizeMinecraftName(req.body?.minecraftName)
      const hasProfileCoverColor = Object.prototype.hasOwnProperty.call(req.body || {}, "profileCoverColor")
      const profileCoverColor = normalizeProfileCoverColor(req.body?.profileCoverColor)
      const hasProfileCoverColor2 = Object.prototype.hasOwnProperty.call(req.body || {}, "profileCoverColor2")
      const profileCoverColor2 = normalizeProfileCoverColor(req.body?.profileCoverColor2)
      if (hasMinecraftName && minecraftName.length < 1) return send(res, 400, { message: "Ник не должен быть пустым" })
      profiles[index] = normalizeProfile({
        ...profiles[index],
        ...(hasMinecraftName ? { minecraftName } : {}),
        ...(hasProfileCoverColor ? { profileCoverColor } : {}),
        ...(hasProfileCoverColor2 ? { profileCoverColor2 } : {}),
        ...(req.body?.settings ? { settings: normalizeSettings(req.body.settings) } : {}),
        lastSeenAt: new Date().toISOString()
      })
      await writeProfiles(profiles)
      return send(res, 200, { profile: publicProfile(profiles[index]) })
    }

    if (req.method === "POST" && part === "logout") {
      const profile = await profileFromSession(req)
      if (profile) {
        const profiles = await readProfiles()
        const index = profiles.findIndex((item) => item.id === profile.id)
        if (index !== -1) {
          profiles[index] = normalizeProfile({ ...profiles[index], lastSeenAt: new Date(0).toISOString() })
          await writeProfiles(profiles)
        }
      }
      clearSessionCookie(res)
      return send(res, 200, { ok: true })
    }

    if (req.method === "GET" && part === "catalog") {
      const catalog = await readLocalJson(MAP_CATALOG_FILE, { worlds: [] })
      const counts = {}
      ;(await readLocations()).forEach((location) => {
        const key = `${location.worldId}:${location.dimensionId}`
        counts[key] = (counts[key] || 0) + 1
      })
      return send(res, 200, {
        worlds: catalog.worlds || [],
        defaultWorldId: catalog.defaultWorldId || "build_2",
        defaultDimensionId: catalog.defaultDimensionId || "overworld",
        roundTimeMs: ROUND_TIME_MS,
        defaultRoundCount: ROUND_COUNT,
        locationCounts: counts
      })
    }

    if (req.method === "POST" && part === "solo" && code === "start") {
      const worldId = readString(req.body?.worldId) || "build_2"
      const dimensionId = readString(req.body?.dimensionId) || "overworld"
      const rounds = shuffle(playableLocationsForScope(await readLocations(), worldId, dimensionId)).slice(0, ROUND_COUNT)
      if (!rounds.length) return send(res, 404, { message: "Для выбранного мира пока нет точек Пепегессера" })
      return send(res, 201, {
        match: {
          id: `solo-${Date.now()}`,
          mode: "solo",
          worldId,
          dimensionId,
          roundCount: rounds.length,
          roundTimeMs: ROUND_TIME_MS,
          rounds: rounds.map((location, index) => ({ id: `solo-${index}-${location.id}`, index, location: publicLocation(location) }))
        }
      })
    }

    if (req.method === "POST" && part === "solo" && code === "guess") {
      const location = (await readLocations()).find((item) => item.id === readString(req.body?.locationId))
      if (!location) return send(res, 404, { message: "Точка не найдена" })
      const result = score(location, req.body)
      const profile = await profileFromSession(req)
      if (profile) await recordGuess(profile.id, result, "solo")
      return send(res, 200, { result: { guess: { x: Number(req.body?.x), z: Number(req.body?.z) }, ...result, location: publicLocation(location, true) } })
    }

    if (part === "rooms") {
      const profile = await profileFromSession(req)
      if (!profile) return send(res, 401, { message: "Войдите через Discord, чтобы играть 1v1" })
      const rooms = await readRooms()

      if (req.method === "POST" && code === "matchmake") {
        const worldId = readString(req.body?.worldId) || "build_2"
        const dimensionId = readString(req.body?.dimensionId) || "overworld"
        const roundTimeMs = normalizeDuelRoundTimeMs(req.body?.roundTimeMs)
        const damageMultiplierEnabled = normalizeDamageMultiplierEnabled(req.body?.damageMultiplierEnabled)
        const activeRoom = findActiveRoomForProfile(rooms, profile.id)
        if (activeRoom) {
          touchRoomPlayer(activeRoom, profile.id)
          await writeRooms(rooms)
          return send(res, 200, {
            room: publicRoom(activeRoom, profile.id),
            matched: activeRoom.players.length >= 2,
            rejoined: true
          })
        }
        const waitingIndex = rooms.findIndex((room) =>
          room.status === "waiting" &&
          room.matchmaking &&
          readString(room.worldId) === worldId &&
          readString(room.dimensionId) === dimensionId &&
          roomRoundTimeMs(room) === roundTimeMs &&
          normalizeDamageMultiplierEnabled(room.damageMultiplierEnabled) === damageMultiplierEnabled &&
          room.players.length === 1 &&
          !room.players.some((player) => player.id === profile.id)
        )

        if (waitingIndex >= 0) {
          const room = rooms[waitingIndex]
          room.players.push({
            id: profile.id,
            discordId: profile.discordId,
            displayName: profile.displayName,
            avatarUrl: profile.avatarUrl,
            minecraftName: profile.minecraftName,
            createdAt: profile.createdAt,
            lastSeenAt: Date.now(),
            score: 0,
            hp: DUEL_MAX_HP,
            damage: 0,
            lastDamage: 0
          })
          room.status = "loading"
          room.rounds[0].status = "loading"
          room.rounds[0].startedAt = 0
          room.rounds[0].firstGuessAt = 0
          room.rounds[0].readyPlayers = {}
          room.rounds[0].loadingStartedAt = Date.now()
          rooms[waitingIndex] = room
          await writeRooms(rooms)
          return send(res, 200, { room: publicRoom(room, profile.id), matched: true })
        }

        const firstLocation = chooseDuelLocation(await readLocations(), worldId, dimensionId)
        if (!firstLocation) return send(res, 404, { message: "Для выбранного мира пока нет точек Пепегессера" })
        let nextCode = roomCode()
        while (rooms.some((room) => room.code === nextCode)) nextCode = roomCode()
        const createdAt = Date.now()
        const room = {
          code: nextCode,
          status: "waiting",
          matchmaking: true,
          worldId,
          dimensionId,
          roundTimeMs,
          damageMultiplierEnabled,
          currentRoundIndex: 0,
          players: [{
            id: profile.id,
            discordId: profile.discordId,
            displayName: profile.displayName,
            avatarUrl: profile.avatarUrl,
            minecraftName: profile.minecraftName,
            createdAt: profile.createdAt,
            lastSeenAt: createdAt,
            score: 0,
            hp: DUEL_MAX_HP,
            damage: 0,
            lastDamage: 0
          }],
          rounds: [createDuelRound(firstLocation, 0)],
          createdAt,
          expiresAt: createdAt + ROOM_TTL_MS
        }
        rooms.push(room)
        await writeRooms(rooms)
        return send(res, 201, { room: publicRoom(room, profile.id), matched: false })
      }

      if (req.method === "POST" && !code) {
        const worldId = readString(req.body?.worldId) || "build_2"
        const dimensionId = readString(req.body?.dimensionId) || "overworld"
        const roundTimeMs = normalizeDuelRoundTimeMs(req.body?.roundTimeMs)
        const damageMultiplierEnabled = normalizeDamageMultiplierEnabled(req.body?.damageMultiplierEnabled)
        const activeRoom = findActiveRoomForProfile(rooms, profile.id)
        if (activeRoom) {
          touchRoomPlayer(activeRoom, profile.id)
          await writeRooms(rooms)
          return send(res, 200, { room: publicRoom(activeRoom, profile.id), rejoined: true })
        }
        const firstLocation = chooseDuelLocation(await readLocations(), worldId, dimensionId)
        if (!firstLocation) return send(res, 404, { message: "Для выбранного мира пока нет точек Пепегессера" })
        let nextCode = roomCode()
        while (rooms.some((room) => room.code === nextCode)) nextCode = roomCode()
        const room = {
          code: nextCode,
          status: "waiting",
          worldId,
          dimensionId,
          roundTimeMs,
          damageMultiplierEnabled,
          currentRoundIndex: 0,
          players: [{ id: profile.id, discordId: profile.discordId, displayName: profile.displayName, avatarUrl: profile.avatarUrl, minecraftName: profile.minecraftName, createdAt: profile.createdAt, lastSeenAt: Date.now(), score: 0, hp: DUEL_MAX_HP, damage: 0, lastDamage: 0 }],
          rounds: [createDuelRound(firstLocation, 0)],
          createdAt: Date.now(),
          expiresAt: Date.now() + ROOM_TTL_MS
        }
        rooms.push(room)
        await writeRooms(rooms)
        return send(res, 201, { room: publicRoom(room, profile.id) })
      }

      const roomIndex = rooms.findIndex((room) => room.code === readString(code).toUpperCase())
      if (req.method === "POST" && action === "leave" && roomIndex === -1) return send(res, 200, { left: true })
      if (roomIndex === -1) return send(res, 404, { message: "Комната не найдена" })
      const room = rooms[roomIndex]

      if (req.method === "POST" && action === "join") {
        const activeRoom = findActiveRoomForProfile(rooms, profile.id, code)
        if (activeRoom) {
          touchRoomPlayer(activeRoom, profile.id)
          await writeRooms(rooms)
          return send(res, 200, { room: publicRoom(activeRoom, profile.id), rejoined: true })
        }
        touchRoomPlayer(room, profile.id)
        if (!room.players.some((player) => player.id === profile.id)) {
          if (room.players.length >= 2) return send(res, 409, { message: "Комната уже заполнена" })
          room.players.push({ id: profile.id, discordId: profile.discordId, displayName: profile.displayName, avatarUrl: profile.avatarUrl, minecraftName: profile.minecraftName, createdAt: profile.createdAt, lastSeenAt: Date.now(), score: 0, hp: DUEL_MAX_HP, damage: 0, lastDamage: 0 })
        }
        if (room.players.length === 2 && room.status === "waiting") {
          room.status = "loading"
          room.rounds[0].status = "loading"
          room.rounds[0].startedAt = 0
          room.rounds[0].firstGuessAt = 0
          room.rounds[0].readyPlayers = {}
          room.rounds[0].loadingStartedAt = Date.now()
        }
        rooms[roomIndex] = room
        await writeRooms(rooms)
        return send(res, 200, { room: publicRoom(room, profile.id) })
      }

      if (req.method === "POST" && action === "leave") {
        if (!room.players.some((player) => player.id === profile.id)) return send(res, 403, { message: "Вы не участник этой комнаты" })
        const leavingPlayer = room.players.find((player) => player.id === profile.id)
        room.players = room.players.filter((player) => player.id !== profile.id)
        if (!room.players.length) {
          rooms.splice(roomIndex, 1)
          await writeRooms(rooms)
          return send(res, 200, { left: true })
        }
        room.status = "abandoned"
        room.winnerId = room.players[0]?.id || ""
        room.leftPlayerId = profile.id
        room.leftPlayerName = readString(leavingPlayer?.displayName || profile.displayName)
        room.leftAt = Date.now()
        room.expiresAt = Date.now() + ROOM_TTL_MS
        const round = currentRound(room)
        if (round) round.status = "abandoned"
        rooms[roomIndex] = room
        await writeRooms(rooms)
        return send(res, 200, { left: true })
      }

      if (req.method === "GET" && code && !action) {
        touchRoomPlayer(room, profile.id)
        rooms[roomIndex] = maybeMarkStaleOpponent(maybeReveal(maybeStartReadyTimedOutRound(room)), profile.id)
        if (rooms[roomIndex].status === "reveal") {
          prepareNextDuelRound(rooms[roomIndex], await readLocations())
        }
        await writeRooms(rooms)
        return send(res, 200, { room: publicRoom(rooms[roomIndex], profile.id) })
      }

      if (req.method === "POST" && action === "ready") {
        touchRoomPlayer(room, profile.id)
        if (!room.players.some((player) => player.id === profile.id)) return send(res, 403, { message: "Not a room player" })
        if (room.status === "abandoned") return send(res, 200, { room: publicRoom(room, profile.id) })
        if (room.status === "playing" || room.status === "reveal" || room.status === "finished") return send(res, 200, { room: publicRoom(room, profile.id) })
        if (room.status !== "loading") return send(res, 409, { message: "Round is not ready for sync yet" })
        const round = currentRound(room)
        if (!round) return send(res, 404, { message: "Round not found" })
        round.readyPlayers = round.readyPlayers && typeof round.readyPlayers === "object" ? round.readyPlayers : {}
        round.loadingStartedAt = Number(round.loadingStartedAt) || Date.now()
        round.readyPlayers[profile.id] = Date.now()
        const allReady = room.players.length >= 2 && room.players.every((player) => round.readyPlayers[player.id])
        const readyTimedOutRoom = maybeStartReadyTimedOutRound(room)
        if (readyTimedOutRoom.status === "playing") {
          rooms[roomIndex] = readyTimedOutRoom
          await writeRooms(rooms)
          return send(res, 200, { room: publicRoom(readyTimedOutRoom, profile.id) })
        }
        if (allReady) {
          room.status = "playing"
          round.status = "playing"
          round.startedAt = Date.now()
          round.firstGuessAt = 0
        }
        rooms[roomIndex] = room
        await writeRooms(rooms)
        return send(res, 200, { room: publicRoom(room, profile.id) })
      }

      if (req.method === "POST" && action === "guess") {
        touchRoomPlayer(room, profile.id)
        if (!room.players.some((player) => player.id === profile.id)) return send(res, 403, { message: "Вы не участник этой комнаты" })
        if (room.status === "abandoned") return send(res, 409, { message: "Opponent left" })
        if (room.status !== "playing") return send(res, 409, { message: "Сейчас нельзя отправить ответ" })
        const round = currentRound(room)
        if (!round || !Number.isFinite(Number(round.startedAt)) || Number(round.startedAt) <= 0) return send(res, 409, { message: "Round is still loading" })
        if (round.guesses?.[profile.id]) return send(res, 409, { message: "Ответ уже отправлен" })
        const result = score(normalizeLocation(round.location), req.body)
        round.guesses[profile.id] = { x: Number(req.body?.x), z: Number(req.body?.z), submittedAt: Date.now(), ...result }
        round.firstGuessAt = round.firstGuessAt || Date.now()
        const player = room.players.find((item) => item.id === profile.id)
        player.score = (Number(player.score) || 0) + result.score
        await recordGuess(profile.id, result, "duel")
        rooms[roomIndex] = maybeReveal(room)
        if (rooms[roomIndex].status === "reveal") {
          prepareNextDuelRound(rooms[roomIndex], await readLocations())
        }
        await writeRooms(rooms)
        return send(res, 200, { room: publicRoom(rooms[roomIndex], profile.id) })
      }

      if (req.method === "POST" && action === "next") {
        touchRoomPlayer(room, profile.id)
        if (!room.players.some((player) => player.id === profile.id)) return send(res, 403, { message: "Not a room player" })
        if (room.status === "abandoned") return send(res, 200, { room: publicRoom(room, profile.id) })
        if (room.status === "finished") {
          const nextLocation = chooseDuelLocation(await readLocations(), room.worldId, room.dimensionId)
          if (!nextLocation) return send(res, 404, { message: "Р”Р»СЏ РІС‹Р±СЂР°РЅРЅРѕРіРѕ РјРёСЂР° РїРѕРєР° РЅРµС‚ С‚РѕС‡РµРє РџРµРїРµРіРµСЃСЃРµСЂР°" })
          room.status = "loading"
          room.currentRoundIndex = 0
          room.finalRound = false
          room.winnerId = ""
          room.leftPlayerId = ""
          room.leftPlayerName = ""
          room.leftAt = 0
          room.preparedRound = null
          room.expiresAt = Date.now() + ROOM_TTL_MS
          room.players = room.players.map((player) => ({ ...player, score: 0, hp: DUEL_MAX_HP, damage: 0, lastDamage: 0 }))
          room.rounds = [createDuelRound(nextLocation, 0)]
          room.rounds[0].status = "loading"
          rooms[roomIndex] = room
          await writeRooms(rooms)
          return send(res, 200, { room: publicRoom(room, profile.id) })
        }
        if (room.status !== "reveal") {
          if (room.status === "loading" || room.status === "playing") return send(res, 200, { room: publicRoom(room, profile.id) })
          return send(res, 409, { message: "Следующий раунд доступен после reveal" })
        }
        if (room.finalRound) {
          room.status = "finished"
          const winnerId = [...room.players].sort((a, b) => {
            const hpDelta = Number(b.hp) - Number(a.hp)
            return hpDelta || Number(b.score) - Number(a.score)
          })[0]?.id
          room.winnerId = winnerId
          const roundCount = Math.max(1, Number(room.currentRoundIndex) + 1)
          for (const player of room.players) {
            await updateStats(player.id, (stats) => ({
              ...stats,
              matchesPlayed: stats.matchesPlayed + 1,
              wins: player.id === winnerId ? stats.wins + 1 : stats.wins,
              losses: player.id === winnerId ? stats.losses : stats.losses + 1,
              longestDuelRounds: Math.max(stats.longestDuelRounds || 0, roundCount)
            }))
          }
          const matches = await readStore("matches", MATCHES_FILE, [])
          await writeStore("matches", MATCHES_FILE, [{
            id: `duel-${room.code}-${Date.now()}`,
            mode: "duel",
            code: room.code,
            roomCode: room.code,
            worldId: room.worldId,
            dimensionId: room.dimensionId,
            winnerId,
            roundCount,
            players: room.players,
            finishedAt: new Date().toISOString()
          }, ...(Array.isArray(matches) ? matches : [])].slice(0, 500))
        } else {
          currentRound(room).status = "done"
          room.currentRoundIndex += 1
          const preparedRound = room.preparedRound ? { ...room.preparedRound, index: room.currentRoundIndex } : null
          const nextLocation = preparedRound?.location || chooseDuelLocation(await readLocations(), room.worldId, room.dimensionId)
          if (!nextLocation) return send(res, 404, { message: "Для выбранного мира пока нет точек Пепегессера" })
          room.rounds[room.currentRoundIndex] = preparedRound || createDuelRound(nextLocation, room.currentRoundIndex)
          delete room.preparedRound
          currentRound(room).status = "loading"
          currentRound(room).startedAt = 0
          currentRound(room).firstGuessAt = 0
          currentRound(room).readyPlayers = {}
          currentRound(room).loadingStartedAt = Date.now()
          room.status = "loading"
        }
        rooms[roomIndex] = room
        await writeRooms(rooms)
        return send(res, 200, { room: publicRoom(room, profile.id) })
      }
    }

    return send(res, 404, { message: "Not found" })
  } catch (error) {
    return send(res, 500, { message: error instanceof Error ? error.message : "Server error" })
  }
}
