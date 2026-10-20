import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const frontendPublic = path.join(root, "frontend/public")
const backendPublic = path.join(root, "backend/public")

test("enabled maps reference existing tile images", async () => {
  const catalog = JSON.parse(await fs.readFile(path.join(frontendPublic, "maps/catalog.json"), "utf8"))
  for (const world of catalog.worlds) {
    for (const dimension of world.dimensions.filter((item) => item.enabled)) {
      const manifestPath = dimension.manifestPath || world.manifestPath
      const manifest = JSON.parse(await fs.readFile(path.join(frontendPublic, manifestPath.slice(1)), "utf8"))
      assert.ok(manifest.tiles.length > 0, `${world.id}/${dimension.id}`)
      for (const tile of manifest.tiles) {
        const image = tile.srcPng || tile.srcWebp || tile.src
        await fs.access(path.join(frontendPublic, image.slice(1)))
      }
    }
  }
})

test("every discoverable panorama has all six cube faces", async () => {
  const parent = path.join(backendPublic, "pepeguessr/panoramas")
  const directories = (await fs.readdir(parent, { withFileTypes: true })).filter((entry) => entry.isDirectory())
  assert.ok(directories.length > 0)
  for (const entry of directories) {
    const files = await fs.readdir(path.join(parent, entry.name))
    for (const index of [0, 1, 2, 3, 4, 5]) {
      assert.ok(files.includes(`panorama_${index}.png`), `${entry.name}: missing face ${index}`)
    }
  }
})
