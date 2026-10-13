/**
 * Browser-side asset loader.
 * Loads PNG sprite sheets via Image + offscreen Canvas, converts to SpriteData.
 */

import type { SpriteData, OfficeLayout } from '../types'
import { setCharacterTemplates } from './spriteData'
import { setFloorSprites } from '../floorTiles'
import { setWallSprites } from '../wallTiles'

// ── Constants ──────────────────────────────────────────────────

const PNG_ALPHA_THRESHOLD = 128

// Character sprite sheets: 112×96 each (7 frames × 3 directions, 16×32 per frame)
const CHAR_FRAME_W = 16
const CHAR_FRAME_H = 32
const CHAR_FRAMES_PER_ROW = 7
const CHAR_COUNT = 6
const CHAR_DIRECTIONS = ['down', 'up', 'right'] as const

// Wall sprite sheet: 64×128 (4×4 grid of 16×32 pieces)
const WALL_PIECE_W = 16
const WALL_PIECE_H = 32
const WALL_GRID_COLS = 4
const WALL_BITMASK_COUNT = 16

// Tileset: 256×512, 16×16 per tile
const TILESET_TILE = 16

// ── Helpers ────────────────────────────────────────────────────

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = (e) => reject(new Error(`Failed to load image: ${url} — ${e}`))
    img.src = url
  })
}

/**
 * Extract a rectangular region from an image as SpriteData.
 * Handles out-of-bounds source coordinates by clamping to image bounds.
 */
function imageRegionToSprite(
  img: HTMLImageElement,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
): SpriteData {
  const canvas = document.createElement('canvas')
  canvas.width = sw
  canvas.height = sh
  const ctx = canvas.getContext('2d')!

  // Clamp source rectangle to image bounds
  const imgW = img.naturalWidth
  const imgH = img.naturalHeight
  const clampSx = Math.max(0, sx)
  const clampSy = Math.max(0, sy)
  const clampRight = Math.min(sx + sw, imgW)
  const clampBottom = Math.min(sy + sh, imgH)
  const clampSw = clampRight - clampSx
  const clampSh = clampBottom - clampSy

  if (clampSw > 0 && clampSh > 0) {
    const dx = clampSx - sx
    const dy = clampSy - sy
    ctx.drawImage(img, clampSx, clampSy, clampSw, clampSh, dx, dy, clampSw, clampSh)
  }

  const imageData = ctx.getImageData(0, 0, sw, sh)
  const { data } = imageData

  const sprite: SpriteData = []
  for (let y = 0; y < sh; y++) {
    const row: string[] = []
    for (let x = 0; x < sw; x++) {
      const idx = (y * sw + x) * 4
      const r = data[idx]
      const g = data[idx + 1]
      const b = data[idx + 2]
      const a = data[idx + 3]
      if (a < PNG_ALPHA_THRESHOLD) {
        row.push('')
      } else {
        row.push(
          `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`.toUpperCase(),
        )
      }
    }
    sprite.push(row)
  }
  return sprite
}

/** Check if a sprite is completely transparent (no visible pixels). */
function isSpriteEmpty(sprite: SpriteData): boolean {
  for (const row of sprite) {
    for (const px of row) {
      if (px !== '') return false
    }
  }
  return true
}

/** Generate a simple colored rectangle sprite as fallback. */
function generateFallbackSprite(w: number, h: number, fill: string, edge: string): SpriteData {
  const sprite: SpriteData = []
  for (let y = 0; y < h; y++) {
    const row: string[] = []
    for (let x = 0; x < w; x++) {
      if (x === 0 || x === w - 1 || y === 0 || y === h - 1) {
        row.push(edge)
      } else {
        row.push(fill)
      }
    }
    sprite.push(row)
  }
  return sprite
}

// ── Character loading ──────────────────────────────────────────

interface CharacterDirectionSprites {
  down: SpriteData[]
  up: SpriteData[]
  right: SpriteData[]
}

async function loadCharacterSprites(): Promise<CharacterDirectionSprites[]> {
  const characters: CharacterDirectionSprites[] = []

  for (let ci = 0; ci < CHAR_COUNT; ci++) {
    const img = await loadImage(`/assets/characters/char_${ci}.png`)
    const charData: CharacterDirectionSprites = { down: [], up: [], right: [] }

    for (let dirIdx = 0; dirIdx < CHAR_DIRECTIONS.length; dirIdx++) {
      const dir = CHAR_DIRECTIONS[dirIdx]
      const rowY = dirIdx * CHAR_FRAME_H
      const frames: SpriteData[] = []

      for (let f = 0; f < CHAR_FRAMES_PER_ROW; f++) {
        const frameX = f * CHAR_FRAME_W
        frames.push(imageRegionToSprite(img, frameX, rowY, CHAR_FRAME_W, CHAR_FRAME_H))
      }
      charData[dir] = frames
    }
    characters.push(charData)
  }

  return characters
}

// ── Wall loading ───────────────────────────────────────────────

async function loadWallTileSprites(): Promise<SpriteData[]> {
  const img = await loadImage('/assets/walls.png')
  const sprites: SpriteData[] = []

  for (let mask = 0; mask < WALL_BITMASK_COUNT; mask++) {
    const ox = (mask % WALL_GRID_COLS) * WALL_PIECE_W
    const oy = Math.floor(mask / WALL_GRID_COLS) * WALL_PIECE_H
    sprites.push(imageRegionToSprite(img, ox, oy, WALL_PIECE_W, WALL_PIECE_H))
  }

  return sprites
}

// ── Floor tile patterns ────────────────────────────────────────

function generateFloorPatterns(): SpriteData[] {
  const size = TILESET_TILE
  const patterns: SpriteData[] = []

  const bases: Array<{ base: string; accent: string }> = [
    { base: '#C8B896', accent: '#B8A886' }, // wood 1
    { base: '#D4C4A0', accent: '#C4B490' }, // wood 2
    { base: '#B0A888', accent: '#A09878' }, // darker wood
    { base: '#A89078', accent: '#988068' }, // carpet
    { base: '#C0B898', accent: '#B0A888' }, // light wood
    { base: '#B8A890', accent: '#A89880' }, // medium wood
    { base: '#D0C0A0', accent: '#C0B090' }, // pale wood
  ]

  for (let p = 0; p < 7; p++) {
    const { base, accent } = bases[p]
    const sprite: SpriteData = []
    for (let y = 0; y < size; y++) {
      const row: string[] = []
      for (let x = 0; x < size; x++) {
        const isAccent = (x + y) % 4 === 0 || (x * 3 + y * 7) % 11 === 0
        row.push(isAccent ? accent : base)
      }
      sprite.push(row)
    }
    patterns.push(sprite)
  }

  return patterns
}

// ── Tileset furniture extraction ───────────────────────────────

export interface TilesetFurnitureEntry {
  id: string
  label: string
  /** Source X in tileset (pixels) */
  srcX: number
  /** Source Y in tileset (pixels) */
  srcY: number
  /** Source width (pixels) */
  srcW: number
  /** Source height (pixels) */
  srcH: number
  /** Walkable footprint width in tiles */
  footprintW: number
  /** Walkable footprint height in tiles */
  footprintH: number
  isDesk: boolean
  category: 'desks' | 'chairs' | 'storage' | 'decor' | 'electronics' | 'wall' | 'misc'
  orientation?: string
  canPlaceOnSurfaces?: boolean
  backgroundTiles?: number
  canPlaceOnWalls?: boolean
  /** Rotation group ID for furniture that has multiple orientations */
  groupId?: string
  /** State: 'on' or 'off' for toggleable furniture */
  state?: string
}

/**
 * Tileset furniture catalog — maps pixel regions in "Office Tileset All 16x16.png" (256×512).
 * Coordinates from the pixel-agents tileset-metadata-final.json import pipeline.
 * Uses ASSET_* IDs matching the Level 4 layout JSON.
 */
export const TILESET_FURNITURE: TilesetFurnitureEntry[] = [
  // ── Desks ──────────────────────
  { id: 'ASSET_4',        label: 'Wooden Counter',     srcX: 128, srcY:   0, srcW: 48, srcH: 32, footprintW: 3, footprintH: 2, isDesk: true,  category: 'desks', backgroundTiles: 1 },
  { id: 'ASSET_7',        label: 'White Counter',      srcX:  80, srcY:  23, srcW: 32, srcH: 32, footprintW: 2, footprintH: 2, isDesk: true,  category: 'desks', backgroundTiles: 1 },
  { id: 'ASSET_15',       label: 'Plastic Counter',    srcX: 128, srcY:  64, srcW: 48, srcH: 32, footprintW: 3, footprintH: 2, isDesk: true,  category: 'desks', backgroundTiles: 1 },
  { id: 'ASSET_NEW_106',  label: 'Wooden Table',       srcX:  16, srcY:  -9, srcW: 48, srcH: 32, footprintW: 3, footprintH: 2, isDesk: true,  category: 'desks', backgroundTiles: 1 },
  { id: 'ASSET_27_A',     label: 'Large Table',        srcX:   0, srcY: 544, srcW: 32, srcH: 64, footprintW: 2, footprintH: 4, isDesk: true,  category: 'desks', backgroundTiles: 1 },
  { id: 'ASSET_46',       label: 'Vertical Table',     srcX:  16, srcY: 288, srcW: 16, srcH: 32, footprintW: 1, footprintH: 2, isDesk: true,  category: 'desks' },
  { id: 'ASSET_NEW_112',  label: 'Coffee Table',       srcX:  96, srcY: 512, srcW: 32, srcH: 32, footprintW: 2, footprintH: 2, isDesk: true,  category: 'desks', backgroundTiles: 1 },
  { id: 'ASSET_50_0_0',   label: 'Wood Coffee Table',  srcX:  64, srcY: 299, srcW: 32, srcH: 16, footprintW: 2, footprintH: 1, isDesk: true,  category: 'desks' },

  // ── Storage ────────────────────
  { id: 'ASSET_17',       label: 'Wooden Bookshelf',   srcX: 128, srcY: 512, srcW: 32, srcH: 32, footprintW: 2, footprintH: 2, isDesk: false, category: 'storage', backgroundTiles: 1 },
  { id: 'ASSET_18',       label: 'Full Bookshelf',     srcX: 160, srcY: 512, srcW: 32, srcH: 32, footprintW: 2, footprintH: 2, isDesk: false, category: 'storage', backgroundTiles: 1 },
  { id: 'ASSET_27_B_A_A', label: 'Bookshelf Tall',     srcX: 128, srcY: 183, srcW: 16, srcH: 32, footprintW: 1, footprintH: 2, isDesk: false, category: 'storage', backgroundTiles: 1 },
  { id: 'ASSET_27_B_A_B_A', label: 'Full Bookshelf Tall', srcX: 144, srcY: 183, srcW: 16, srcH: 32, footprintW: 1, footprintH: 2, isDesk: false, category: 'storage', backgroundTiles: 1 },
  { id: 'ASSET_27_B_A_B_B_A', label: 'Cabinet Tall',   srcX: 160, srcY: 183, srcW: 16, srcH: 32, footprintW: 1, footprintH: 2, isDesk: false, category: 'storage', backgroundTiles: 1 },
  { id: 'ASSET_28',       label: 'White Bookshelf',    srcX: 192, srcY: 184, srcW: 32, srcH: 32, footprintW: 2, footprintH: 2, isDesk: false, category: 'storage', backgroundTiles: 1 },
  { id: 'ASSET_41_0_1',   label: 'Fridge',             srcX: 208, srcY: 264, srcW: 16, srcH: 32, footprintW: 1, footprintH: 2, isDesk: false, category: 'storage', backgroundTiles: 1 },
  { id: 'ASSET_139',      label: 'Crates',             srcX: 224, srcY: 447, srcW: 32, srcH: 32, footprintW: 2, footprintH: 2, isDesk: false, category: 'storage', backgroundTiles: 1 },

  // ── Chairs ─────────────────────
  { id: 'ASSET_32',       label: 'Chair Front',        srcX:   0, srcY: 258, srcW: 16, srcH: 16, footprintW: 1, footprintH: 1, isDesk: false, category: 'chairs' },
  { id: 'ASSET_38',       label: 'Chair Back',         srcX:  16, srcY: 258, srcW: 16, srcH: 16, footprintW: 1, footprintH: 1, isDesk: false, category: 'chairs' },
  { id: 'ASSET_33',       label: 'Chair Right',        srcX:  32, srcY: 258, srcW: 16, srcH: 16, footprintW: 1, footprintH: 1, isDesk: false, category: 'chairs' },
  { id: 'ASSET_34',       label: 'Chair Left',         srcX:  48, srcY: 258, srcW: 16, srcH: 16, footprintW: 1, footprintH: 1, isDesk: false, category: 'chairs' },
  { id: 'ASSET_35',       label: 'Office Chair Front', srcX:  64, srcY: 258, srcW: 16, srcH: 16, footprintW: 1, footprintH: 1, isDesk: false, category: 'chairs' },
  { id: 'ASSET_39',       label: 'Office Chair Back',  srcX:  80, srcY: 258, srcW: 16, srcH: 16, footprintW: 1, footprintH: 1, isDesk: false, category: 'chairs' },
  { id: 'ASSET_36',       label: 'Office Chair Right', srcX:  96, srcY: 258, srcW: 16, srcH: 16, footprintW: 1, footprintH: 1, isDesk: false, category: 'chairs' },
  { id: 'ASSET_37',       label: 'Office Chair Left',  srcX: 112, srcY: 258, srcW: 16, srcH: 16, footprintW: 1, footprintH: 1, isDesk: false, category: 'chairs' },
  { id: 'ASSET_49',       label: 'Stool',              srcX:   0, srcY: 290, srcW: 16, srcH: 16, footprintW: 1, footprintH: 1, isDesk: false, category: 'chairs' },
  { id: 'ASSET_NEW_110',  label: 'Large Chair Right',  srcX: 192, srcY: 512, srcW: 16, srcH: 48, footprintW: 1, footprintH: 3, isDesk: false, category: 'chairs' },
  { id: 'ASSET_NEW_111',  label: 'Large Chair Left',   srcX: 208, srcY: 512, srcW: 16, srcH: 48, footprintW: 1, footprintH: 3, isDesk: false, category: 'chairs' },

  // ── Electronics ────────────────
  { id: 'ASSET_90',       label: 'Computer + Coffee',  srcX: 192, srcY: 358, srcW: 32, srcH: 32, footprintW: 2, footprintH: 2, isDesk: false, category: 'electronics', canPlaceOnSurfaces: true, backgroundTiles: 1 },
  { id: 'ASSET_74',       label: 'CRT Monitor Off',    srcX: 128, srcY: 360, srcW: 16, srcH: 16, footprintW: 1, footprintH: 1, isDesk: false, category: 'electronics', canPlaceOnSurfaces: true },
  { id: 'ASSET_76',       label: 'CRT Monitor On',     srcX: 160, srcY: 360, srcW: 16, srcH: 16, footprintW: 1, footprintH: 1, isDesk: false, category: 'electronics', canPlaceOnSurfaces: true },
  { id: 'ASSET_78',       label: 'Monitor Off',        srcX: 192, srcY: 359, srcW: 16, srcH: 16, footprintW: 1, footprintH: 1, isDesk: false, category: 'electronics', canPlaceOnSurfaces: true },
  { id: 'ASSET_79',       label: 'Monitor On',         srcX: 224, srcY: 359, srcW: 16, srcH: 16, footprintW: 1, footprintH: 1, isDesk: false, category: 'electronics', canPlaceOnSurfaces: true },
  { id: 'ASSET_107',      label: 'Laptop Off',         srcX: 128, srcY: 384, srcW: 16, srcH: 32, footprintW: 1, footprintH: 2, isDesk: false, category: 'electronics', canPlaceOnSurfaces: true, backgroundTiles: 1 },
  { id: 'ASSET_108',      label: 'Laptop On',          srcX: 144, srcY: 384, srcW: 16, srcH: 32, footprintW: 1, footprintH: 2, isDesk: false, category: 'electronics', canPlaceOnSurfaces: true, backgroundTiles: 1 },
  { id: 'ASSET_99',       label: 'Laptop Left',        srcX: 177, srcY: 386, srcW: 16, srcH: 32, footprintW: 1, footprintH: 2, isDesk: false, category: 'electronics', canPlaceOnSurfaces: true, backgroundTiles: 1 },
  { id: 'ASSET_109',      label: 'Laptop Back',        srcX: 192, srcY: 386, srcW: 16, srcH: 32, footprintW: 1, footprintH: 2, isDesk: false, category: 'electronics', canPlaceOnSurfaces: true, backgroundTiles: 1 },
  { id: 'ASSET_61',       label: 'Telephone',          srcX: 192, srcY: 304, srcW: 16, srcH: 32, footprintW: 1, footprintH: 2, isDesk: false, category: 'electronics', canPlaceOnSurfaces: true, backgroundTiles: 1 },
  { id: 'ASSET_123',      label: 'Server',             srcX: 131, srcY: 417, srcW: 16, srcH: 32, footprintW: 1, footprintH: 2, isDesk: false, category: 'electronics', canPlaceOnSurfaces: true, backgroundTiles: 1 },
  { id: 'ASSET_126',      label: 'Printer',            srcX: 216, srcY: 423, srcW: 16, srcH: 32, footprintW: 1, footprintH: 2, isDesk: false, category: 'electronics', canPlaceOnSurfaces: true, backgroundTiles: 1 },

  // ── Wall ────────────────────────
  { id: 'ASSET_63',       label: 'Wood Window',        srcX:  32, srcY: 319, srcW: 32, srcH: 32, footprintW: 2, footprintH: 2, isDesk: false, category: 'wall', canPlaceOnWalls: true },
  { id: 'ASSET_64',       label: 'White Window',       srcX:  64, srcY: 319, srcW: 32, srcH: 32, footprintW: 2, footprintH: 2, isDesk: false, category: 'wall', canPlaceOnWalls: true },
  { id: 'ASSET_80',       label: 'Small Window Wood',  srcX:  80, srcY: 351, srcW: 16, srcH: 32, footprintW: 1, footprintH: 2, isDesk: false, category: 'wall', canPlaceOnWalls: true },
  { id: 'ASSET_81',       label: 'Small Window White', srcX:  96, srcY: 351, srcW: 16, srcH: 32, footprintW: 1, footprintH: 2, isDesk: false, category: 'wall', canPlaceOnWalls: true },
  { id: 'ASSET_83',       label: 'Clock White',        srcX:   0, srcY: 360, srcW: 16, srcH: 16, footprintW: 1, footprintH: 1, isDesk: false, category: 'wall', canPlaceOnWalls: true },
  { id: 'ASSET_84',       label: 'Clock Color',        srcX:  15, srcY: 352, srcW: 16, srcH: 32, footprintW: 1, footprintH: 2, isDesk: false, category: 'wall', canPlaceOnWalls: true },
  { id: 'ASSET_101',      label: 'Painting',           srcX:   0, srcY: 384, srcW: 32, srcH: 32, footprintW: 2, footprintH: 2, isDesk: false, category: 'wall', canPlaceOnWalls: true },
  { id: 'ASSET_102',      label: 'Painting 2',         srcX:  32, srcY: 384, srcW: 32, srcH: 32, footprintW: 2, footprintH: 2, isDesk: false, category: 'wall', canPlaceOnWalls: true },
  { id: 'ASSET_103',      label: 'Small Painting',     srcX:  64, srcY: 384, srcW: 16, srcH: 32, footprintW: 1, footprintH: 2, isDesk: false, category: 'wall', canPlaceOnWalls: true },
  { id: 'ASSET_118',      label: 'Chart 1',            srcX:  32, srcY: 415, srcW: 32, srcH: 32, footprintW: 2, footprintH: 2, isDesk: false, category: 'wall', canPlaceOnWalls: true },
  { id: 'ASSET_122',      label: 'Chalkboard',         srcX:   0, srcY: 415, srcW: 32, srcH: 32, footprintW: 2, footprintH: 2, isDesk: false, category: 'wall', canPlaceOnWalls: true },
  { id: 'ASSET_134',      label: 'Chart 2',            srcX:   0, srcY: 448, srcW: 32, srcH: 32, footprintW: 2, footprintH: 2, isDesk: false, category: 'wall', canPlaceOnWalls: true },

  // ── Decor ──────────────────────
  { id: 'ASSET_140',      label: 'White Plant',        srcX:  32, srcY: 448, srcW: 16, srcH: 32, footprintW: 1, footprintH: 2, isDesk: false, category: 'decor', backgroundTiles: 1 },
  { id: 'ASSET_141',      label: 'White Plant 2',      srcX:  32, srcY: 448, srcW: 16, srcH: 32, footprintW: 1, footprintH: 2, isDesk: false, category: 'decor', backgroundTiles: 1 },
  { id: 'ASSET_142',      label: 'Plant',              srcX:  32, srcY: 448, srcW: 16, srcH: 32, footprintW: 1, footprintH: 2, isDesk: false, category: 'decor', backgroundTiles: 1 },
  { id: 'ASSET_143',      label: 'Plant 2',            srcX:  32, srcY: 448, srcW: 16, srcH: 32, footprintW: 1, footprintH: 2, isDesk: false, category: 'decor', backgroundTiles: 1 },
  { id: 'ASSET_72',       label: 'Red Book',           srcX: 163, srcY: 336, srcW: 16, srcH: 16, footprintW: 1, footprintH: 1, isDesk: false, category: 'decor', canPlaceOnSurfaces: true },
  { id: 'ASSET_100',      label: 'Paper',              srcX: 240, srcY: 384, srcW: 16, srcH: 32, footprintW: 1, footprintH: 2, isDesk: false, category: 'decor', canPlaceOnSurfaces: true, backgroundTiles: 1 },

  // ── Misc ───────────────────────
  { id: 'ASSET_40',       label: 'Vending Machine',    srcX: 224, srcY: 264, srcW: 32, srcH: 32, footprintW: 2, footprintH: 2, isDesk: false, category: 'misc', backgroundTiles: 1 },
  { id: 'ASSET_42',       label: 'Water Cooler',       srcX: 142, srcY: 264, srcW: 16, srcH: 32, footprintW: 1, footprintH: 2, isDesk: false, category: 'misc', backgroundTiles: 1 },
  { id: 'ASSET_44',       label: 'Bin',                srcX: 128, srcY: 278, srcW: 16, srcH: 16, footprintW: 1, footprintH: 1, isDesk: false, category: 'misc' },
  { id: 'ASSET_51',       label: 'Coffee Mug',         srcX: 225, srcY: 299, srcW: 16, srcH: 16, footprintW: 1, footprintH: 1, isDesk: false, category: 'misc', canPlaceOnSurfaces: true },
  { id: 'ASSET_55',       label: 'Coffee Machine',     srcX: 161, srcY: 309, srcW: 16, srcH: 32, footprintW: 1, footprintH: 2, isDesk: false, category: 'misc', canPlaceOnSurfaces: true, backgroundTiles: 1 },
]

// Fallback colors for out-of-bounds sprites
const FALLBACKS: Record<string, { fill: string; edge: string }> = {
  'ASSET_17':      { fill: '#8B6914', edge: '#5B4910' }, // bookshelf
  'ASSET_18':      { fill: '#7B5910', edge: '#4B3908' }, // full bookshelf
  'ASSET_27_A':    { fill: '#D4C090', edge: '#B8A070' }, // large table
  'ASSET_NEW_106': { fill: '#C8B480', edge: '#A89460' }, // wooden table
  'ASSET_NEW_110': { fill: '#9B5050', edge: '#6B3030' }, // large chair right
  'ASSET_NEW_111': { fill: '#9B5050', edge: '#6B3030' }, // large chair left
  'ASSET_NEW_112': { fill: '#D4C090', edge: '#B8A070' }, // coffee table
}

export interface LoadedTilesetSprites {
  sprites: Map<string, SpriteData>
}

async function loadTilesetFurniture(): Promise<LoadedTilesetSprites> {
  const sprites = new Map<string, SpriteData>()

  // The upstream repository does not ship the optional Office Tileset image.
  // Avoid a guaranteed 404 and use the existing generated fallback sprites.
  const img: HTMLImageElement | null = null

  for (const entry of TILESET_FURNITURE) {
    if (img) {
      const sprite = imageRegionToSprite(img, entry.srcX, entry.srcY, entry.srcW, entry.srcH)
      if (!isSpriteEmpty(sprite)) {
        sprites.set(entry.id, sprite)
        continue
      }
      console.warn(`[tileset] empty sprite: ${entry.id} at (${entry.srcX},${entry.srcY}) ${entry.srcW}×${entry.srcH}`)
    }
    // Use colored fallback if available
    const fb = FALLBACKS[entry.id]
    if (fb) {
      sprites.set(entry.id, generateFallbackSprite(entry.srcW, entry.srcH, fb.fill, fb.edge))
    }
  }

  return { sprites }
}

// ── Layout loading ─────────────────────────────────────────────

async function loadLayoutJson(): Promise<OfficeLayout | null> {
  try {
    const resp = await fetch('/pixel-agents-layout.json')
    if (!resp.ok) return null
    const data = await resp.json()
    if (data && data.version === 1 && Array.isArray(data.tiles)) {
      return data as OfficeLayout
    }
    return null
  } catch {
    return null
  }
}

// ── Main loader ────────────────────────────────────────────────

export interface LoadedAssets {
  characters: CharacterDirectionSprites[]
  walls: SpriteData[]
  floors: SpriteData[]
  tilesetSprites: Map<string, SpriteData>
  layout: OfficeLayout | null
}

/**
 * Load all PNG assets and inject them into the engine's sprite systems.
 * Call this once before starting the game loop.
 */
export async function loadAllAssets(): Promise<LoadedAssets> {
  // Load all asset types in parallel
  const [characters, walls, tilesetData, layout] = await Promise.all([
    loadCharacterSprites(),
    loadWallTileSprites(),
    loadTilesetFurniture(),
    loadLayoutJson(),
  ])

  // Generate floor patterns (procedural for now)
  const floors = generateFloorPatterns()

  // Inject into the engine's sprite systems
  setCharacterTemplates(characters)
  setWallSprites(walls)
  setFloorSprites(floors)

  return {
    characters,
    walls,
    floors,
    tilesetSprites: tilesetData.sprites,
    layout,
  }
}
