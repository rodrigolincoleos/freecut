import { validateProjectSnapshot } from './project'
import type { LoadedProject, ProjectAsset, ProjectSnapshot } from './project'

const MAGIC = 'FCUTBK01'
const HEADER_SIZE = 12
const MAX_MANIFEST_SIZE = 10 * 1024 * 1024

type BackupManifest = {
  format: 'freecut-project-backup'
  version: 1
  snapshot: ProjectSnapshot
  assets: Array<{ id: string; size: number; offset: number }>
}

export function createProjectBackup(
  snapshot: ProjectSnapshot,
  assets: ProjectAsset[],
): Blob {
  if (!validateProjectSnapshot(snapshot)) {
    throw new Error('El proyecto no tiene un formato válido para crear una copia.')
  }
  if (assets.length !== snapshot.media.length || new Set(assets.map((asset) => asset.id)).size !== assets.length) {
    throw new Error('La lista de medios no coincide con los datos del proyecto.')
  }
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]))
  let offset = 0
  const entries = snapshot.media.map((media) => {
    const asset = assetsById.get(media.id)
    if (!asset) throw new Error(`Falta el archivo "${media.name}" al crear la copia.`)
    const entry = { id: media.id, size: asset.blob.size, offset }
    offset += asset.blob.size
    return entry
  })

  const manifest: BackupManifest = {
    format: 'freecut-project-backup',
    version: 1,
    snapshot,
    assets: entries,
  }
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest))
  if (manifestBytes.byteLength > MAX_MANIFEST_SIZE) {
    throw new Error('Los metadatos del proyecto superan el límite de tamaño de la copia.')
  }

  const header = new ArrayBuffer(HEADER_SIZE)
  new Uint8Array(header).set(new TextEncoder().encode(MAGIC))
  new DataView(header).setUint32(8, manifestBytes.byteLength, true)
  const orderedAssets = snapshot.media.map((media) => assetsById.get(media.id)!.blob)
  return new Blob([header, manifestBytes, ...orderedAssets], {
    type: 'application/vnd.freecut.project',
  })
}

export async function readProjectBackup(file: File): Promise<LoadedProject> {
  if (file.size < HEADER_SIZE) throw new Error('El archivo no es una copia válida de FreeCut.')
  const header = new Uint8Array(await file.slice(0, HEADER_SIZE).arrayBuffer())
  if (new TextDecoder().decode(header.subarray(0, 8)) !== MAGIC) {
    throw new Error('El archivo no tiene el formato de copia de FreeCut.')
  }
  const manifestSize = new DataView(header.buffer).getUint32(8, true)
  if (manifestSize <= 0 || manifestSize > MAX_MANIFEST_SIZE || HEADER_SIZE + manifestSize > file.size) {
    throw new Error('La copia de FreeCut está incompleta o dañada.')
  }

  let manifest: BackupManifest
  try {
    const text = await file.slice(HEADER_SIZE, HEADER_SIZE + manifestSize).text()
    manifest = JSON.parse(text) as BackupManifest
  } catch {
    throw new Error('No se pudieron leer los datos del proyecto en la copia.')
  }
  if (
    !manifest ||
    manifest.format !== 'freecut-project-backup' ||
    manifest.version !== 1 ||
    !validateProjectSnapshot(manifest.snapshot) ||
    !Array.isArray(manifest.assets) ||
    manifest.assets.length !== manifest.snapshot.media.length
  ) {
    throw new Error('La copia de FreeCut tiene una estructura no compatible.')
  }

  let expectedOffset = 0
  const assets = manifest.assets.map((entry, index) => {
    const media = manifest.snapshot.media[index]
    if (
      !entry ||
      entry.id !== media.id ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      !Number.isSafeInteger(entry.offset) ||
      entry.offset !== expectedOffset
    ) {
      throw new Error('La copia de FreeCut contiene archivos con índices inválidos.')
    }
    expectedOffset += entry.size
    if (!Number.isSafeInteger(expectedOffset)) {
      throw new Error('La copia de FreeCut supera el tamaño máximo compatible.')
    }
    return {
      id: entry.id,
      blob: file.slice(
        HEADER_SIZE + manifestSize + entry.offset,
        HEADER_SIZE + manifestSize + expectedOffset,
        media.type,
      ),
    }
  })
  if (HEADER_SIZE + manifestSize + expectedOffset !== file.size) {
    throw new Error('La copia de FreeCut está incompleta o contiene datos sobrantes.')
  }
  return { snapshot: manifest.snapshot, assets }
}
