import { FurnitureType } from '../types'
import type { FurnitureCatalogEntry, SpriteData } from '../types'
import {
  DESK_SQUARE_SPRITE,
  BOOKSHELF_SPRITE,
  PLANT_SPRITE,
  COOLER_SPRITE,
  WHITEBOARD_SPRITE,
  CHAIR_SPRITE,
  PC_SPRITE,
  LAMP_SPRITE,
} from '../sprites/spriteData'
import { TILESET_FURNITURE, type TilesetFurnitureEntry } from '../sprites/assetLoader'

export type FurnitureCategory = 'desks' | 'chairs' | 'storage' | 'decor' | 'electronics' | 'wall' | 'misc'

export interface CatalogEntryWithCategory extends FurnitureCatalogEntry {
  category: FurnitureCategory
}

/** Hardcoded fallback entries (used when tileset isn't loaded yet) */
const FALLBACK_CATALOG: CatalogEntryWithCategory[] = [
  { type: FurnitureType.DESK,       label: 'Desk',       footprintW: 2, footprintH: 2, sprite: DESK_SQUARE_SPRITE,  isDesk: true,  category: 'desks' },
  { type: FurnitureType.BOOKSHELF,  label: 'Bookshelf',  footprintW: 1, footprintH: 2, sprite: BOOKSHELF_SPRITE,    isDesk: false, category: 'storage' },
  { type: FurnitureType.PLANT,      label: 'Plant',      footprintW: 1, footprintH: 1, sprite: PLANT_SPRITE,        isDesk: false, category: 'decor' },
  { type: FurnitureType.COOLER,     label: 'Cooler',     footprintW: 1, footprintH: 1, sprite: COOLER_SPRITE,       isDesk: false, category: 'misc' },
  { type: FurnitureType.WHITEBOARD, label: 'Whiteboard', footprintW: 2, footprintH: 1, sprite: WHITEBOARD_SPRITE,   isDesk: false, category: 'decor' },
  { type: FurnitureType.CHAIR,      label: 'Chair',      footprintW: 1, footprintH: 1, sprite: CHAIR_SPRITE,        isDesk: false, category: 'chairs' },
  { type: FurnitureType.PC,         label: 'PC',         footprintW: 1, footprintH: 1, sprite: PC_SPRITE,           isDesk: false, category: 'electronics' },
  { type: FurnitureType.LAMP,       label: 'Lamp',       footprintW: 1, footprintH: 1, sprite: LAMP_SPRITE,         isDesk: false, category: 'decor' },
]

/** Full catalog: fallback entries + any tileset entries registered at runtime */
export const FURNITURE_CATALOG: CatalogEntryWithCategory[] = [...FALLBACK_CATALOG]

export const FURNITURE_CATEGORIES: Array<{ id: FurnitureCategory; label: string }> = [
  { id: 'desks', label: 'Desks' },
  { id: 'chairs', label: 'Chairs' },
  { id: 'storage', label: 'Storage' },
  { id: 'electronics', label: 'Tech' },
  { id: 'decor', label: 'Decor' },
  { id: 'wall', label: 'Wall' },
  { id: 'misc', label: 'Misc' },
]

// ── Rotation groups ──────────────────────────────────────────────
interface RotationGroup {
  orientations: string[]
  members: Record<string, string>
}
const rotationGroups = new Map<string, RotationGroup>()

// ── State groups ────────────────────────────────────────────────
const stateGroups = new Map<string, string>()
const offToOn = new Map<string, string>()
const onToOff = new Map<string, string>()

/**
 * Register tileset-loaded sprites into the catalog.
 * Also builds rotation and state groups from TILESET_FURNITURE metadata.
 */
export function registerTilesetSprites(sprites: Map<string, SpriteData>): void {
  // Phase 1: Register all entries into FURNITURE_CATALOG
  for (const tsEntry of TILESET_FURNITURE) {
    const sprite = sprites.get(tsEntry.id)
    if (!sprite) continue

    const existing = FURNITURE_CATALOG.findIndex((e) => e.type === tsEntry.id)
    const entry = tilesetEntryToCatalog(tsEntry, sprite)
    if (existing >= 0) {
      FURNITURE_CATALOG[existing] = entry
    } else {
      FURNITURE_CATALOG.push(entry)
    }
  }

  // Phase 2: Build rotation groups from groupId + orientation
  const groupMap = new Map<string, Map<string, string>>()
  for (const tsEntry of TILESET_FURNITURE) {
    if (tsEntry.groupId && tsEntry.orientation) {
      if (tsEntry.state && tsEntry.state !== 'off') continue
      let orientMap = groupMap.get(tsEntry.groupId)
      if (!orientMap) {
        orientMap = new Map()
        groupMap.set(tsEntry.groupId, orientMap)
      }
      orientMap.set(tsEntry.orientation, tsEntry.id)
    }
  }

  const orientationOrder = ['front', 'right', 'back', 'left']
  for (const orientMap of groupMap.values()) {
    if (orientMap.size < 2) continue
    const orderedOrients = orientationOrder.filter((o) => orientMap.has(o))
    if (orderedOrients.length < 2) continue
    const members: Record<string, string> = {}
    for (const o of orderedOrients) {
      members[o] = orientMap.get(o)!
    }
    const rg: RotationGroup = { orientations: orderedOrients, members }
    for (const id of Object.values(members)) {
      rotationGroups.set(id, rg)
    }
  }

  // Phase 3: Build state groups (on ↔ off pairs)
  const stateMap = new Map<string, Map<string, string>>()
  for (const tsEntry of TILESET_FURNITURE) {
    if (tsEntry.groupId && tsEntry.state) {
      const key = `${tsEntry.groupId}|${tsEntry.orientation || ''}`
      let sm = stateMap.get(key)
      if (!sm) {
        sm = new Map()
        stateMap.set(key, sm)
      }
      sm.set(tsEntry.state, tsEntry.id)
    }
  }
  for (const sm of stateMap.values()) {
    const onId = sm.get('on')
    const offId = sm.get('off')
    if (onId && offId) {
      stateGroups.set(onId, offId)
      stateGroups.set(offId, onId)
      offToOn.set(offId, onId)
      onToOff.set(onId, offId)
    }
  }

  // Phase 4: Register rotation groups for "on" state variants
  for (const tsEntry of TILESET_FURNITURE) {
    if (tsEntry.groupId && tsEntry.orientation && tsEntry.state === 'on') {
      const offCounterpart = stateGroups.get(tsEntry.id)
      if (offCounterpart) {
        const offGroup = rotationGroups.get(offCounterpart)
        if (offGroup) {
          const onMembers: Record<string, string> = {}
          for (const orient of offGroup.orientations) {
            const offId = offGroup.members[orient]
            const onId = stateGroups.get(offId)
            onMembers[orient] = onId ?? offId
          }
          const onGroup: RotationGroup = { orientations: offGroup.orientations, members: onMembers }
          for (const id of Object.values(onMembers)) {
            if (!rotationGroups.has(id)) {
              rotationGroups.set(id, onGroup)
            }
          }
        }
      }
    }
  }
}

function tilesetEntryToCatalog(ts: TilesetFurnitureEntry, sprite: SpriteData): CatalogEntryWithCategory {
  return {
    type: ts.id,
    label: ts.label,
    footprintW: ts.footprintW,
    footprintH: ts.footprintH,
    sprite,
    isDesk: ts.isDesk,
    category: ts.category,
    canPlaceOnSurfaces: ts.canPlaceOnSurfaces,
    backgroundTiles: ts.backgroundTiles,
    canPlaceOnWalls: ts.canPlaceOnWalls,
    ...(ts.orientation ? { orientation: ts.orientation } : {}),
  }
}

export function getCatalogEntry(type: string): CatalogEntryWithCategory | undefined {
  return FURNITURE_CATALOG.find((e) => e.type === type)
}

/** Returns the "on" variant if this type has one, otherwise returns the type unchanged. */
export function getOnStateType(currentType: string): string {
  return offToOn.get(currentType) ?? currentType
}

/** Returns the "off" variant if this type has one, otherwise returns the type unchanged. */
export function getOffStateType(currentType: string): string {
  return onToOff.get(currentType) ?? currentType
}

/** Returns the next asset ID in the rotation group (cw or ccw), or null if not rotatable. */
export function getRotatedType(currentType: string, direction: 'cw' | 'ccw' = 'cw'): string | null {
  const group = rotationGroups.get(currentType)
  if (!group) return null
  const order = group.orientations.map((o) => group.members[o])
  const idx = order.indexOf(currentType)
  if (idx === -1) return null
  const step = direction === 'cw' ? 1 : -1
  const nextIdx = (idx + step + order.length) % order.length
  return order[nextIdx]
}

/** Returns the toggled state variant (on↔off), or null if no state variant exists. */
export function getToggledType(currentType: string): string | null {
  return stateGroups.get(currentType) ?? null
}

/** Returns true if the given furniture type is part of a rotation group. */
export function isRotatable(type: string): boolean {
  return rotationGroups.has(type)
}

/** Get catalog entries filtered by category */
export function getCatalogByCategory(category: FurnitureCategory): CatalogEntryWithCategory[] {
  return FURNITURE_CATALOG.filter((e) => e.category === category)
}

/**
 * Register custom sprites (from room ZIP imports) into the catalog.
 * These use the 'misc' category and are not part of the built-in tileset.
 */
/** Map a tile tag to catalog properties */
function tagToCatalogProps(tag?: string): { isDesk: boolean; category: FurnitureCategory } {
  const t = (tag ?? '').toLowerCase().trim()
  if (t === 'desk' || t === 'table') return { isDesk: true, category: 'desks' }
  if (t === 'chair' || t === 'seat' || t.includes('sofa') || t.includes('couch')) return { isDesk: false, category: 'chairs' }
  if (t === 'storage' || t === 'shelf' || t === 'bookshelf') return { isDesk: false, category: 'storage' }
  if (t === 'plant' || t === 'decor' || t === 'lamp') return { isDesk: false, category: 'decor' }
  if (t === 'pc' || t === 'monitor' || t === 'computer') return { isDesk: false, category: 'electronics' }
  return { isDesk: false, category: 'misc' }
}

export function registerCustomSprites(
  sprites: Map<string, { sprite: SpriteData; footprintW: number; footprintH: number; label: string; tag?: string }>,
): void {
  for (const [type, data] of sprites) {
    const existing = FURNITURE_CATALOG.findIndex((e) => e.type === type)
    const props = tagToCatalogProps(data.tag)
    const entry: CatalogEntryWithCategory = {
      type,
      label: data.label,
      footprintW: data.footprintW,
      footprintH: data.footprintH,
      sprite: data.sprite,
      isDesk: false,
      category: 'decor',
      // Furniture sprites block their full footprint area.
      // Users should arrange layout to avoid blocking paths.
    }
    if (existing >= 0) {
      FURNITURE_CATALOG[existing] = entry
    } else {
      FURNITURE_CATALOG.push(entry)
    }
  }
}

/** Get list of active (non-empty) furniture categories in the catalog */
export function getActiveCategories(): Array<{ id: FurnitureCategory; label: string }> {
  const activeCats = new Set<FurnitureCategory>()
  for (const e of FURNITURE_CATALOG) {
    if (e.category) activeCats.add(e.category)
  }
  return FURNITURE_CATEGORIES.filter((c) => activeCats.has(c.id))
}
