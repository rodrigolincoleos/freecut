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

export type CaptionSegment = {
  id: string
  mediaId: string
  start: number
  end: number
  text: string
}

export type ProjectSnapshot = {
  schemaVersion: 2
  id: 'default'
  name: string
  updatedAt: number
  media: ProjectMedia[]
  activeId: string
  overlayText: string
  captionSegments: CaptionSegment[]
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

function isProjectMedia(value: unknown): value is ProjectMedia {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<ProjectMedia>
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

function isValidProjectBase(value: Record<string, unknown>, schemaVersion: number): boolean {
  const media = value.media
  const ids = Array.isArray(media)
    ? media.flatMap((item) =>
        item && typeof item === 'object' && 'id' in item && typeof item.id === 'string'
          ? [item.id]
          : [],
      )
    : []
  return (
    value.schemaVersion === schemaVersion &&
    value.id === 'default' &&
    typeof value.name === 'string' &&
    typeof value.updatedAt === 'number' &&
    Number.isFinite(value.updatedAt) &&
    Array.isArray(media) &&
    media.every(isProjectMedia) &&
    new Set(ids).size === media.length &&
    typeof value.activeId === 'string' &&
    (value.activeId === '' || media.some((item) => item.id === value.activeId && item.kind === 'video')) &&
    typeof value.overlayText === 'string' &&
    typeof value.filterName === 'string'
  )
}

function isCaptionSegment(value: unknown, media: ProjectMedia[]): value is CaptionSegment {
  if (!value || typeof value !== 'object') return false
  const caption = value as Partial<CaptionSegment>
  const source = media.find((item) => item.id === caption.mediaId)
  return (
    typeof caption.id === 'string' &&
    caption.id.length > 0 &&
    typeof caption.mediaId === 'string' &&
    source?.kind === 'video' &&
    typeof caption.start === 'number' &&
    Number.isFinite(caption.start) &&
    caption.start >= 0 &&
    typeof caption.end === 'number' &&
    Number.isFinite(caption.end) &&
    caption.end > caption.start &&
    caption.end <= source.duration &&
    typeof caption.text === 'string' &&
    caption.text.length <= 2000
  )
}

export function validateProjectSnapshot(value: unknown): value is ProjectSnapshot {
  if (!value || typeof value !== 'object') return false
  const project = value as Record<string, unknown>
  if (!isValidProjectBase(project, 2)) return false
  const media = project.media as ProjectMedia[]
  const captions = project.captionSegments
  if (!Array.isArray(captions) || captions.length > 5000 || !captions.every((item) => isCaptionSegment(item, media))) {
    return false
  }
  const captionIds = captions.map((caption) => caption.id)
  return (
    new Set(captionIds).size === captions.length
  )
}

export function normalizeProjectSnapshot(value: unknown): ProjectSnapshot {
  if (validateProjectSnapshot(value)) return value
  if (!value || typeof value !== 'object') {
    throw new Error('El proyecto guardado tiene un formato no compatible.')
  }

  const legacy = value as Record<string, unknown>
  if (
    legacy.schemaVersion !== 1 ||
    !isValidProjectBase(legacy, 1) ||
    typeof legacy.captionText !== 'string'
  ) {
    throw new Error('El proyecto guardado tiene un formato no compatible.')
  }

  const media = legacy.media as ProjectMedia[]
  const activeVideo = media.find((item) => item.id === legacy.activeId && item.kind === 'video')
    ?? media.find((item) => item.kind === 'video')
  const captionText = legacy.captionText.trim()
  const captionEnd = activeVideo?.trimEnd || activeVideo?.duration || 0
  const captionSegments: CaptionSegment[] = captionText && activeVideo && captionEnd > activeVideo.trimStart
    ? [{
        id: `legacy-${activeVideo.id}`,
        mediaId: activeVideo.id,
        start: activeVideo.trimStart,
        end: captionEnd,
        text: captionText,
      }]
    : []
  const snapshot: ProjectSnapshot = {
    schemaVersion: 2,
    id: 'default',
    name: legacy.name as string,
    updatedAt: legacy.updatedAt as number,
    media,
    activeId: legacy.activeId as string,
    overlayText: legacy.overlayText as string,
    captionSegments,
    filterName: legacy.filterName as string,
  }
  if (!validateProjectSnapshot(snapshot)) {
    throw new Error('El proyecto guardado tiene un formato no compatible.')
  }
  return snapshot
}
