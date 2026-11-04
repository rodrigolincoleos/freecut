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
  rotation: 0 | 90 | 180 | 270
  flipHorizontal: boolean
  flipVertical: boolean
  scaleX: number
  scaleY: number
  offsetX: number
  offsetY: number
  volume: number
  audioFadeIn: number
  audioFadeOut: number
  videoFadeIn: number
  videoFadeOut: number
  speed: number
  reverse: boolean
}

export type CaptionSegment = {
  id: string
  mediaId: string
  start: number
  end: number
  text: string
}

export type CaptionStyle = 'classic' | 'outline' | 'pink' | 'italic' | 'yellow' | 'impact' | 'serif' | 'minimal'
export type VideoAspectRatio = 'original' | '9:16' | '16:9' | '1:1' | '4:3' | '3:4' | '3:2' | '2:1' | '2.35:1' | '1.85:1' | '128:27'

export type ProjectSnapshot = {
  schemaVersion: 6
  id: 'default'
  name: string
  updatedAt: number
  media: ProjectMedia[]
  activeId: string
  overlayText: string
  captionSegments: CaptionSegment[]
  captionStyle: CaptionStyle
  aspectRatio: VideoAspectRatio
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
  load(ownerId: string): Promise<LoadedProject | null>
  save(ownerId: string, snapshot: ProjectSnapshot, assets: ProjectAsset[], replaceAssets?: boolean): Promise<void>
  getLegacyProjectState(ownerId: string): Promise<'available' | 'owned' | 'claimed' | 'dismissed' | 'none'>
  claimLegacyProject(ownerId: string): Promise<LoadedProject>
  dismissLegacyProject(ownerId: string): Promise<void>
}

function isProjectMedia(value: unknown, requireTransform = true, requireClipEffects = true): value is ProjectMedia {
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
    item.trimEnd <= item.duration &&
    (!requireTransform || (
      (item.rotation === 0 || item.rotation === 90 || item.rotation === 180 || item.rotation === 270) &&
      typeof item.flipHorizontal === 'boolean' &&
      typeof item.flipVertical === 'boolean' &&
      typeof item.scaleX === 'number' &&
      Number.isFinite(item.scaleX) &&
      item.scaleX >= 0.1 &&
      item.scaleX <= 8 &&
      typeof item.scaleY === 'number' &&
      Number.isFinite(item.scaleY) &&
      item.scaleY >= 0.1 &&
      item.scaleY <= 8 &&
      typeof item.offsetX === 'number' &&
      Number.isFinite(item.offsetX) &&
      Math.abs(item.offsetX) <= 8 &&
      typeof item.offsetY === 'number' &&
      Number.isFinite(item.offsetY) &&
      Math.abs(item.offsetY) <= 8
    )) &&
    (!requireClipEffects || (
      typeof item.volume === 'number' &&
      Number.isFinite(item.volume) &&
      item.volume >= 0 &&
      item.volume <= 2 &&
      typeof item.audioFadeIn === 'number' &&
      Number.isFinite(item.audioFadeIn) &&
      item.audioFadeIn >= 0 &&
      item.audioFadeIn <= 10 &&
      typeof item.audioFadeOut === 'number' &&
      Number.isFinite(item.audioFadeOut) &&
      item.audioFadeOut >= 0 &&
      item.audioFadeOut <= 10 &&
      typeof item.videoFadeIn === 'number' &&
      Number.isFinite(item.videoFadeIn) &&
      item.videoFadeIn >= 0 &&
      item.videoFadeIn <= 10 &&
      typeof item.videoFadeOut === 'number' &&
      Number.isFinite(item.videoFadeOut) &&
      item.videoFadeOut >= 0 &&
      item.videoFadeOut <= 10 &&
      typeof item.speed === 'number' &&
      Number.isFinite(item.speed) &&
      item.speed >= 0.25 &&
      item.speed <= 4 &&
      typeof item.reverse === 'boolean'
    ))
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
    media.every((item) => isProjectMedia(item, schemaVersion >= 5, schemaVersion >= 6)) &&
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

function isCaptionStyle(value: unknown): value is CaptionStyle {
  return value === 'classic' ||
    value === 'outline' ||
    value === 'pink' ||
    value === 'italic' ||
    value === 'yellow' ||
    value === 'impact' ||
    value === 'serif' ||
    value === 'minimal'
}

function isVideoAspectRatio(value: unknown): value is VideoAspectRatio {
  return value === 'original' ||
    value === '9:16' ||
    value === '16:9' ||
    value === '1:1' ||
    value === '4:3' ||
    value === '3:4' ||
    value === '3:2' ||
    value === '2:1' ||
    value === '2.35:1' ||
    value === '1.85:1' ||
    value === '128:27'
}

function isCaptionSegments(value: unknown, media: ProjectMedia[]): value is CaptionSegment[] {
  return Array.isArray(value) &&
    value.length <= 5000 &&
    value.every((item) => isCaptionSegment(item, media)) &&
    new Set(value.map((caption) => caption.id)).size === value.length
}

export function validateProjectSnapshot(value: unknown): value is ProjectSnapshot {
  if (!value || typeof value !== 'object') return false
  const project = value as Record<string, unknown>
  if (!isValidProjectBase(project, 6)) return false
  const media = project.media as ProjectMedia[]
  return isCaptionSegments(project.captionSegments, media) &&
    isCaptionStyle(project.captionStyle) &&
    isVideoAspectRatio(project.aspectRatio)
}

export function normalizeProjectSnapshot(value: unknown): ProjectSnapshot {
  if (validateProjectSnapshot(value)) return value
  if (!value || typeof value !== 'object') {
    throw new Error('El proyecto guardado tiene un formato no compatible.')
  }

  const legacy = value as Record<string, unknown>
  let captionSegments: CaptionSegment[]
  let captionStyle: CaptionStyle = 'classic'
  let aspectRatio: VideoAspectRatio = 'original'
  if (
    legacy.schemaVersion === 1 &&
    isValidProjectBase(legacy, 1) &&
    typeof legacy.captionText === 'string'
  ) {
    const media = legacy.media as ProjectMedia[]
    const activeVideo = media.find((item) => item.id === legacy.activeId && item.kind === 'video')
      ?? media.find((item) => item.kind === 'video')
    const captionText = legacy.captionText.trim()
    const captionEnd = activeVideo?.trimEnd || activeVideo?.duration || 0
    captionSegments = captionText && activeVideo && captionEnd > activeVideo.trimStart
      ? [{
          id: `legacy-${activeVideo.id}`,
          mediaId: activeVideo.id,
          start: activeVideo.trimStart,
          end: captionEnd,
          text: captionText,
        }]
      : []
  } else if (
    legacy.schemaVersion === 2 &&
    isValidProjectBase(legacy, 2) &&
    isCaptionSegments(legacy.captionSegments, legacy.media as ProjectMedia[])
  ) {
    captionSegments = legacy.captionSegments
  } else if (
    legacy.schemaVersion === 3 &&
    isValidProjectBase(legacy, 3) &&
    isCaptionSegments(legacy.captionSegments, legacy.media as ProjectMedia[]) &&
    isCaptionStyle(legacy.captionStyle)
  ) {
    captionSegments = legacy.captionSegments
    captionStyle = legacy.captionStyle
  } else if (
    legacy.schemaVersion === 4 &&
    isValidProjectBase(legacy, 4) &&
    isCaptionSegments(legacy.captionSegments, legacy.media as ProjectMedia[]) &&
    isCaptionStyle(legacy.captionStyle) &&
    isVideoAspectRatio(legacy.aspectRatio)
  ) {
    captionSegments = legacy.captionSegments
    captionStyle = legacy.captionStyle
    aspectRatio = legacy.aspectRatio
  } else if (
    legacy.schemaVersion === 5 &&
    isValidProjectBase(legacy, 5) &&
    isCaptionSegments(legacy.captionSegments, legacy.media as ProjectMedia[]) &&
    isCaptionStyle(legacy.captionStyle) &&
    isVideoAspectRatio(legacy.aspectRatio)
  ) {
    captionSegments = legacy.captionSegments
    captionStyle = legacy.captionStyle
    aspectRatio = legacy.aspectRatio
  } else {
    throw new Error('El proyecto guardado tiene un formato no compatible.')
  }

  const snapshot: ProjectSnapshot = {
    schemaVersion: 6,
    id: 'default',
    name: legacy.name as string,
    updatedAt: legacy.updatedAt as number,
    media: (legacy.media as ProjectMedia[]).map((item) => ({
      ...item,
      rotation: item.rotation ?? 0,
      flipHorizontal: item.flipHorizontal ?? false,
      flipVertical: item.flipVertical ?? false,
      scaleX: item.scaleX ?? 1,
      scaleY: item.scaleY ?? 1,
      offsetX: item.offsetX ?? 0,
      offsetY: item.offsetY ?? 0,
      volume: item.volume ?? 1,
      audioFadeIn: item.audioFadeIn ?? 0,
      audioFadeOut: item.audioFadeOut ?? 0,
      videoFadeIn: item.videoFadeIn ?? 0,
      videoFadeOut: item.videoFadeOut ?? 0,
      speed: item.speed ?? 1,
      reverse: item.reverse ?? false,
    })),
    activeId: legacy.activeId as string,
    overlayText: legacy.overlayText as string,
    captionSegments,
    captionStyle: isCaptionStyle(legacy.captionStyle) ? legacy.captionStyle : captionStyle,
    aspectRatio: isVideoAspectRatio(legacy.aspectRatio) ? legacy.aspectRatio : aspectRatio,
    filterName: legacy.filterName as string,
  }
  if (!validateProjectSnapshot(snapshot)) {
    throw new Error('El proyecto guardado tiene un formato no compatible.')
  }
  return snapshot
}
