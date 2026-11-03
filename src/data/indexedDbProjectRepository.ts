import { openDB } from 'idb'
import type { DBSchema, IDBPDatabase } from 'idb'
import type {
  LoadedProject,
  ProjectAsset,
  ProjectRepository,
  ProjectSnapshot,
} from '../domain/project'
import { validateProjectSnapshot } from '../domain/project'

const DATABASE_NAME = 'freecut-projects'
const DATABASE_VERSION = 1
const CURRENT_PROJECT_ID = 'default'

interface FreeCutDatabase extends DBSchema {
  projects: {
    key: string
    value: ProjectSnapshot
  }
  assets: {
    key: string
    value: ProjectAsset
  }
}

let databasePromise: Promise<IDBPDatabase<FreeCutDatabase>> | undefined

const getDatabase = () => {
  if (!('indexedDB' in window)) {
    return Promise.reject(new Error('Este navegador no permite guardar proyectos localmente.'))
  }
  databasePromise ??= openDB<FreeCutDatabase>(DATABASE_NAME, DATABASE_VERSION, {
    upgrade(database) {
      if (!database.objectStoreNames.contains('projects')) {
        database.createObjectStore('projects')
      }
      if (!database.objectStoreNames.contains('assets')) {
        database.createObjectStore('assets', { keyPath: 'id' })
      }
    },
    blocked() {
      databasePromise = undefined
    },
    blocking() {
      databasePromise = undefined
    },
  }).catch((error: unknown) => {
    databasePromise = undefined
    throw error
  })
  return databasePromise
}

export const indexedDbProjectRepository: ProjectRepository = {
  async load(): Promise<LoadedProject | null> {
    const database = await getDatabase()
    const transaction = database.transaction(['projects', 'assets'], 'readonly')
    const [snapshot, allAssets] = await Promise.all([
      transaction.objectStore('projects').get(CURRENT_PROJECT_ID),
      transaction.objectStore('assets').getAll(),
      transaction.done,
    ]).then(([project, assets]) => [project, assets] as const)

    if (snapshot === undefined) return null
    if (!validateProjectSnapshot(snapshot)) {
      throw new Error('El proyecto guardado tiene un formato no compatible.')
    }

    const assetsById = new Map(allAssets.map((asset) => [asset.id, asset]))
    const assets = snapshot.media.map((media) => {
      const asset = assetsById.get(media.id)
      if (!asset) {
        throw new Error(`No se encontró el archivo guardado "${media.name}".`)
      }
      return asset
    })
    return { snapshot, assets }
  },

  async save(
    snapshot: ProjectSnapshot,
    assets: ProjectAsset[],
    replaceAssets = false,
  ): Promise<void> {
    const database = await getDatabase()
    const transaction = database.transaction(['projects', 'assets'], 'readwrite')
    const assetStore = transaction.objectStore('assets')
    if (replaceAssets) {
      await assetStore.clear()
      await Promise.all([
        transaction.objectStore('projects').put(snapshot, CURRENT_PROJECT_ID),
        ...assets.map((asset) => assetStore.put(asset)),
      ])
    } else {
      const nextIds = new Set(assets.map((asset) => asset.id))
      const existingKeys = await assetStore.getAllKeys()
      const existingIds = new Set(existingKeys.filter((key): key is string => typeof key === 'string'))
      await Promise.all([
        transaction.objectStore('projects').put(snapshot, CURRENT_PROJECT_ID),
        ...assets
          .filter((asset) => !existingIds.has(asset.id))
          .map((asset) => assetStore.put(asset)),
        ...existingKeys
          .filter((key) => typeof key === 'string' && !nextIds.has(key))
          .map((key) => assetStore.delete(key)),
      ])
    }
    await transaction.done
  },
}
