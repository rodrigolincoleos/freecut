export type MediaKind = 'video' | 'audio'

export type ProjectMedia = {
  id: string
  name: string
  type: string
  lastModified: number
  kind: MediaKind
  duration: number
  trimStart: number
  trimEnd: number
}

export type ProjectSnapshot = {
  schemaVersion: 1
  id: 'default'
  name: string
  updatedAt: number
  media: ProjectMedia[]
  activeId: string
  overlayText: string
  captionText: string
  filterName: string
}

export type ProjectAsset = {
  id: string
  blob: Blob
}

export type LoadedProject = {
  snapshot: ProjectSnapshot
  assets: ProjectAsset[]
}

export interface ProjectRepository {
  load(): Promise<LoadedProject | null>
  save(snapshot: ProjectSnapshot, assets: ProjectAsset[], replaceAssets?: boolean): Promise<void>
}

export function validateProjectSnapshot(value: unknown): value is ProjectSnapshot {
  if (!value || typeof value !== 'object') return false
  const project = value as Partial<ProjectSnapshot>
  const isMedia = (media: unknown): media is ProjectMedia => {
    if (!media || typeof media !== 'object') return false
    const item = media as Partial<ProjectMedia>
    return (
      typeof item.id === 'string' &&
      item.id.length > 0 &&
      typeof item.name === 'string' &&
      typeof item.type === 'string' &&
      typeof item.lastModified === 'number' &&
      Number.isFinite(item.lastModified) &&
      (item.kind === 'video' || item.kind === 'audio') &&
      typeof item.duration === 'number' &&
      Number.isFinite(item.duration) &&
      item.duration >= 0 &&
      typeof item.trimStart === 'number' &&
      Number.isFinite(item.trimStart) &&
      item.trimStart >= 0 &&
      typeof item.trimEnd === 'number' &&
      Number.isFinite(item.trimEnd) &&
      item.trimEnd >= item.trimStart &&
      item.trimStart <= item.duration &&
      item.trimEnd <= item.duration
    )
  }
  const media = project.media
  const ids = Array.isArray(media)
    ? media.flatMap((item) =>
        item && typeof item === 'object' && 'id' in item && typeof item.id === 'string'
          ? [item.id]
          : [],
      )
    : []

  return (
    project.schemaVersion === 1 &&
    project.id === 'default' &&
    typeof project.name === 'string' &&
    typeof project.updatedAt === 'number' &&
    Number.isFinite(project.updatedAt) &&
    Array.isArray(media) &&
    media.every(isMedia) &&
    new Set(ids).size === media.length &&
    typeof project.activeId === 'string' &&
    (project.activeId === '' || media.some((item) => item.id === project.activeId && item.kind === 'video')) &&
    typeof project.overlayText === 'string' &&
    typeof project.captionText === 'string' &&
    typeof project.filterName === 'string'
  )
}
