import { openDB } from 'idb'
import type { DBSchema, IDBPDatabase } from 'idb'
import type {
  LoadedProject,
  ProjectAsset,
  ProjectRepository,
  ProjectSnapshot,
} from '../domain/project'
import { normalizeProjectSnapshot } from '../domain/project'

const DATABASE_NAME = 'freecut-projects'
const DATABASE_VERSION = 2
const LEGACY_PROJECT_ID = 'default'
const LEGACY_OWNER_KEY = 'legacy-project-owner'

interface FreeCutDatabase extends DBSchema {
  projects: {
    key: string
    value: ProjectSnapshot
  }
  assets: {
    key: string
    value: ProjectAsset
  }
  ownership: {
    key: string
    value: string | boolean
  }
}

let databasePromise: Promise<IDBPDatabase<FreeCutDatabase>> | undefined

function openDatabase() {
  let connection: IDBPDatabase<FreeCutDatabase> | undefined
  let settled = false

  return new Promise<IDBPDatabase<FreeCutDatabase>>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error('La base local tardó demasiado en abrirse. Cierra las demás pestañas o ventanas de FreeCut e inténtalo otra vez. Tus proyectos no se han borrado.'))
    }, 15000)

    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      window.clearTimeout(timeout)
      reject(error)
    }

    openDB<FreeCutDatabase>(DATABASE_NAME, DATABASE_VERSION, {
      upgrade(database) {
        if (!database.objectStoreNames.contains('projects')) {
          database.createObjectStore('projects')
        }
        if (!database.objectStoreNames.contains('assets')) {
          database.createObjectStore('assets', { keyPath: 'id' })
        }
        if (!database.objectStoreNames.contains('ownership')) {
          database.createObjectStore('ownership')
        }
      },
      blocked() {
        fail(new Error('Otra pestaña o ventana de FreeCut está bloqueando la actualización de la base local. Ciérrala e inténtalo otra vez. Tus proyectos no se han borrado.'))
      },
      blocking() {
        databasePromise = undefined
        connection?.close()
      },
    }).then((database) => {
      connection = database
      if (settled) {
        database.close()
        return
      }
      settled = true
      window.clearTimeout(timeout)
      resolve(database)
    }).catch(fail)
  })
}

const getDatabase = () => {
  if (!('indexedDB' in window)) {
    return Promise.reject(new Error('Este navegador no permite guardar proyectos localmente.'))
  }
  databasePromise ??= openDatabase().catch((error: unknown) => {
    databasePromise = undefined
    throw error
  })
  return databasePromise
}

const projectKey = (ownerId: string) => `user:${ownerId}`
const assetKey = (ownerId: string, assetId: string) => `${projectKey(ownerId)}:${assetId}`
const legacyDismissedKey = (ownerId: string) => `legacy-dismissed:${ownerId}`

async function loadProject(database: IDBPDatabase<FreeCutDatabase>, key: string, assetIdFor: (id: string) => string) {
  const transaction = database.transaction(['projects', 'assets'], 'readonly')
  const snapshot = await transaction.objectStore('projects').get(key)
  if (!snapshot) {
    await transaction.done
    return null
  }
  const normalizedSnapshot = normalizeProjectSnapshot(snapshot)
  const assets = await Promise.all(normalizedSnapshot.media.map(async (media) => {
    const stored = await transaction.objectStore('assets').get(assetIdFor(media.id))
    if (!stored) throw new Error(`No se encontró el archivo guardado "${media.name}".`)
    return { id: media.id, blob: stored.blob }
  }))
  await transaction.done
  return { snapshot: normalizedSnapshot, assets }
}

export const indexedDbProjectRepository: ProjectRepository = {
  async load(ownerId: string): Promise<LoadedProject | null> {
    const database = await getDatabase()
    return loadProject(database, projectKey(ownerId), (id) => assetKey(ownerId, id))
  },

  async save(
    ownerId: string,
    snapshot: ProjectSnapshot,
    assets: ProjectAsset[],
    replaceAssets = false,
  ): Promise<void> {
    const database = await getDatabase()
    const transaction = database.transaction(['projects', 'assets'], 'readwrite')
    const assetStore = transaction.objectStore('assets')
    const key = projectKey(ownerId)
    const storedAssets = assets.map((asset) => ({
      id: assetKey(ownerId, asset.id),
      blob: asset.blob,
    }))
    if (replaceAssets) {
      const existingKeys = await assetStore.getAllKeys()
      await Promise.all(existingKeys
        .filter((assetId): assetId is string => typeof assetId === 'string' && assetId.startsWith(`${key}:`))
        .map((assetId) => assetStore.delete(assetId)))
      await Promise.all([
        transaction.objectStore('projects').put(snapshot, key),
        ...storedAssets.map((asset) => assetStore.put(asset)),
      ])
    } else {
      const nextIds = new Set(storedAssets.map((asset) => asset.id))
      const existingKeys = (await assetStore.getAllKeys())
        .filter((assetId): assetId is string => typeof assetId === 'string' && assetId.startsWith(`${key}:`))
      const existingIds = new Set(existingKeys)
      await Promise.all([
        transaction.objectStore('projects').put(snapshot, key),
        ...storedAssets
          .filter((asset) => !existingIds.has(asset.id))
          .map((asset) => assetStore.put(asset)),
        ...existingKeys
          .filter((assetId) => !nextIds.has(assetId))
          .map((assetId) => assetStore.delete(assetId)),
      ])
    }
    await transaction.done
  },

  async getLegacyProjectState(ownerId: string) {
    const database = await getDatabase()
    const transaction = database.transaction(['projects', 'ownership'], 'readonly')
    const [snapshot, owner, dismissed] = await Promise.all([
      transaction.objectStore('projects').get(LEGACY_PROJECT_ID),
      transaction.objectStore('ownership').get(LEGACY_OWNER_KEY),
      transaction.objectStore('ownership').get(legacyDismissedKey(ownerId)),
      transaction.done,
    ]).then(([project, legacyOwner, wasDismissed]) => [project, legacyOwner, wasDismissed] as const)
    if (!snapshot) return 'none'
    if (owner === ownerId) return 'owned'
    if (owner) return 'claimed'
    return dismissed ? 'dismissed' : 'available'
  },

  async claimLegacyProject(ownerId: string) {
    const database = await getDatabase()
    const transaction = database.transaction(['projects', 'assets', 'ownership'], 'readwrite')
    const projects = transaction.objectStore('projects')
    const ownership = transaction.objectStore('ownership')
    const [legacySnapshot, owner, existingProject] = await Promise.all([
      projects.get(LEGACY_PROJECT_ID),
      ownership.get(LEGACY_OWNER_KEY),
      projects.get(projectKey(ownerId)),
    ])
    if (!legacySnapshot) {
      throw new Error('No hay un proyecto local anterior para importar.')
    }
    if (owner && owner !== ownerId) {
      throw new Error('El proyecto local anterior ya fue asignado a otra cuenta.')
    }
    if (existingProject && owner !== ownerId) {
      throw new Error('Esta cuenta ya tiene un proyecto y no puede reemplazarse con la importación.')
    }

    const snapshot = normalizeProjectSnapshot(legacySnapshot)
    const sourceAssets = await Promise.all(snapshot.media.map(async (media) => {
      const stored = await transaction.objectStore('assets').get(media.id)
      if (!stored) throw new Error(`No se encontró el archivo guardado "${media.name}".`)
      return { id: assetKey(ownerId, media.id), blob: stored.blob }
    }))
    await Promise.all([
      projects.put(snapshot, projectKey(ownerId)),
      ownership.put(ownerId, LEGACY_OWNER_KEY),
      ownership.delete(legacyDismissedKey(ownerId)),
      ...sourceAssets.map((asset) => transaction.objectStore('assets').put(asset)),
    ])
    await transaction.done
    return { snapshot, assets: sourceAssets.map((asset, index) => ({ id: snapshot.media[index].id, blob: asset.blob })) }
  },

  async dismissLegacyProject(ownerId: string) {
    const database = await getDatabase()
    await database.put('ownership', true, legacyDismissedKey(ownerId))
  },
}
