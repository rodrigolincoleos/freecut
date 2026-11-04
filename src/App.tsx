import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { useAuth0 } from '@auth0/auth0-react'
import { Capacitor } from '@capacitor/core'
import { indexedDbProjectRepository } from './data/indexedDbProjectRepository'
import { createProjectBackup, readProjectBackup } from './domain/projectBackup'
import type { CaptionSegment, CaptionStyle, LoadedProject, ProjectAsset, ProjectMedia, ProjectSnapshot, VideoAspectRatio } from './domain/project'
import { downloadBlob } from './utils/download'

type MediaItem = ProjectMedia & {
  file: File
  url: string
}
type Panel = 'media' | 'text' | 'audio' | 'effects' | 'captions' | 'aspect'
type SaveStatus = 'loading' | 'saved' | 'saving' | 'error'
type LegacyProjectState = 'checking' | 'available' | 'owned' | 'claimed' | 'dismissed' | 'none'
type TransformHandle = 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se'
type ClipTransform = Pick<ProjectMedia, 'rotation' | 'flipHorizontal' | 'flipVertical' | 'scaleX' | 'scaleY' | 'offsetX' | 'offsetY'>
type TransformResize = {
  pointerId: number
  handle: TransformHandle
  pointerX: number
  pointerY: number
  frameWidth: number
  frameHeight: number
  boundsWidth: number
  boundsHeight: number
  transform: ClipTransform
}
type TransformMove = {
  pointerId: number
  pointerX: number
  pointerY: number
  frameWidth: number
  frameHeight: number
  transform: ClipTransform
}

const formatTime = (seconds: number) => {
  if (!Number.isFinite(seconds)) return '00:00'
  const mins = Math.floor(seconds / 60).toString().padStart(2, '0')
  const secs = Math.floor(seconds % 60).toString().padStart(2, '0')
  return `${mins}:${secs}`
}

const filters = [
  { name: 'Original', css: 'none' },
  { name: 'Cálido', css: 'saturate(1.2) sepia(.17)' },
  { name: 'Frío', css: 'saturate(.85) hue-rotate(12deg)' },
  { name: 'B&N', css: 'grayscale(1)' },
  { name: 'Contraste', css: 'contrast(1.2) saturate(1.1)' },
]

const captionStyles: { id: CaptionStyle; name: string; sample: string }[] = [
  { id: 'classic', name: 'Limpio', sample: 'The quick brown fox' },
  { id: 'outline', name: 'Contorno', sample: 'El veloz zorro' },
  { id: 'pink', name: 'Recuadro rosa', sample: 'THE QUICK' },
  { id: 'italic', name: 'Itálica', sample: 'brown fox' },
  { id: 'yellow', name: 'Palabra clave', sample: 'THE QUICK FOX' },
  { id: 'impact', name: 'Condensado', sample: 'THE QUICK' },
  { id: 'serif', name: 'Serif', sample: 'zorro' },
  { id: 'minimal', name: 'Minimal', sample: 'THE QUICK BROWN FOX' },
]

const aspectRatios: { id: VideoAspectRatio; name: string; value: number | null }[] = [
  { id: 'original', name: 'Original', value: null },
  { id: '9:16', name: '9:16', value: 9 / 16 },
  { id: '16:9', name: '16:9', value: 16 / 9 },
  { id: '1:1', name: '1:1', value: 1 },
  { id: '4:3', name: '4:3', value: 4 / 3 },
  { id: '3:4', name: '3:4', value: 3 / 4 },
  { id: '3:2', name: '3:2', value: 3 / 2 },
  { id: '2:1', name: '2:1', value: 2 },
  { id: '2.35:1', name: '2.35:1', value: 2.35 },
  { id: '1.85:1', name: '1.85:1', value: 1.85 },
  { id: '128:27', name: '128:27', value: 128 / 27 },
]

function getAspectRatioValue(ratio: VideoAspectRatio, width: number, height: number) {
  return aspectRatios.find((item) => item.id === ratio)?.value ?? (width && height ? width / height : 16 / 9)
}

function getExportDimensions(width: number, height: number, ratio: VideoAspectRatio) {
  if (ratio === 'original' || !width || !height) return { width: width || 1280, height: height || 720 }
  const aspect = getAspectRatioValue(ratio, width, height)
  const sourceAspect = width / height
  const outputWidth = sourceAspect > aspect ? width : Math.ceil(height * aspect)
  const outputHeight = sourceAspect > aspect ? Math.ceil(width / aspect) : height
  return {
    width: Math.max(2, outputWidth + outputWidth % 2),
    height: Math.max(2, outputHeight + outputHeight % 2),
  }
}

function getBaseVideoSize(
  frameWidth: number,
  frameHeight: number,
  sourceWidth: number,
  sourceHeight: number,
  rotation: number,
) {
  if (!frameWidth || !frameHeight || !sourceWidth || !sourceHeight) {
    return { width: frameWidth, height: frameHeight }
  }
  const swapsDimensions = rotation === 90 || rotation === 270
  const rotatedWidth = swapsDimensions ? sourceHeight : sourceWidth
  const rotatedHeight = swapsDimensions ? sourceWidth : sourceHeight
  const scale = Math.min(frameWidth / rotatedWidth, frameHeight / rotatedHeight)
  return { width: sourceWidth * scale, height: sourceHeight * scale }
}

function getTransformedBounds(
  frameWidth: number,
  frameHeight: number,
  sourceWidth: number,
  sourceHeight: number,
  transform: ClipTransform,
) {
  const base = getBaseVideoSize(frameWidth, frameHeight, sourceWidth, sourceHeight, transform.rotation)
  const radians = transform.rotation * Math.PI / 180
  const width = Math.abs(Math.cos(radians)) * base.width * transform.scaleX
    + Math.abs(Math.sin(radians)) * base.height * transform.scaleY
  const height = Math.abs(Math.sin(radians)) * base.width * transform.scaleX
    + Math.abs(Math.cos(radians)) * base.height * transform.scaleY
  const centerX = frameWidth / 2 + transform.offsetX * frameWidth
  const centerY = frameHeight / 2 + transform.offsetY * frameHeight
  return {
    left: centerX - width / 2,
    top: centerY - height / 2,
    width,
    height,
    base,
  }
}

function getClipFade(value: number, duration: number) {
  return value > 0 ? Math.max(0, Math.min(1, duration / value)) : 1
}

function getVideoOpacity(clip: ProjectMedia, time: number) {
  const fadeIn = getClipFade(clip.videoFadeIn, clip.reverse ? clip.trimEnd - time : time - clip.trimStart)
  const fadeOut = getClipFade(clip.videoFadeOut, clip.reverse ? time - clip.trimStart : clip.trimEnd - time)
  return Math.min(fadeIn, fadeOut)
}

function getAudioGain(clip: ProjectMedia, time: number) {
  const fadeIn = getClipFade(clip.audioFadeIn, time - clip.trimStart)
  const fadeOut = getClipFade(clip.audioFadeOut, clip.trimEnd - time)
  return clip.reverse ? 0 : clip.volume * Math.min(fadeIn, fadeOut)
}

function drawVideoFrame(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  width: number,
  height: number,
  transform: ClipTransform,
) {
  const display = getBaseVideoSize(width, height, video.videoWidth, video.videoHeight, transform.rotation)
  context.fillStyle = '#000'
  context.fillRect(0, 0, width, height)
  context.save()
  context.translate(width / 2 + transform.offsetX * width, height / 2 + transform.offsetY * height)
  context.rotate(transform.rotation * Math.PI / 180)
  context.scale(
    transform.scaleX * (transform.flipHorizontal ? -1 : 1),
    transform.scaleY * (transform.flipVertical ? -1 : 1),
  )
  context.drawImage(video, -display.width / 2, -display.height / 2, display.width, display.height)
  context.restore()
}

function drawCaption(
  context: CanvasRenderingContext2D,
  text: string,
  style: CaptionStyle,
  width: number,
  height: number,
) {
  const fontSize = Math.max(16, Math.round(width * 0.027))
  const uppercase = style === 'impact' || style === 'yellow' || style === 'minimal'
  const captionText = uppercase ? text.toLocaleUpperCase() : text
  const italic = style === 'italic'
  const fontFamily = style === 'serif' ? 'Georgia, serif' : 'system-ui, sans-serif'
  const condensed = style === 'impact' || style === 'yellow'
  const fontWeight = style === 'classic' || style === 'minimal' ? 500 : italic || style === 'serif' ? 700 : 800
  const fontStyle = italic ? 'italic ' : ''
  const resolvedFontFamily = condensed ? 'Impact, "Arial Narrow", sans-serif' : fontFamily
  context.font = `${fontStyle}${fontWeight} ${fontSize}px ${resolvedFontFamily}`
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.lineJoin = 'round'

  const maxWidth = width * 0.9
  const lines: string[][] = []
  for (const paragraph of captionText.split(/\r?\n/)) {
    let line: string[] = []
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = [...line, word]
      if (line.length && context.measureText(candidate.join(' ')).width > maxWidth) {
        lines.push(line)
        line = [word]
      } else {
        line = candidate
      }
    }
    if (line) lines.push(line)
  }
  if (!lines.length) return

  const lineHeight = fontSize * 1.2
  const paddingX = style === 'pink' ? fontSize * 0.45 : 0
  const paddingY = style === 'pink' ? fontSize * 0.24 : 0
  const bottom = height * 0.97
  const lastWordIndex = lines.flat().length - 1
  let wordIndex = 0
  lines.forEach((line, index) => {
    const y = bottom - (lines.length - index - 0.5) * lineHeight
    const lineText = line.join(' ')
    const measuredWidth = Math.min(context.measureText(lineText).width, maxWidth)
    const startX = width / 2 - measuredWidth / 2
    context.shadowColor = 'rgba(0,0,0,.8)'
    context.shadowBlur = style === 'classic' || style === 'italic' || style === 'serif' ? fontSize * 0.2 : 0
    context.shadowOffsetY = style === 'classic' || style === 'italic' || style === 'serif' ? fontSize * 0.07 : 0
    if (style === 'pink') {
      const boxWidth = measuredWidth + paddingX * 2
      const boxHeight = lineHeight + paddingY * 2
      const left = width / 2 - boxWidth / 2
      const top = y - boxHeight / 2
      context.fillStyle = '#f2a9c5'
      context.shadowBlur = 0
      context.shadowOffsetY = 0
      context.beginPath()
      context.roundRect(left, top, boxWidth, boxHeight, fontSize * 0.18)
      context.fill()
    }
    context.lineWidth = style === 'classic' || style === 'minimal' || style === 'pink'
      ? 0
      : Math.max(2, fontSize * (style === 'impact' || style === 'yellow' ? 0.1 : 0.08))
    context.strokeStyle = style === 'serif' ? 'rgba(35,25,18,.9)' : 'rgba(0,0,0,.9)'
    let x = startX
    line.forEach((word, wordPosition) => {
      if (wordPosition > 0) x += context.measureText(' ').width
      const wordWidth = context.measureText(word).width
      context.fillStyle = style === 'pink'
        ? '#17151a'
        : style === 'yellow' && wordIndex === lastWordIndex
          ? '#ffe44d'
          : style === 'serif'
            ? '#fff1db'
            : '#fff'
      if (context.lineWidth) context.strokeText(word, x + wordWidth / 2, y)
      context.fillText(word, x + wordWidth / 2, y)
      x += wordWidth
      wordIndex += 1
    })
  })
}

function getCaptionParts(text: string, style: CaptionStyle) {
  const value = style === 'yellow' || style === 'impact' || style === 'minimal'
    ? text.toLocaleUpperCase()
    : text
  const parts = value.split(/(\s+)/)
  let lastWord = -1
  for (let index = 0; index < parts.length; index += 1) {
    if (/\S/.test(parts[index])) lastWord = index
  }
  return parts.map((part, index) => ({ text: part, highlighted: style === 'yellow' && index === lastWord }))
}

function App() {
  const { getAccessTokenSilently, logout, user } = useAuth0()
  const [media, setMedia] = useState<MediaItem[]>([])
  const [activeId, setActiveId] = useState('')
  const [projectName, setProjectName] = useState('Proyecto sin título')
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('loading')
  const [storageAvailable, setStorageAvailable] = useState(false)
  const [isReady, setIsReady] = useState(false)
  const [isRestoringBackup, setIsRestoringBackup] = useState(false)
  const [activePanel, setActivePanel] = useState<Panel>('media')
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [trimStart, setTrimStart] = useState(0)
  const [trimEnd, setTrimEnd] = useState(0)
  const [overlayText, setOverlayText] = useState('')
  const [captionSegments, setCaptionSegments] = useState<CaptionSegment[]>([])
  const [captionStyle, setCaptionStyle] = useState<CaptionStyle>('classic')
  const [aspectRatio, setAspectRatio] = useState<VideoAspectRatio>('original')
  const [transcriptionLanguage, setTranscriptionLanguage] = useState('es')
  const [isTranscribing, setIsTranscribing] = useState(false)
  const [isLoggingOut, setIsLoggingOut] = useState(false)
  const [filter, setFilter] = useState(filters[0])
  const [videoDimensions, setVideoDimensions] = useState({ width: 0, height: 0 })
  const [previewStageSize, setPreviewStageSize] = useState({ width: 0, height: 0 })
  const [isExporting, setIsExporting] = useState(false)
  const [pendingExport, setPendingExport] = useState<{ blob: Blob; filename: string } | null>(null)
  const [notice, setNotice] = useState('')
  const [dragId, setDragId] = useState('')
  const [isBladeToolActive, setIsBladeToolActive] = useState(false)
  const [isTransformSelected, setIsTransformSelected] = useState(false)
  const [legacyProjectState, setLegacyProjectState] = useState<LegacyProjectState>('checking')
  const ownerId = user?.sub
  const videoRef = useRef<HTMLVideoElement>(null)
  const previewStageRef = useRef<HTMLDivElement>(null)
  const timelineTrackRef = useRef<HTMLDivElement>(null)
  const timelineScrubPointerRef = useRef<number | null>(null)
  const pendingTimelineSeekRef = useRef<{ id: string; time: number } | null>(null)
  const transformResizeRef = useRef<TransformResize | null>(null)
  const transformMoveRef = useRef<TransformMove | null>(null)
  const reverseTimerRef = useRef<number | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const backupInputRef = useRef<HTMLInputElement>(null)
  const mediaRef = useRef(media)
  const activeIdRef = useRef(activeId)
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const saveVersionRef = useRef(0)
  const audioContextRef = useRef<AudioContext | null>(null)
  const audioGainsRef = useRef(new WeakMap<HTMLVideoElement, GainNode>())
  const audioSourcesRef = useRef(new WeakMap<HTMLVideoElement, MediaElementAudioSourceNode>())

  const videos = media.filter((item) => item.kind === 'video')
  const audioItems = media.filter((item) => item.kind === 'audio')
  const activeVideo = videos.find((item) => item.id === activeId) ?? videos[0]
  const activeAudio = audioItems[0]
  const activeCaptions = captionSegments
    .filter((caption) => caption.mediaId === activeVideo?.id)
    .sort((a, b) => a.start - b.start)
  const previewCaption = activeCaptions.find((caption) =>
    currentTime >= caption.start && currentTime < caption.end,
  )
  const activeClipIndex = activeVideo ? videos.findIndex((item) => item.id === activeVideo.id) : -1
  const timelineTime = activeClipIndex < 0 ? 0 : videos
    .slice(0, activeClipIndex)
    .reduce((time, item) => time + Math.max(item.trimEnd - item.trimStart, 0) / item.speed, 0)
    + Math.max(0, Math.min(
      (activeVideo.reverse ? activeVideo.trimEnd - currentTime : currentTime - activeVideo.trimStart) / activeVideo.speed,
      (activeVideo.trimEnd - activeVideo.trimStart) / activeVideo.speed,
    ))
  const totalDuration = videos.reduce(
    (total, item) => total + Math.max(item.trimEnd - item.trimStart, 0) / item.speed,
    0,
  )
  const previewAspectRatio = getAspectRatioValue(aspectRatio, videoDimensions.width, videoDimensions.height)
  const previewFrameHeight = Math.min(
    previewStageSize.height,
    previewStageSize.width / previewAspectRatio,
  )
  const previewFrameWidth = previewFrameHeight * previewAspectRatio
  const activeTransform: ClipTransform | null = activeVideo ? {
    rotation: activeVideo.rotation,
    flipHorizontal: activeVideo.flipHorizontal,
    flipVertical: activeVideo.flipVertical,
    scaleX: activeVideo.scaleX,
    scaleY: activeVideo.scaleY,
    offsetX: activeVideo.offsetX,
    offsetY: activeVideo.offsetY,
  } : null
  const transformedBounds = activeVideo && activeTransform
    ? getTransformedBounds(
        previewFrameWidth,
        previewFrameHeight,
        videoDimensions.width,
        videoDimensions.height,
        activeTransform,
      )
    : null

  const measurePreviewStage = () => {
    const stage = previewStageRef.current
    if (!stage) return
    const styles = getComputedStyle(stage)
    const width = stage.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight)
    const height = stage.clientHeight - parseFloat(styles.paddingTop) - parseFloat(styles.paddingBottom)
    setPreviewStageSize({ width, height })
  }

  useLayoutEffect(() => {
    const stage = previewStageRef.current
    if (!stage) return
    measurePreviewStage()
    const observer = new ResizeObserver(([entry]) => {
      setPreviewStageSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      })
    })
    observer.observe(stage)
    return () => observer.disconnect()
  }, [])

  const applyLoadedProject = (saved: LoadedProject) => {
    const restoredMedia = saved.snapshot.media.map((item) => {
      const asset = saved.assets.find((entry) => entry.id === item.id)
      if (!asset) throw new Error(`No se encontró el archivo "${item.name}".`)
      const file = new File([asset.blob], item.name, {
        type: item.type,
        lastModified: item.lastModified,
      })
      return { ...item, file, url: URL.createObjectURL(file) }
    })
    mediaRef.current = restoredMedia
    setMedia(restoredMedia)
    setProjectName(saved.snapshot.name)
    activeIdRef.current = saved.snapshot.activeId
    setActiveId(saved.snapshot.activeId)
    setTrimStart(restoredMedia.find((item) => item.id === saved.snapshot.activeId)?.trimStart ?? 0)
    setTrimEnd(restoredMedia.find((item) => item.id === saved.snapshot.activeId)?.trimEnd ?? 0)
    setOverlayText(saved.snapshot.overlayText)
    setCaptionSegments(saved.snapshot.captionSegments)
    setCaptionStyle(saved.snapshot.captionStyle)
    setAspectRatio(saved.snapshot.aspectRatio)
    setFilter(filters.find((item) => item.name === saved.snapshot.filterName) ?? filters[0])
  }

  useEffect(() => {
    let cancelled = false
    if (!ownerId) {
      setStorageAvailable(false)
      setSaveStatus('error')
      setNotice('No se pudo determinar tu identidad Auth0 para abrir el proyecto.')
      setLegacyProjectState('none')
      setIsReady(true)
      return () => {
        cancelled = true
      }
    }
    indexedDbProjectRepository.load(ownerId).then(async (saved) => {
      if (cancelled) return
      if (saved) applyLoadedProject(saved)
      const legacyState = saved ? 'none' : await indexedDbProjectRepository.getLegacyProjectState(ownerId)
      if (cancelled) return
      setLegacyProjectState(legacyState)
      setStorageAvailable(true)
      setSaveStatus('saved')
      setIsReady(true)
    }).catch((error: unknown) => {
      if (cancelled) return
      setStorageAvailable(false)
      setSaveStatus('error')
      setNotice(error instanceof Error ? `No se pudo abrir el proyecto guardado: ${error.message}` : 'No se pudo abrir el proyecto guardado.')
      setIsReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [ownerId])

  useEffect(() => {
    if (!import.meta.env.PROD || Capacitor.isNativePlatform() || !('serviceWorker' in navigator)) return
    navigator.serviceWorker.register('/sw.js').catch((error: unknown) => {
      setNotice(error instanceof Error ? `No se pudo activar el modo instalable: ${error.message}` : 'No se pudo activar el modo instalable.')
    })
  }, [])

  useEffect(() => {
    if (!activeVideo) {
      setActiveId('')
      activeIdRef.current = ''
      setTrimStart(0)
      setTrimEnd(0)
      setCurrentTime(0)
      return
    }
    const changed = activeIdRef.current !== activeVideo.id
    if (activeId !== activeVideo.id) setActiveId(activeVideo.id)
    if (changed) {
      activeIdRef.current = activeVideo.id
      setTrimStart(activeVideo.trimStart)
      setTrimEnd(activeVideo.trimEnd || activeVideo.duration)
      setCurrentTime(activeVideo.reverse ? activeVideo.trimEnd : activeVideo.trimStart)
      videoRef.current?.pause()
      if (reverseTimerRef.current !== null) window.clearInterval(reverseTimerRef.current)
      reverseTimerRef.current = null
      setIsPlaying(false)
    }
  }, [activeVideo?.id])

  useEffect(() => {
    const video = videoRef.current
    if (!video || !activeVideo) return
    if (!activeVideo.reverse) video.playbackRate = activeVideo.speed
    updatePreviewAudioGain(video, activeVideo, video.currentTime)
  }, [activeVideo?.speed, activeVideo?.reverse, activeVideo?.volume, activeVideo?.audioFadeIn, activeVideo?.audioFadeOut])

  useEffect(() => {
    if (!isReady || !storageAvailable || !ownerId || legacyProjectState === 'checking'
      || legacyProjectState === 'available' || legacyProjectState === 'owned') return
    const snapshot: ProjectSnapshot = {
      schemaVersion: 6,
      id: 'default',
      name: projectName.trim() || 'Proyecto sin título',
      updatedAt: Date.now(),
      media: media.map(({ file: _file, url: _url, ...item }) => item),
      activeId: activeVideo?.id ?? '',
      overlayText,
      captionSegments,
      captionStyle,
      aspectRatio,
      filterName: filter.name,
    }
    const assets = media.map((item) => ({ id: item.id, blob: item.file }))
    const version = ++saveVersionRef.current
    setSaveStatus('saving')
    const timer = window.setTimeout(() => {
      const save = saveQueueRef.current
        .catch(() => undefined)
        .then(() => indexedDbProjectRepository.save(ownerId, snapshot, assets))
      saveQueueRef.current = save
      save.then(() => {
        if (version === saveVersionRef.current) setSaveStatus('saved')
      }).catch((error: unknown) => {
        if (version !== saveVersionRef.current) return
        setSaveStatus('error')
        setNotice(error instanceof Error ? `No se pudo guardar el proyecto: ${error.message}` : 'No se pudo guardar el proyecto.')
      })
    }, 500)
    return () => window.clearTimeout(timer)
  }, [isReady, storageAvailable, ownerId, legacyProjectState, projectName, media, activeVideo?.id, overlayText, captionSegments, captionStyle, aspectRatio, filter.name])

  useEffect(() => {
    mediaRef.current = media
  }, [media])

  useEffect(() => {
    return () => {
      if (reverseTimerRef.current !== null) window.clearInterval(reverseTimerRef.current)
      mediaRef.current.forEach((item) => URL.revokeObjectURL(item.url))
      void audioContextRef.current?.close()
    }
  }, [])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 4000)
    return () => window.clearTimeout(timer)
  }, [notice])

  const addFiles = (files: FileList | File[]) => {
    const accepted = Array.from(files).filter(
      (file) => file.type.startsWith('video/') || file.type.startsWith('audio/'),
    )
    if (!accepted.length) {
      setNotice('Elige archivos de video o audio para importarlos.')
      return
    }
    const additions: MediaItem[] = accepted.map((file) => ({
      id: crypto.randomUUID(),
      name: file.name,
      type: file.type,
      lastModified: file.lastModified,
      file,
      url: URL.createObjectURL(file),
      kind: file.type.startsWith('video/') ? 'video' as const : 'audio' as const,
      duration: 0,
      trimStart: 0,
      trimEnd: 0,
      rotation: 0 as const,
      flipHorizontal: false,
      flipVertical: false,
      scaleX: 1,
      scaleY: 1,
      offsetX: 0,
      offsetY: 0,
      volume: 1,
      audioFadeIn: 0,
      audioFadeOut: 0,
      videoFadeIn: 0,
      videoFadeOut: 0,
      speed: 1,
      reverse: false,
    }))
    setMedia((current) => [...current, ...additions])
    const firstVideo = additions.find((item) => item.kind === 'video')
    if (firstVideo && !activeId) setActiveId(firstVideo.id)
    setNotice(`${accepted.length} archivo${accepted.length === 1 ? '' : 's'} importado${accepted.length === 1 ? '' : 's'}.`)
  }

  const updateDuration = (id: string, duration: number) => {
    if (!Number.isFinite(duration) || duration <= 0) return
    const item = media.find((entry) => entry.id === id)
    if (!item || item.duration === duration) return
    const updatedTrimEnd = item.trimEnd > 0 ? Math.min(item.trimEnd, duration) : duration
    setMedia((items) => items.map((entry) =>
      entry.id === id ? { ...entry, duration, trimEnd: updatedTrimEnd } : entry,
    ))
    if (id === activeId && trimEnd === 0) {
      setTrimEnd(updatedTrimEnd)
    }
  }

  const ensureVideoAudioGraph = (video: HTMLVideoElement) => {
    const audioContext = audioContextRef.current ?? new AudioContext()
    audioContextRef.current = audioContext
    let gain = audioGainsRef.current.get(video)
    if (!gain) {
      const source = audioSourcesRef.current.get(video) ?? audioContext.createMediaElementSource(video)
      gain = audioContext.createGain()
      source.connect(gain)
      gain.connect(audioContext.destination)
      audioSourcesRef.current.set(video, source)
      audioGainsRef.current.set(video, gain)
    }
    return { audioContext, gain }
  }

  const updatePreviewAudioGain = (video: HTMLVideoElement, clip: ProjectMedia, time: number) => {
    const gain = audioGainsRef.current.get(video)
    if (gain) gain.gain.setTargetAtTime(getAudioGain(clip, time), gain.context.currentTime, 0.015)
  }

  const handleTimeUpdate = () => {
    const video = videoRef.current
    if (!video) return
    setCurrentTime(video.currentTime)
    if (activeVideo) updatePreviewAudioGain(video, activeVideo, video.currentTime)
    const clipEnd = activeVideo?.trimEnd || trimEnd
    const clipStart = activeVideo?.trimStart ?? trimStart
    if (activeVideo?.reverse && clipEnd > clipStart && video.currentTime <= clipStart) {
      video.pause()
      video.currentTime = clipStart
      setIsPlaying(false)
      if (reverseTimerRef.current !== null) window.clearInterval(reverseTimerRef.current)
      reverseTimerRef.current = null
    } else if (clipEnd > clipStart && video.currentTime >= clipEnd && !activeVideo?.reverse) {
      video.pause()
      video.currentTime = clipStart
      setIsPlaying(false)
    }
  }

  const togglePlayback = async () => {
    const video = videoRef.current
    if (!video || !activeVideo) return
    const clipStart = activeVideo.trimStart
    const clipEnd = activeVideo.trimEnd || activeVideo.duration
    if (!isPlaying) {
      try {
        const { audioContext, gain } = ensureVideoAudioGraph(video)
        await audioContext.resume()
        video.playbackRate = activeVideo.speed
        if (activeVideo.reverse) {
          video.pause()
          if (video.currentTime <= clipStart || video.currentTime > clipEnd) video.currentTime = clipEnd
          gain.gain.setTargetAtTime(0, audioContext.currentTime, 0.015)
          setIsPlaying(true)
          let previousTime = performance.now()
          reverseTimerRef.current = window.setInterval(() => {
            const clip = mediaRef.current.find((item) => item.id === activeVideo.id && item.kind === 'video')
            if (!videoRef.current || !clip || activeIdRef.current !== clip.id) {
              if (reverseTimerRef.current !== null) window.clearInterval(reverseTimerRef.current)
              reverseTimerRef.current = null
              setIsPlaying(false)
              return
            }
            const timestamp = performance.now()
            const elapsed = timestamp - previousTime
            previousTime = timestamp
            if (!video.seeking) {
              const nextTime = Math.max(clip.trimStart, video.currentTime - elapsed / 1000 * clip.speed)
              video.currentTime = nextTime
              setCurrentTime(nextTime)
              if (nextTime <= clip.trimStart) {
                video.pause()
                setIsPlaying(false)
                if (reverseTimerRef.current !== null) window.clearInterval(reverseTimerRef.current)
                reverseTimerRef.current = null
              }
            }
          }, 1000 / 30)
          return
        }
        if (video.currentTime < clipStart || video.currentTime >= clipEnd) video.currentTime = clipStart
        updatePreviewAudioGain(video, activeVideo, video.currentTime)
        await video.play()
        setIsPlaying(true)
      } catch {
        setNotice('No se pudo reproducir este archivo en el navegador.')
      }
    } else {
      video.pause()
      setIsPlaying(false)
      if (reverseTimerRef.current !== null) window.clearInterval(reverseTimerRef.current)
      reverseTimerRef.current = null
    }
  }

  const seek = (time: number) => {
    const video = videoRef.current
    if (!video || !Number.isFinite(time)) return
    const nextTime = Math.max(0, Math.min(time, activeVideo?.duration ?? time))
    video.currentTime = nextTime
    setCurrentTime(nextTime)
    if (activeVideo) updatePreviewAudioGain(video, activeVideo, nextTime)
  }

  const seekTimelinePosition = (clientX: number) => {
    const track = timelineTrackRef.current
    if (!track || totalDuration <= 0 || videos.length === 0) return
    const bounds = track.getBoundingClientRect()
    if (!bounds.width) return
    const progress = Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width))
    let remaining = Math.min(progress * totalDuration, Math.max(0, totalDuration - 0.001))
    let target = videos[videos.length - 1]
    let elapsed = 0
    for (const clip of videos) {
      const clipDuration = Math.max(clip.trimEnd - clip.trimStart, 0) / clip.speed
      target = clip
      elapsed = Math.min(remaining, clipDuration)
      if (remaining < clipDuration) break
      remaining -= clipDuration
    }
    const clipStart = target.trimStart
    const clipEnd = target.trimEnd || target.duration
    const sourceTime = target.reverse
      ? Math.max(clipStart + 0.001, clipEnd - elapsed * target.speed)
      : Math.min(clipEnd - 0.001, clipStart + elapsed * target.speed)
    if (target.id !== activeIdRef.current) {
      pendingTimelineSeekRef.current = { id: target.id, time: sourceTime }
      setActiveId(target.id)
    } else {
      pendingTimelineSeekRef.current = null
      const video = videoRef.current
      if (video) {
        video.currentTime = sourceTime
        updatePreviewAudioGain(video, target, sourceTime)
      }
    }
    setCurrentTime(sourceTime)
  }

  const beginTimelineScrub = (event: ReactPointerEvent<HTMLElement>) => {
    if (!event.isPrimary || event.button !== 0 || totalDuration <= 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    timelineScrubPointerRef.current = event.pointerId
    if (isPlaying) {
      videoRef.current?.pause()
      if (reverseTimerRef.current !== null) window.clearInterval(reverseTimerRef.current)
      reverseTimerRef.current = null
      setIsPlaying(false)
    }
    seekTimelinePosition(event.clientX)
  }

  const moveTimelineScrub = (event: ReactPointerEvent<HTMLElement>) => {
    if (timelineScrubPointerRef.current !== event.pointerId) return
    seekTimelinePosition(event.clientX)
  }

  const endTimelineScrub = (event: ReactPointerEvent<HTMLElement>) => {
    if (timelineScrubPointerRef.current !== event.pointerId) return
    timelineScrubPointerRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const updateTrimStart = (value: number) => {
    if (!activeVideo || !Number.isFinite(value)) return
    const nextStart = Math.max(0, Math.min(value, Math.max(0, trimEnd - .1)))
    setTrimStart(nextStart)
    setMedia((items) => items.map((item) =>
      item.id === activeVideo.id ? { ...item, trimStart: nextStart } : item,
    ))
    seek(nextStart)
  }

  const updateTrimEnd = (value: number) => {
    if (!activeVideo || !Number.isFinite(value)) return
    const nextEnd = Math.min(activeVideo.duration, Math.max(trimStart + .1, value))
    setTrimEnd(nextEnd)
    setMedia((items) => items.map((item) =>
      item.id === activeVideo.id ? { ...item, trimEnd: nextEnd } : item,
    ))
  }

  const updateClipTransform = (transform: Partial<ClipTransform>) => {
    if (!activeVideo) return
    setMedia((items) => items.map((item) =>
      item.id === activeVideo.id ? { ...item, ...transform } : item,
    ))
  }

  const updateClipEffects = (updates: Partial<Pick<ProjectMedia, 'volume' | 'audioFadeIn' | 'audioFadeOut' | 'videoFadeIn' | 'videoFadeOut' | 'speed' | 'reverse'>>) => {
    if (!activeVideo) return
    setMedia((items) => items.map((item) =>
      item.id === activeVideo.id ? { ...item, ...updates } : item,
    ))
    const video = videoRef.current
    if (video && updates.speed !== undefined && !activeVideo.reverse) video.playbackRate = updates.speed
    if (video && (updates.volume !== undefined || updates.audioFadeIn !== undefined || updates.audioFadeOut !== undefined)) {
      updatePreviewAudioGain(video, { ...activeVideo, ...updates }, video.currentTime)
    }
    if (video && updates.reverse !== undefined) {
      video.pause()
      if (reverseTimerRef.current !== null) window.clearInterval(reverseTimerRef.current)
      reverseTimerRef.current = null
      setIsPlaying(false)
      if (updates.reverse && video.currentTime <= activeVideo.trimStart) video.currentTime = activeVideo.trimEnd
      if (!updates.reverse) video.playbackRate = activeVideo.speed
      updatePreviewAudioGain(video, { ...activeVideo, ...updates }, video.currentTime)
    }
  }

  const rotateClip = (direction: -1 | 1) => {
    if (!activeVideo) return
    updateClipTransform({ rotation: ((activeVideo.rotation + direction * 90 + 360) % 360) as ProjectMedia['rotation'] })
  }

  const resetClipTransform = () => updateClipTransform({
    rotation: 0,
    flipHorizontal: false,
    flipVertical: false,
    scaleX: 1,
    scaleY: 1,
    offsetX: 0,
    offsetY: 0,
  })

  const startTransformResize = (event: ReactPointerEvent<HTMLButtonElement>, handle: TransformHandle) => {
    if (!activeVideo || !activeTransform || !transformedBounds || !previewFrameWidth || !previewFrameHeight) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    setIsTransformSelected(true)
    transformResizeRef.current = {
      pointerId: event.pointerId,
      handle,
      pointerX: event.clientX,
      pointerY: event.clientY,
      frameWidth: previewFrameWidth,
      frameHeight: previewFrameHeight,
      boundsWidth: transformedBounds.width,
      boundsHeight: transformedBounds.height,
      transform: activeTransform,
    }
  }

  const resizeTransform = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = transformResizeRef.current
    if (!drag || drag.pointerId !== event.pointerId || !activeVideo) return
    const deltaX = event.clientX - drag.pointerX
    const deltaY = event.clientY - drag.pointerY
    const { handle, transform } = drag
    const next: Partial<ClipTransform> = {}
    const horizontalHandle = handle.includes('e') || handle.includes('w')
    const verticalHandle = handle.includes('n') || handle.includes('s')
    const horizontalAxisUsesScaleX = Math.abs(transform.rotation % 180) === 0

    if ((handle === 'e' || handle === 'w') && horizontalHandle) {
      const direction = handle === 'e' ? 1 : -1
      const axis = horizontalAxisUsesScaleX ? 'scaleX' : 'scaleY'
      const scale = transform[axis] * (drag.boundsWidth + direction * deltaX) / drag.boundsWidth
      const boundedScale = Math.max(0.1, Math.min(8, scale))
      next[axis] = boundedScale
      next.offsetX = Math.max(-8, Math.min(8, transform.offsetX + direction * drag.boundsWidth * (boundedScale / transform[axis] - 1) / (2 * drag.frameWidth)))
    } else if ((handle === 'n' || handle === 's') && verticalHandle) {
      const direction = handle === 's' ? 1 : -1
      const axis = horizontalAxisUsesScaleX ? 'scaleY' : 'scaleX'
      const scale = transform[axis] * (drag.boundsHeight + direction * deltaY) / drag.boundsHeight
      const boundedScale = Math.max(0.1, Math.min(8, scale))
      next[axis] = boundedScale
      next.offsetY = Math.max(-8, Math.min(8, transform.offsetY + direction * drag.boundsHeight * (boundedScale / transform[axis] - 1) / (2 * drag.frameHeight)))
    } else {
      const directionX = handle.includes('e') ? 1 : -1
      const directionY = handle.includes('s') ? 1 : -1
      const startX = directionX * drag.boundsWidth / 2
      const startY = directionY * drag.boundsHeight / 2
      const denominator = startX * startX + startY * startY
      const factor = Math.max(0.1, Math.min(
        Math.min(8 / transform.scaleX, 8 / transform.scaleY),
        ((startX + deltaX) * startX + (startY + deltaY) * startY) / denominator,
      ))
      next.scaleX = transform.scaleX * factor
      next.scaleY = transform.scaleY * factor
      next.offsetX = Math.max(-8, Math.min(8, transform.offsetX + startX * (factor - 1) / drag.frameWidth))
      next.offsetY = Math.max(-8, Math.min(8, transform.offsetY + startY * (factor - 1) / drag.frameHeight))
    }
    updateClipTransform(next)
  }

  const endTransformResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (transformResizeRef.current?.pointerId === event.pointerId) transformResizeRef.current = null
    if (transformMoveRef.current?.pointerId === event.pointerId) transformMoveRef.current = null
  }

  const startTransformMove = (event: ReactPointerEvent<HTMLVideoElement>) => {
    if (!activeVideo || !activeTransform || !previewFrameWidth || !previewFrameHeight) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    setIsTransformSelected(true)
    transformMoveRef.current = {
      pointerId: event.pointerId,
      pointerX: event.clientX,
      pointerY: event.clientY,
      frameWidth: previewFrameWidth,
      frameHeight: previewFrameHeight,
      transform: activeTransform,
    }
  }

  const moveTransform = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = transformMoveRef.current
    if (!drag || drag.pointerId !== event.pointerId || !activeVideo) return
    updateClipTransform({
      offsetX: Math.max(-8, Math.min(8, drag.transform.offsetX + (event.clientX - drag.pointerX) / drag.frameWidth)),
      offsetY: Math.max(-8, Math.min(8, drag.transform.offsetY + (event.clientY - drag.pointerY) / drag.frameHeight)),
    })
  }

  const splitClipAt = (clipId: string, time: number) => {
    const clip = media.find((item) => item.id === clipId && item.kind === 'video')
    if (!clip) return
    const clipEnd = clip.trimEnd || clip.duration
    const splitTime = Math.max(clip.trimStart, Math.min(time, clipEnd))
    if (splitTime - clip.trimStart < 0.05 || clipEnd - splitTime < 0.05) {
      setNotice('El punto de división debe dejar al menos 0,05 segundos en cada segmento.')
      return
    }

    const rightId = crypto.randomUUID()
    const rightClip: MediaItem = {
      ...clip,
      id: rightId,
      url: URL.createObjectURL(clip.file),
      trimStart: splitTime,
      trimEnd: clipEnd,
    }
    const videoItems = media.filter((item) => item.kind === 'video')
    const clipIndex = videoItems.findIndex((item) => item.id === clipId)
    videoItems.splice(clipIndex, 1, { ...clip, trimEnd: splitTime }, rightClip)
    setMedia([...videoItems, ...media.filter((item) => item.kind === 'audio')])
    setCaptionSegments((segments) => segments.flatMap((caption) => {
      if (caption.mediaId !== clipId || caption.end <= splitTime) return [caption]
      if (caption.start >= splitTime) return [{ ...caption, mediaId: rightId }]
      return [
        { ...caption, end: splitTime },
        { ...caption, id: crypto.randomUUID(), mediaId: rightId, start: splitTime },
      ]
    }))
    setIsBladeToolActive(false)
    setNotice('Clip dividido en dos segmentos.')
  }

  const splitActiveClip = () => {
    if (!activeVideo) return
    splitClipAt(activeVideo.id, currentTime)
  }

  const cutAtTimelinePosition = (event: ReactMouseEvent<HTMLDivElement>, clip: MediaItem) => {
    if (!isBladeToolActive) {
      setActiveId(clip.id)
      return
    }
    event.preventDefault()
    event.stopPropagation()
    const bounds = event.currentTarget.getBoundingClientRect()
    const progress = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width))
    const clipEnd = clip.trimEnd || clip.duration
    const sourceTime = clip.reverse
      ? clipEnd - progress * (clipEnd - clip.trimStart)
      : clip.trimStart + progress * (clipEnd - clip.trimStart)
    setActiveId(clip.id)
    splitClipAt(clip.id, sourceTime)
  }

  const removeMedia = (id: string) => {
    const item = media.find((entry) => entry.id === id)
    if (!item) return
    URL.revokeObjectURL(item.url)
    setMedia((items) => items.filter((entry) => entry.id !== id))
    setCaptionSegments((segments) => segments.filter((caption) => caption.mediaId !== id))
    if (id === activeId) {
      const next = videos.find((entry) => entry.id !== id)
      setActiveId(next?.id ?? '')
    }
  }

  const moveClip = (fromId: string, toId: string) => {
    if (!fromId || fromId === toId) return
    setMedia((items) => {
      const videoItems = items.filter((item) => item.kind === 'video')
      const otherItems = items.filter((item) => item.kind !== 'video')
      const fromIndex = videoItems.findIndex((item) => item.id === fromId)
      const toIndex = videoItems.findIndex((item) => item.id === toId)
      if (fromIndex < 0 || toIndex < 0) return items
      const [moved] = videoItems.splice(fromIndex, 1)
      videoItems.splice(toIndex, 0, moved)
      return [...videoItems, ...otherItems]
    })
  }

  const updateCaption = (id: string, updates: Partial<Pick<CaptionSegment, 'start' | 'end' | 'text'>>) => {
    const duration = activeVideo?.duration ?? 0
    setCaptionSegments((segments) => segments.map((caption) => {
      if (caption.id !== id) return caption
      const start = updates.start === undefined
        ? caption.start
        : Math.max(0, Math.min(updates.start, caption.end - 0.01))
      const end = updates.end === undefined
        ? caption.end
        : Math.min(duration, Math.max(updates.end, start + 0.01))
      return {
        ...caption,
        ...updates,
        start,
        end,
        text: updates.text === undefined ? caption.text : updates.text.slice(0, 2000),
      }
    }).sort((a, b) => a.start - b.start))
  }

  const addCaption = () => {
    if (!activeVideo) return
    if (captionSegments.length >= 5000) {
      setNotice('El proyecto alcanzó el límite de 5000 segmentos de subtítulo.')
      return
    }
    const duration = activeVideo.duration
    const start = Math.min(Math.max(currentTime, 0), Math.max(0, duration - 0.1))
    const end = Math.min(duration, start + 2)
    if (end <= start) {
      setNotice('El video necesita tener una duración válida para añadir subtítulos.')
      return
    }
    setCaptionSegments((segments) => [
      ...segments,
      { id: crypto.randomUUID(), mediaId: activeVideo.id, start, end, text: '' },
    ].sort((a, b) => a.start - b.start))
  }

  const transcribeVideo = async () => {
    if (!activeVideo || isTranscribing) return
    const video = activeVideo
    if (video.file.size > 512 * 1024 * 1024) {
      setNotice('El archivo supera el límite de 512 MB para transcripción.')
      return
    }
    if (captionSegments.some((caption) => caption.mediaId === video.id)
      && !window.confirm('La transcripción nueva reemplazará los subtítulos de este clip. ¿Continuar?')) {
      return
    }

    setIsTranscribing(true)
    setNotice('Enviando el clip al servidor para transcripción…')
    try {
      const formData = new FormData()
      formData.append('file', video.file, video.file.name)
      formData.append('language', transcriptionLanguage)
      const accessToken = await getAccessTokenSilently({
        authorizationParams: {
          audience: import.meta.env.VITE_AUTH0_AUDIENCE,
          scope: 'transcribe:run',
        },
      })
      const response = await fetch('/api/transcribe', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: formData,
      })
      let payload: unknown
      try {
        payload = await response.json()
      } catch {
        throw new Error(response.ok
          ? 'El servidor devolvió una respuesta inválida.'
          : `El servicio de transcripción respondió con el error ${response.status}.`)
      }
      if (!response.ok) {
        const detail = payload && typeof payload === 'object' && 'detail' in payload
          && typeof payload.detail === 'string'
          ? payload.detail
          : `El servicio de transcripción respondió con el error ${response.status}.`
        throw new Error(detail)
      }
      if (
        !payload ||
        typeof payload !== 'object' ||
        !('segments' in payload) ||
        !Array.isArray(payload.segments)
      ) {
        throw new Error('El servidor devolvió una transcripción con formato inválido.')
      }
      const generated = payload.segments.flatMap((item): CaptionSegment[] => {
        if (!item || typeof item !== 'object') return []
        const segment = item as { start?: unknown; end?: unknown; text?: unknown }
        if (
          typeof segment.start !== 'number' ||
          !Number.isFinite(segment.start) ||
          typeof segment.end !== 'number' ||
          !Number.isFinite(segment.end) ||
          segment.end <= segment.start ||
          typeof segment.text !== 'string'
        ) return []
        const start = Math.max(0, Math.min(segment.start, video.duration))
        const end = Math.max(start, Math.min(segment.end, video.duration))
        if (end <= start || !segment.text.trim()) return []
        return [{
          id: crypto.randomUUID(),
          mediaId: video.id,
          start,
          end,
          text: segment.text.trim().slice(0, 2000),
        }]
      })
      if (generated.length === 0) {
        setNotice('No se detectó voz en el clip para crear subtítulos.')
        return
      }
      if (!mediaRef.current.some((item) => item.id === video.id)) {
        setNotice('El clip se quitó de la biblioteca antes de completar la transcripción.')
        return
      }
      setCaptionSegments((segments) => [
        ...segments.filter((caption) => caption.mediaId !== video.id),
        ...generated,
      ].sort((a, b) => a.start - b.start))
      setNotice(`Se generaron ${generated.length} subtítulos. Puedes editarlos en la lista.`)
    } catch (error) {
      setNotice(error instanceof Error
        ? `No se pudo transcribir el clip: ${error.message}`
        : 'No se pudo transcribir el clip.')
    } finally {
      setIsTranscribing(false)
    }
  }

  const saveBlobForUser = (
    blob: Blob,
    filename: string,
    successMessage: string,
    onSaved?: () => void,
  ) => {
    try {
      void Promise.resolve(downloadBlob(blob, filename)).then((saved) => {
        if (saved) {
          onSaved?.()
          setNotice(successMessage)
        }
        else setNotice('No se guardó el archivo. Puedes intentarlo de nuevo.')
      }).catch((error: unknown) => {
        setNotice(error instanceof Error ? `No se pudo guardar el archivo: ${error.message}` : 'No se pudo guardar el archivo.')
      })
    } catch (error) {
      setNotice(error instanceof Error ? `No se pudo guardar el archivo: ${error.message}` : 'No se pudo guardar el archivo.')
    }
  }

  const savePendingExport = () => {
    if (!pendingExport) return
    saveBlobForUser(
      pendingExport.blob,
      pendingExport.filename,
      'Exportación WebM guardada.',
      () => setPendingExport(null),
    )
  }

  const exportClip = async () => {
    const video = videoRef.current
    if (!video || !activeVideo) return
    if (!HTMLCanvasElement.prototype.captureStream || !window.MediaRecorder) {
      setNotice('La exportación WebM no está disponible en este navegador.')
      return
    }
    if (video.readyState < 2 || !video.videoWidth) {
      setNotice('Espera a que el video termine de cargar antes de exportar.')
      return
    }
    const clipStart = activeVideo.trimStart
    const clipEnd = activeVideo.trimEnd || activeVideo.duration
    if (clipEnd <= clipStart) {
      setNotice('El final del recorte debe ser posterior al inicio.')
      return
    }

    setIsExporting(true)
    video.pause()
    setIsPlaying(false)
    const canvas = document.createElement('canvas')
    const outputSize = getExportDimensions(video.videoWidth, video.videoHeight, aspectRatio)
    canvas.width = outputSize.width
    canvas.height = outputSize.height
    const context = canvas.getContext('2d')
    if (!context) {
      setIsExporting(false)
      setNotice('No se pudo preparar el lienzo de exportación.')
      return
    }
    const stream = canvas.captureStream(30)
    if (!window.AudioContext) {
      stream.getTracks().forEach((track) => track.stop())
      setIsExporting(false)
      setNotice('La exportación con audio no está disponible en este navegador.')
      return
    }
    let audioOutput: MediaStreamAudioDestinationNode | undefined
    let audioGain: GainNode | undefined
    try {
      const audioContext = audioContextRef.current ?? new AudioContext()
      audioContextRef.current = audioContext
      audioOutput = audioContext.createMediaStreamDestination()
      audioGain = ensureVideoAudioGraph(video).gain
      audioGain.connect(audioOutput)
      await audioContext.resume()
    } catch {
      if (audioGain && audioOutput) audioGain.disconnect(audioOutput)
      stream.getTracks().forEach((track) => track.stop())
      setIsExporting(false)
      setNotice('No se pudo preparar el audio para la exportación.')
      return
    }
    if (!audioOutput || !audioGain) {
      stream.getTracks().forEach((track) => track.stop())
      setIsExporting(false)
      setNotice('No se pudo preparar el audio para la exportación.')
      return
    }
    audioOutput.stream.getAudioTracks().forEach((track) => stream.addTrack(track))
    const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
      .find((type) => MediaRecorder.isTypeSupported(type))
    if (!mimeType) {
      audioGain.disconnect(audioOutput)
      stream.getTracks().forEach((track) => track.stop())
      setIsExporting(false)
      setNotice('Este navegador no ofrece un formato WebM compatible.')
      return
    }
    const recorder = new MediaRecorder(stream, { mimeType })
    const chunks: BlobPart[] = []
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data)
    }
    recorder.onerror = () => {
      video.pause()
      video.onseeked = null
      if (audioGain && audioOutput) audioGain.disconnect(audioOutput)
      video.playbackRate = activeVideo.speed
      stream.getTracks().forEach((track) => track.stop())
      setIsExporting(false)
      setNotice('Ocurrió un error durante la exportación.')
    }
    recorder.onstop = () => {
      if (audioGain && audioOutput) audioGain.disconnect(audioOutput)
      video.playbackRate = activeVideo.speed
      if (!chunks.length) {
        stream.getTracks().forEach((track) => track.stop())
        setIsExporting(false)
        setNotice('La exportación terminó sin generar un archivo.')
        return
      }
      const blob = new Blob(chunks, { type: mimeType })
      const filename = `${activeVideo.file.name.replace(/\.[^.]+$/, '')}-editado.webm`
      if (Capacitor.isNativePlatform()) {
        setPendingExport({ blob, filename })
        setNotice('Exportación lista. Pulsa “Guardar archivo” para compartirla o guardarla.')
      } else {
        saveBlobForUser(blob, filename, 'Exportación WebM descargada.')
      }
      stream.getTracks().forEach((track) => track.stop())
      setIsExporting(false)
    }

    const drawFrame = () => {
      const finished = activeVideo.reverse
        ? video.currentTime <= clipStart
        : video.currentTime >= clipEnd || video.ended
      context.globalAlpha = getVideoOpacity(activeVideo, video.currentTime)
      context.filter = filter.css
      drawVideoFrame(context, video, canvas.width, canvas.height, activeVideo)
      context.globalAlpha = 1
      context.filter = 'none'
      audioGain.gain.setTargetAtTime(getAudioGain(activeVideo, video.currentTime), audioGain.context.currentTime, 0.015)
      if (finished) {
        video.pause()
        recorder.stop()
        return
      }
      if (overlayText.trim()) {
        const fontSize = Math.max(24, Math.round(canvas.width * 0.045))
        context.font = `700 ${fontSize}px system-ui, sans-serif`
        context.textAlign = 'center'
        context.textBaseline = 'bottom'
        context.lineWidth = Math.max(3, fontSize * 0.14)
        context.strokeStyle = 'rgba(0,0,0,.75)'
        context.fillStyle = '#fff'
        context.strokeText(overlayText, canvas.width / 2, canvas.height * 0.9)
        context.fillText(overlayText, canvas.width / 2, canvas.height * 0.9)
      }
      const frameCaption = captionSegments.find((caption) =>
        caption.mediaId === activeVideo.id &&
        video.currentTime >= caption.start &&
        video.currentTime < caption.end,
      )
      if (frameCaption?.text.trim()) {
        drawCaption(context, frameCaption.text, captionStyle, canvas.width, canvas.height)
      }
      if (activeVideo.reverse) {
        video.onseeked = () => requestAnimationFrame(drawFrame)
        video.currentTime = Math.max(clipStart, video.currentTime - activeVideo.speed / 30)
      } else {
        requestAnimationFrame(drawFrame)
      }
    }

    const beginRecording = async () => {
      video.onseeked = null
      try {
        video.playbackRate = activeVideo.speed
        if (activeVideo.reverse) {
          video.pause()
          requestAnimationFrame(drawFrame)
        } else {
          audioGain.gain.setTargetAtTime(getAudioGain(activeVideo, clipStart), audioGain.context.currentTime, 0.015)
          await video.play()
          requestAnimationFrame(drawFrame)
        }
      } catch {
        recorder.stop()
        setIsExporting(false)
        setNotice('No se pudo iniciar la exportación de este video.')
      }
    }
    recorder.start()
    const exportStart = activeVideo.reverse ? clipEnd : clipStart
    if (Math.abs(video.currentTime - exportStart) < 0.001) {
      void beginRecording()
    } else {
      video.onseeked = () => void beginRecording()
      video.currentTime = exportStart
    }
  }

  const exportBackup = () => {
    const snapshot: ProjectSnapshot = {
      schemaVersion: 6,
      id: 'default',
      name: projectName.trim() || 'Proyecto sin título',
      updatedAt: Date.now(),
      media: media.map(({ file: _file, url: _url, ...item }) => item),
      activeId: activeVideo?.id ?? '',
      overlayText,
      captionSegments,
      captionStyle,
      aspectRatio,
      filterName: filter.name,
    }
    const assets: ProjectAsset[] = media.map((item) => ({ id: item.id, blob: item.file }))
    try {
      const backup = createProjectBackup(snapshot, assets)
      const safeName = projectName.trim()
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
        .replace(/\s+/g, '-')
        .slice(0, 80)
      saveBlobForUser(
        backup,
        `${safeName || 'freecut-project'}.freecut`,
        'Copia de seguridad lista para guardar.',
      )
    } catch (error) {
      setNotice(error instanceof Error ? `No se pudo crear la copia: ${error.message}` : 'No se pudo crear la copia de seguridad.')
    }
  }

  const restoreBackup = async (file: File) => {
    if (!ownerId) {
      setNotice('No se pudo determinar tu identidad para restaurar el proyecto.')
      return
    }
    let restored
    try {
      restored = await readProjectBackup(file)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'No se pudo leer la copia de seguridad.')
      return
    }
    if (!window.confirm('Restaurar esta copia reemplazará el proyecto actual en este dispositivo. ¿Continuar?')) return

    const assetById = new Map(restored.assets.map((asset) => [asset.id, asset]))
    const restoredMedia: MediaItem[] = restored.snapshot.media.map((item) => {
      const asset = assetById.get(item.id)
      if (!asset) throw new Error(`Falta el archivo "${item.name}" en la copia.`)
      const mediaFile = new File([asset.blob], item.name, {
        type: item.type,
        lastModified: item.lastModified,
      })
      return { ...item, file: mediaFile, url: URL.createObjectURL(mediaFile) }
    })
    const snapshot = { ...restored.snapshot, updatedAt: Date.now() }
    const version = ++saveVersionRef.current
    setIsRestoringBackup(true)
    setSaveStatus('saving')
    try {
      const save = saveQueueRef.current
        .catch(() => undefined)
        .then(() => indexedDbProjectRepository.save(ownerId, snapshot, restored.assets, true))
      saveQueueRef.current = save
      await save
      videoRef.current?.pause()
      mediaRef.current.forEach((item) => URL.revokeObjectURL(item.url))
      mediaRef.current = restoredMedia
      setMedia(restoredMedia)
      setProjectName(snapshot.name)
      activeIdRef.current = snapshot.activeId
      setActiveId(snapshot.activeId)
      const selected = restoredMedia.find((item) => item.id === snapshot.activeId)
      setTrimStart(selected?.trimStart ?? 0)
      setTrimEnd(selected?.trimEnd ?? 0)
      setOverlayText(snapshot.overlayText)
      setCaptionSegments(snapshot.captionSegments)
      setCaptionStyle(snapshot.captionStyle)
      setAspectRatio(snapshot.aspectRatio)
      setFilter(filters.find((item) => item.name === snapshot.filterName) ?? filters[0])
      setActivePanel('media')
      setIsPlaying(false)
      setSaveStatus('saved')
      setNotice('Proyecto restaurado desde la copia de seguridad.')
    } catch (error) {
      restoredMedia.forEach((item) => URL.revokeObjectURL(item.url))
      setSaveStatus('error')
      setNotice(error instanceof Error ? `No se pudo restaurar la copia: ${error.message}` : 'No se pudo restaurar la copia.')
    } finally {
      if (version === saveVersionRef.current) setIsRestoringBackup(false)
    }
  }

  const importLegacyProject = async () => {
    if (!ownerId) {
      setNotice('No se pudo determinar tu identidad para importar el proyecto local.')
      return
    }
    try {
      const saved = await indexedDbProjectRepository.claimLegacyProject(ownerId)
      applyLoadedProject(saved)
      setLegacyProjectState('claimed')
      setStorageAvailable(true)
      setSaveStatus('saved')
      setNotice('Proyecto local importado a esta cuenta. Se conservó una copia sin asignar.')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'No se pudo importar el proyecto local.')
    }
  }

  const dismissLegacyProject = async () => {
    if (!ownerId) return
    try {
      await indexedDbProjectRepository.dismissLegacyProject(ownerId)
      setLegacyProjectState('dismissed')
    } catch (error) {
      setNotice(error instanceof Error ? `No se pudo guardar la decisión: ${error.message}` : 'No se pudo guardar la decisión.')
    }
  }

  const signOut = async () => {
    setIsLoggingOut(true)
    try {
      await logout({ logoutParams: { returnTo: `${window.location.origin}/` } })
    } catch (error) {
      setIsLoggingOut(false)
      setNotice(error instanceof Error ? `No se pudo cerrar la sesión: ${error.message}` : 'No se pudo cerrar la sesión.')
    }
  }

  const selectPanel = (panel: Panel) => setActivePanel(panel)

  if (!isReady) {
    return (
      <main className="app-shell loading-screen" aria-busy="true">
        <span className="spinner" />
        <p>Abriendo tu proyecto…</p>
      </main>
    )
  }
  if (isRestoringBackup) {
    return (
      <main className="app-shell loading-screen" aria-busy="true">
        <span className="spinner" />
        <p>Restaurando la copia…</p>
      </main>
    )
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#" aria-label="FreeCut inicio">
          <span className="brand-mark">f</span>
          <span>freecut</span>
        </a>
        <div className="project-name">
          <span className="project-dot" />
          <input
            className="project-title"
            aria-label="Nombre del proyecto"
            value={projectName}
            onChange={(event) => setProjectName(event.target.value)}
            maxLength={80}
          />
          <span className={`saved-label ${saveStatus}`} role="status">
            {saveStatus === 'loading' ? 'Cargando…' : saveStatus === 'saving' ? 'Guardando…' : saveStatus === 'error' ? 'Error al guardar' : 'Guardado'}
          </span>
        </div>
        <div className="top-actions">
          <span className="account-label" title={user?.email}>{user?.name || user?.email || 'Cuenta'}</span>
          <button className="logout-button" type="button" onClick={() => void signOut()} disabled={isLoggingOut || saveStatus === 'saving' || isRestoringBackup}>
            {isLoggingOut ? 'Cerrando…' : 'Cerrar sesión'}
          </button>
          <button className="backup-button" onClick={exportBackup}>
            ↓ Copia
          </button>
          <button className="restore-button" disabled={!storageAvailable} onClick={() => backupInputRef.current?.click()}>
            ↑ Restaurar
          </button>
          <input
            ref={backupInputRef}
            className="visually-hidden"
            type="file"
            accept=".freecut,application/vnd.freecut.project"
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) void restoreBackup(file)
            }}
          />
          <button className="export-button" onClick={pendingExport ? savePendingExport : exportClip} disabled={(!activeVideo && !pendingExport) || isExporting}>
            {isExporting ? <span className="spinner" /> : <span aria-hidden="true">{pendingExport ? '↑' : '↓'}</span>}
            {isExporting ? 'Exportando…' : pendingExport ? 'Guardar archivo' : 'Exportar'}
          </button>
        </div>
      </header>

      <div className="workspace">
        <aside className="tool-rail" aria-label="Herramientas">
          {([
            ['media', '▧', 'Medios'],
            ['text', 'T', 'Texto'],
            ['audio', '♫', 'Audio'],
            ['effects', '✦', 'Efectos'],
            ['captions', '▤', 'Subtítulos'],
            ['aspect', '▣', 'Relación de aspecto'],
          ] as [Panel, string, string][]).map(([panel, icon, label]) => (
            <button
              key={panel}
              className={`tool-button ${activePanel === panel ? 'active' : ''}`}
              onClick={() => selectPanel(panel)}
              aria-pressed={activePanel === panel}
            >
              <span className="tool-icon">{icon}</span>
              <span>{label}</span>
            </button>
          ))}
          <div className="rail-bottom"><span className="avatar">F</span></div>
        </aside>

        <aside className="asset-panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">{activePanel === 'media' ? 'BIBLIOTECA' : 'HERRAMIENTAS'}</span>
              <h1>{activePanel === 'media' ? 'Tus medios' : ({
                text: 'Texto',
                audio: 'Audio',
                effects: 'Efectos',
                captions: 'Subtítulos',
                aspect: 'Relación de aspecto',
                media: 'Tus medios',
              }[activePanel])}</h1>
            </div>
            {activePanel === 'media' && <span className="asset-count">{media.length}</span>}
          </div>

          {activePanel === 'media' && (
            <>
              <button className="import-button" onClick={() => fileInputRef.current?.click()}>
                <span>＋</span> Importar medios
              </button>
              <input
                ref={fileInputRef}
                className="visually-hidden"
                type="file"
                accept="video/*,audio/*"
                multiple
                onChange={(event) => {
                  if (event.target.files) addFiles(event.target.files)
                  event.target.value = ''
                }}
              />
              <div
                className="drop-zone"
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault()
                  addFiles(event.dataTransfer.files)
                }}
              >
                <span className="upload-icon">↑</span>
                <strong>Arrastra tus archivos aquí</strong>
                <span>Video o audio desde tu dispositivo</span>
              </div>
              <div className="library-label"><span>ARCHIVOS</span><button aria-label="Opciones de archivos">•••</button></div>
              <div className="media-list">
                {media.length === 0 ? (
                  <div className="empty-library">
                    <span>▧</span>
                    <p>Tu biblioteca está vacía</p>
                    <small>Importa clips para empezar a editar</small>
                  </div>
                ) : media.map((item) => (
                  <div
                    className={`media-item ${item.id === activeId ? 'selected' : ''}`}
                    key={item.id}
                    role="button"
                    tabIndex={item.kind === 'video' ? 0 : -1}
                    onClick={() => item.kind === 'video' && setActiveId(item.id)}
                    onKeyDown={(event) => {
                      if ((event.key === 'Enter' || event.key === ' ') && item.kind === 'video') setActiveId(item.id)
                    }}
                  >
                    <span className={`media-thumb ${item.kind}`}>
                      {item.kind === 'video' ? '▶' : '♫'}
                      {item.kind === 'video' && (
                        <video
                          src={item.url}
                          muted
                          preload="metadata"
                          onLoadedMetadata={(event) => updateDuration(item.id, event.currentTarget.duration)}
                        />
                      )}
                    </span>
                    <span className="media-info">
                      <strong>{item.file.name}</strong>
                      <small>{item.kind === 'video' ? 'Video' : 'Audio'}{item.duration ? ` · ${formatTime(item.duration)}` : ''}</small>
                    </span>
                    <button
                      type="button"
                      className="remove-media"
                      aria-label={`Eliminar ${item.file.name}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        removeMedia(item.id)
                      }}
                    >×</button>
                  </div>
                ))}
              </div>
            </>
          )}

          {activePanel === 'text' && (
            <div className="settings-content">
              <p className="panel-description">Añade un título visible sobre el video.</p>
              <label className="field-label" htmlFor="overlayText">Contenido</label>
              <textarea id="overlayText" value={overlayText} onChange={(event) => setOverlayText(event.target.value)} placeholder="Escribe tu título…" rows={3} />
              <button className="secondary-button" onClick={() => setOverlayText('Tu título aquí')}>＋ Añadir título</button>
              <div className="hint-card"><span>✦</span><p>El texto se incluirá en la exportación del clip seleccionado.</p></div>
            </div>
          )}

          {activePanel === 'audio' && (
            <div className="settings-content">
              <p className="panel-description">Importa audio desde tu dispositivo para añadirlo a la biblioteca.</p>
              <button className="import-button" onClick={() => fileInputRef.current?.click()}><span>＋</span> Importar audio</button>
              {activeAudio ? (
                <div className="audio-preview">
                  <strong>{activeAudio.file.name}</strong>
                  <audio controls src={activeAudio.url} onLoadedMetadata={(event) => updateDuration(activeAudio.id, event.currentTarget.duration)} />
                </div>
              ) : <div className="empty-library compact"><span>♫</span><p>Aún no hay pistas de audio</p></div>}
              <div className="hint-card"><span>i</span><p>Las pistas se pueden previsualizar. La mezcla de audio en la exportación llegará en una siguiente etapa.</p></div>
            </div>
          )}

          {activePanel === 'effects' && (
            <div className="settings-content">
              <p className="panel-description">Elige un filtro para el clip seleccionado.</p>
              <div className="filter-grid">
                {filters.map((option) => (
                  <button
                    className={`filter-option ${filter.name === option.name ? 'selected' : ''}`}
                    key={option.name}
                    onClick={() => setFilter(option)}
                  >
                    <span className="filter-swatch" style={{ filter: option.css }}>Aa</span>
                    <span>{option.name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {activePanel === 'captions' && (
            <div className="settings-content">
              <p className="panel-description">Genera subtítulos para el clip seleccionado y corrige el texto o sus tiempos.</p>
              <span className="field-label">Estilo de subtítulos</span>
              <div className="caption-style-grid">
                {captionStyles.map((style) => (
                  <button
                    className={`caption-style-option ${captionStyle === style.id ? 'selected' : ''}`}
                    key={style.id}
                    type="button"
                    aria-pressed={captionStyle === style.id}
                    onClick={() => setCaptionStyle(style.id)}
                  >
                    <span className={`caption-style-sample caption-style-${style.id}`}>{style.sample}</span>
                    <span>{style.name}</span>
                  </button>
                ))}
              </div>
              <label className="field-label" htmlFor="transcriptionLanguage">Idioma hablado</label>
              <select
                id="transcriptionLanguage"
                className="caption-language"
                value={transcriptionLanguage}
                onChange={(event) => setTranscriptionLanguage(event.target.value)}
                disabled={isTranscribing}
              >
                <option value="es">Español</option>
                <option value="en">Inglés</option>
                <option value="auto">Detectar automáticamente</option>
              </select>
              <button
                className="import-button caption-generate"
                onClick={() => void transcribeVideo()}
                disabled={!activeVideo || activeVideo.duration <= 0 || isTranscribing || Capacitor.isNativePlatform()}
              >
                {isTranscribing ? <><span className="spinner" /> Transcribiendo…</> : '✦ Generar subtítulos'}
              </button>
              {Capacitor.isNativePlatform() && <p className="caption-progress">La transcripción está disponible en la beta web; el shell nativo aún no tiene conexión autenticada al servicio.</p>}
              {isTranscribing && <p className="caption-progress" role="status">El primer uso puede tardar mientras se carga el modelo. Mantén esta página abierta.</p>}
              <div className="hint-card warning"><span>i</span><p>El video se envía al servidor FreeCut para transcribirlo. Se procesa allí y el archivo temporal se elimina al terminar; no se usa un proveedor externo. Límite: 512 MB.</p></div>
              <div className="caption-list-heading">
                <strong>Segmentos</strong>
                <span>{activeCaptions.length}</span>
              </div>
              <button className="secondary-button caption-add" onClick={addCaption} disabled={!activeVideo || isTranscribing || captionSegments.length >= 5000}>
                ＋ Añadir segmento manual
              </button>
              {activeCaptions.length === 0 ? (
                <div className="empty-library compact"><span>▤</span><p>Aún no hay segmentos</p></div>
              ) : (
                <div className="caption-list">
                  {activeCaptions.map((caption, index) => (
                    <fieldset className="caption-segment" key={caption.id}>
                      <legend>Segmento {index + 1}</legend>
                      <label className="field-label" htmlFor={`caption-text-${caption.id}`}>Texto</label>
                      <textarea
                        id={`caption-text-${caption.id}`}
                        value={caption.text}
                        maxLength={2000}
                        rows={2}
                        onChange={(event) => updateCaption(caption.id, { text: event.target.value })}
                      />
                      <div className="caption-time-fields">
                        <label>
                          <span>Desde (s)</span>
                          <input
                            type="number"
                            min="0"
                            max={activeVideo?.duration ?? 0}
                            step="0.1"
                            value={caption.start}
                            onChange={(event) => updateCaption(caption.id, { start: Number(event.target.value) })}
                          />
                        </label>
                        <label>
                          <span>Hasta (s)</span>
                          <input
                            type="number"
                            min="0"
                            max={activeVideo?.duration ?? 0}
                            step="0.1"
                            value={caption.end}
                            onChange={(event) => updateCaption(caption.id, { end: Number(event.target.value) })}
                          />
                        </label>
                      </div>
                      <div className="caption-segment-actions">
                        <button type="button" onClick={() => seek(caption.start)}>Ir al inicio</button>
                        <button
                          type="button"
                          className="caption-delete"
                          onClick={() => setCaptionSegments((segments) => segments.filter((item) => item.id !== caption.id))}
                        >
                          Eliminar
                        </button>
                      </div>
                    </fieldset>
                  ))}
                </div>
              )}
            </div>
          )}

          {activePanel === 'aspect' && (
            <div className="settings-content">
              <p className="panel-description">Elige el formato del lienzo. El encuadre se adapta en la vista previa y en la exportación.</p>
              <div className="aspect-ratio-grid" role="group" aria-label="Formatos de video">
                {aspectRatios.map((option) => (
                  <button
                    className={`aspect-ratio-option ${aspectRatio === option.id ? 'selected' : ''}`}
                    key={option.id}
                    type="button"
                    aria-pressed={aspectRatio === option.id}
                    onClick={() => setAspectRatio(option.id)}
                  >
                    <span
                      className="aspect-ratio-icon"
                      style={{
                        aspectRatio: option.value ? String(option.value) : String(previewAspectRatio),
                      }}
                    />
                    <span>{option.name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </aside>

        <section className="editor-area">
          <div className="preview-toolbar">
            <div className="preview-label"><span className="live-dot" /> VISTA PREVIA <span className="divider">/</span> {activeVideo?.file.name ?? 'Sin clip seleccionado'}</div>
            <span className="preview-aspect-ratio">{aspectRatios.find((item) => item.id === aspectRatio)?.name ?? 'Original'}</span>
          </div>

          <div className="preview-stage" ref={previewStageRef}>
            {activeVideo ? (
              <div
                className="video-frame"
                onClick={(event) => {
                  if (event.target === videoRef.current) setIsTransformSelected(true)
                }}
                onPointerMove={(event) => {
                  resizeTransform(event)
                  moveTransform(event)
                }}
                onPointerUp={endTransformResize}
                onPointerCancel={endTransformResize}
                style={{
                  aspectRatio: String(previewAspectRatio),
                  width: previewFrameWidth ? `${previewFrameWidth}px` : undefined,
                  height: previewFrameHeight ? `${previewFrameHeight}px` : undefined,
                }}
              >
                <video
                  key={activeVideo.id}
                  ref={videoRef}
                  src={activeVideo.url}
                  onLoadedMetadata={(event) => {
                    updateDuration(activeVideo.id, event.currentTarget.duration)
                    setVideoDimensions({
                      width: event.currentTarget.videoWidth,
                      height: event.currentTarget.videoHeight,
                    })
                    const pendingSeek = pendingTimelineSeekRef.current
                    if (pendingSeek?.id === activeVideo.id) {
                      event.currentTarget.currentTime = pendingSeek.time
                      setCurrentTime(pendingSeek.time)
                      pendingTimelineSeekRef.current = null
                    }
                    measurePreviewStage()
                  }}
                  onTimeUpdate={handleTimeUpdate}
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => {
                    if (reverseTimerRef.current === null) setIsPlaying(false)
                  }}
                  style={{
                    filter: filter.css,
                    opacity: getVideoOpacity(activeVideo, currentTime),
                    width: transformedBounds ? `${transformedBounds.base.width}px` : undefined,
                    height: transformedBounds ? `${transformedBounds.base.height}px` : undefined,
                    left: activeTransform ? `${50 + activeTransform.offsetX * 100}%` : '50%',
                    top: activeTransform ? `${50 + activeTransform.offsetY * 100}%` : '50%',
                    transform: activeTransform
                      ? `translate(-50%, -50%) rotate(${activeTransform.rotation}deg) scaleX(${activeTransform.scaleX * (activeTransform.flipHorizontal ? -1 : 1)}) scaleY(${activeTransform.scaleY * (activeTransform.flipVertical ? -1 : 1)})`
                      : undefined,
                  }}
                  onPointerDown={startTransformMove}
                  playsInline
                />
                {isTransformSelected && transformedBounds && (
                  <div
                    className="transform-selection"
                    style={{
                      left: `${transformedBounds.left}px`,
                      top: `${transformedBounds.top}px`,
                      width: `${transformedBounds.width}px`,
                      height: `${transformedBounds.height}px`,
                    }}
                  >
                    {([
                      ['nw', 0, 0],
                      ['n', 50, 0],
                      ['ne', 100, 0],
                      ['e', 100, 50],
                      ['se', 100, 100],
                      ['s', 50, 100],
                      ['sw', 0, 100],
                      ['w', 0, 50],
                    ] as [TransformHandle, number, number][]).map(([handle, left, top]) => (
                      <button
                        key={handle}
                        type="button"
                        className={`transform-handle transform-handle-${handle}`}
                        aria-label={handle.length === 2 ? `Escalar desde vértice ${handle}` : `Estirar desde arista ${handle}`}
                        style={{
                          left: `${Math.max(5, Math.min(previewFrameWidth - 5, transformedBounds.left + transformedBounds.width * left / 100)) - transformedBounds.left}px`,
                          top: `${Math.max(5, Math.min(previewFrameHeight - 5, transformedBounds.top + transformedBounds.height * top / 100)) - transformedBounds.top}px`,
                        }}
                        onPointerDown={(event) => startTransformResize(event, handle)}
                      />
                    ))}
                  </div>
                )}
                {(overlayText || previewCaption?.text) && (
                  <div className="video-overlay">
                    {overlayText && <strong>{overlayText}</strong>}
                    {previewCaption?.text && (
                      <span className={`caption-style-${captionStyle}`}>
                        {getCaptionParts(previewCaption.text, captionStyle).map((part, index) => (
                          <b className={part.highlighted ? 'caption-highlight' : undefined} key={index}>{part.text}</b>
                        ))}
                      </span>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="preview-empty">
                <span className="preview-empty-icon">▶</span>
                <strong>Tu historia empieza aquí</strong>
                <p>Importa un video para verlo en la vista previa</p>
                <button className="import-button" onClick={() => fileInputRef.current?.click()}>＋ Importar video</button>
              </div>
            )}
          </div>

          <div className="transport">
            <div className="timecode"><strong>{formatTime(currentTime)}</strong><span> / {formatTime(activeVideo?.duration ?? 0)}</span></div>
            <div className="transport-controls">
              <button aria-label="Ir al inicio del recorte" onClick={() => seek(activeVideo?.trimStart ?? trimStart)}>◀|</button>
              <button className="play-button" aria-label={isPlaying ? 'Pausar' : 'Reproducir'} onClick={togglePlayback} disabled={!activeVideo}>
                {isPlaying ? 'Ⅱ' : '▶'}
              </button>
              <button aria-label="Ir al final del recorte" onClick={() => seek(activeVideo?.trimEnd ?? trimEnd)}>|▶</button>
            </div>
            <button className="fullscreen-button" aria-label="Vista de pantalla completa" onClick={() => document.querySelector('.video-frame')?.requestFullscreen?.()}>⛶</button>
          </div>

          <section className={`timeline ${isBladeToolActive ? 'blade-active' : ''}`}>
            <div className="timeline-topbar">
              <div className="timeline-title"><span>LINEA DE TIEMPO</span><span className="clip-count">{videos.length} clips</span></div>
              <div className="timeline-actions">
                <button onClick={() => setNotice('Deshacer estará disponible al añadir historial de edición.')}>↶</button>
                <button onClick={() => setNotice('Rehacer estará disponible al añadir historial de edición.')}>↷</button>
                <span className="timeline-separator" />
                <button onClick={() => setNotice('Zoom de línea de tiempo próximamente.')}>−</button>
                <span className="zoom-track"><span /></span>
                <button onClick={() => setNotice('Zoom de línea de tiempo próximamente.')}>＋</button>
              </div>
            </div>
            <div
              className="timeline-ruler"
              onPointerDown={beginTimelineScrub}
              onPointerMove={moveTimelineScrub}
              onPointerUp={endTimelineScrub}
              onPointerCancel={endTimelineScrub}
              title="Pulsa o arrastra para mover la posición de reproducción"
            >
              <span>00:00</span>
              <span>{formatTime(totalDuration / 4)}</span>
              <span>{formatTime(totalDuration / 2)}</span>
              <span>{formatTime(totalDuration * .75)}</span>
              <span>{formatTime(totalDuration)}</span>
            </div>
            <div className="timeline-track video-track">
              <div className="track-label"><span className="track-icon">▧</span><span>Video</span></div>
              <div className="track-content" ref={timelineTrackRef}>
                {videos.length === 0 ? (
                  <button className="track-empty" onClick={() => fileInputRef.current?.click()}>＋ Arrastra clips aquí o importa medios</button>
                ) : videos.map((item, index) => (
                  <div
                    key={item.id}
                    className={`timeline-clip ${item.id === activeId ? 'selected' : ''}`}
                    style={{ flex: `${Math.max(item.trimEnd - item.trimStart, 1) / item.speed} 1 0%` }}
                    draggable
                    onDragStart={() => setDragId(item.id)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => {
                      moveClip(dragId, item.id)
                      setDragId('')
                    }}
                    onClick={(event) => cutAtTimelinePosition(event, item)}
                    aria-label={`${isBladeToolActive ? 'Cortar' : 'Seleccionar'} ${item.file.name}`}
                    title={`${item.file.name} · clip ${index + 1}`}
                  >
                    <span className="clip-filmstrip"><span>▶</span><strong>{item.file.name}</strong>{item.duration > 0 && <small>{formatTime(item.duration)}</small>}</span>
                  </div>
                ))}
                {activeVideo && (
                  <div className="playhead" style={{ left: `${totalDuration ? (timelineTime / totalDuration) * 100 : 0}%` }}>
                    <button
                      type="button"
                      className="playhead-handle"
                      aria-label={`Posición de reproducción: ${formatTime(timelineTime)}`}
                      title="Arrastra para mover la posición de reproducción"
                      onPointerDown={beginTimelineScrub}
                      onPointerMove={moveTimelineScrub}
                      onPointerUp={endTimelineScrub}
                      onPointerCancel={endTimelineScrub}
                      onClick={(event) => event.stopPropagation()}
                    />
                  </div>
                )}
              </div>
            </div>
            <div className="timeline-track text-track">
              <div className="track-label"><span className="track-icon">T</span><span>Texto</span></div>
              <div className="track-content">
                {overlayText ? <button className="overlay-clip" onClick={() => selectPanel('text')}>{overlayText}</button> : <button className="track-empty subtle" onClick={() => selectPanel('text')}>＋ Añade texto</button>}
              </div>
            </div>
            <div className="timeline-track audio-track">
              <div className="track-label"><span className="track-icon">♫</span><span>Audio</span></div>
              <div className="track-content">
                {activeAudio ? <button className="audio-clip" onClick={() => selectPanel('audio')}>♫ {activeAudio.file.name}</button> : <button className="track-empty subtle" onClick={() => selectPanel('audio')}>＋ Añade audio</button>}
              </div>
            </div>
            <div className="timeline-edit-tools" role="toolbar" aria-label="Edición del clip seleccionado">
              <button
                type="button"
                aria-label={isBladeToolActive ? 'Desactivar cortar' : 'Cortar en un punto de la línea de tiempo'}
                aria-pressed={isBladeToolActive}
                title="Cortar: elige un punto del clip"
                onClick={() => setIsBladeToolActive((active) => !active)}
              >✂</button>
              <button type="button" aria-label="Recortar clip" title="Recortar: ajustar inicio y final" onClick={() => document.getElementById('trim-start')?.focus()}>◫</button>
              <button type="button" aria-label="Dividir en la posición actual" title="Dividir en el cabezal" onClick={splitActiveClip} disabled={!activeVideo}>∥</button>
              <button type="button" aria-label="Borrar clip seleccionado" title="Borrar clip" onClick={() => activeVideo && removeMedia(activeVideo.id)} disabled={!activeVideo}>×</button>
              <button type="button" aria-label="Ajustar volumen" title="Volumen del audio" onClick={() => document.getElementById('clip-volume')?.focus()} disabled={!activeVideo}>♫</button>
              <button
                type="button"
                aria-label="Alternar fade-in de audio"
                aria-pressed={Boolean(activeVideo?.audioFadeIn)}
                title="Fade-in de audio"
                onClick={() => activeVideo && updateClipEffects({ audioFadeIn: activeVideo.audioFadeIn ? 0 : 1 })}
                disabled={!activeVideo}
              >↗</button>
              <button
                type="button"
                aria-label="Alternar fade-out de audio"
                aria-pressed={Boolean(activeVideo?.audioFadeOut)}
                title="Fade-out de audio"
                onClick={() => activeVideo && updateClipEffects({ audioFadeOut: activeVideo.audioFadeOut ? 0 : 1 })}
                disabled={!activeVideo}
              >↘</button>
              <button
                type="button"
                aria-label="Alternar fade-in de video"
                aria-pressed={Boolean(activeVideo?.videoFadeIn)}
                title="Fade-in de video"
                onClick={() => activeVideo && updateClipEffects({ videoFadeIn: activeVideo.videoFadeIn ? 0 : 1 })}
                disabled={!activeVideo}
              >▴</button>
              <button
                type="button"
                aria-label="Alternar fade-out de video"
                aria-pressed={Boolean(activeVideo?.videoFadeOut)}
                title="Fade-out de video"
                onClick={() => activeVideo && updateClipEffects({ videoFadeOut: activeVideo.videoFadeOut ? 0 : 1 })}
                disabled={!activeVideo}
              >▾</button>
              <button type="button" aria-label="Ajustar velocidad" title="Velocidad del clip" onClick={() => document.getElementById('clip-speed')?.focus()} disabled={!activeVideo}>1×</button>
              <button
                type="button"
                aria-label="Alternar reproducción inversa"
                aria-pressed={Boolean(activeVideo?.reverse)}
                title="Avance inverso"
                onClick={() => activeVideo && updateClipEffects({ reverse: !activeVideo.reverse })}
                disabled={!activeVideo}
              >↶</button>
            </div>
          </section>
        </section>

        <aside className="inspector">
          <div className="inspector-heading"><span className="eyebrow">AJUSTES</span><h2>{activeVideo ? 'Clip seleccionado' : 'Propiedades'}</h2></div>
          {activeVideo ? (
            <>
              <div className="inspector-file"><span className="file-icon">▶</span><span><strong>{activeVideo.file.name}</strong><small>Video · {formatTime(activeVideo.duration)}</small></span></div>
              <div className="inspector-section">
                <div className="section-title">Recortar <button onClick={() => { updateTrimStart(0); updateTrimEnd(activeVideo.duration) }}>Restablecer</button></div>
                <label className="field-label" htmlFor="trim-start">Inicio</label>
                <div className="time-input"><input id="trim-start" type="number" min="0" max={Math.max(0, activeVideo.trimEnd - .1)} step=".1" value={activeVideo.trimStart} onChange={(event) => updateTrimStart(Number(event.target.value))} /><span>seg</span></div>
                <label className="field-label" htmlFor="trim-end">Final</label>
                <div className="time-input"><input id="trim-end" type="number" min={activeVideo.trimStart + .1} max={activeVideo.duration} step=".1" value={activeVideo.trimEnd || activeVideo.duration} onChange={(event) => updateTrimEnd(Number(event.target.value))} /><span>seg</span></div>
              </div>
              <div className="inspector-section">
                <div className="section-title">Audio del clip</div>
                <label className="field-label" htmlFor="clip-volume">Volumen · {Math.round(activeVideo.volume * 100)}%</label>
                <input id="clip-volume" className="range-control" type="range" min="0" max="2" step="0.05" value={activeVideo.volume} onChange={(event) => updateClipEffects({ volume: Number(event.target.value) })} />
                <label className="field-label" htmlFor="audio-fade-in">Fade-in · {activeVideo.audioFadeIn.toFixed(1)} s</label>
                <input id="audio-fade-in" className="range-control" type="range" min="0" max="10" step="0.1" value={activeVideo.audioFadeIn} onChange={(event) => updateClipEffects({ audioFadeIn: Number(event.target.value) })} />
                <label className="field-label" htmlFor="audio-fade-out">Fade-out · {activeVideo.audioFadeOut.toFixed(1)} s</label>
                <input id="audio-fade-out" className="range-control" type="range" min="0" max="10" step="0.1" value={activeVideo.audioFadeOut} onChange={(event) => updateClipEffects({ audioFadeOut: Number(event.target.value) })} />
              </div>
              <div className="inspector-section">
                <div className="section-title">Video del clip</div>
                <label className="field-label" htmlFor="video-fade-in">Fade-in · {activeVideo.videoFadeIn.toFixed(1)} s</label>
                <input id="video-fade-in" className="range-control" type="range" min="0" max="10" step="0.1" value={activeVideo.videoFadeIn} onChange={(event) => updateClipEffects({ videoFadeIn: Number(event.target.value) })} />
                <label className="field-label" htmlFor="video-fade-out">Fade-out · {activeVideo.videoFadeOut.toFixed(1)} s</label>
                <input id="video-fade-out" className="range-control" type="range" min="0" max="10" step="0.1" value={activeVideo.videoFadeOut} onChange={(event) => updateClipEffects({ videoFadeOut: Number(event.target.value) })} />
                <label className="field-label" htmlFor="clip-speed">Velocidad · {activeVideo.speed.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}×</label>
                <select
                  id="clip-speed"
                  value={activeVideo.speed}
                  onChange={(event) => updateClipEffects({ speed: Number(event.target.value) })}
                >
                  {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].map((speed) => (
                    <option key={speed} value={speed}>{speed}×</option>
                  ))}
                </select>
                <label className="reverse-control">
                  <input type="checkbox" checked={activeVideo.reverse} onChange={(event) => updateClipEffects({ reverse: event.target.checked })} />
                  Avance inverso
                </label>
                <small className="control-hint">En avance inverso se silencia el audio original del clip.</small>
              </div>
              <div className="inspector-section">
                <div className="section-title">
                  Transformar
                  <button type="button" onClick={resetClipTransform}>Restablecer transformación</button>
                </div>
                <div className="transform-actions">
                  <button type="button" aria-label="Rotar en sentido horario" onClick={() => rotateClip(1)}>↻ <span>CW</span></button>
                  <button type="button" aria-label="Rotar en sentido antihorario" onClick={() => rotateClip(-1)}>↺ <span>CCW</span></button>
                  <button
                    type="button"
                    aria-pressed={activeVideo.flipHorizontal}
                    onClick={() => updateClipTransform({ flipHorizontal: !activeVideo.flipHorizontal })}
                  >↔ <span>Espejo H</span></button>
                  <button
                    type="button"
                    aria-pressed={activeVideo.flipVertical}
                    onClick={() => updateClipTransform({ flipVertical: !activeVideo.flipVertical })}
                  >↕ <span>Espejo V</span></button>
                </div>
              </div>
              <div className="inspector-section">
                <div className="section-title">Filtro</div>
                <select value={filter.name} onChange={(event) => setFilter(filters.find((item) => item.name === event.target.value) ?? filters[0])}>
                  {filters.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
                </select>
              </div>
            </>
          ) : (
            <div className="inspector-empty"><span>⌁</span><p>Selecciona un clip para ajustar sus propiedades.</p></div>
          )}
          <div className="inspector-footer"><span className="keyboard-icon">⌘</span><span>Atajos de teclado</span><span className="footer-arrow">↗</span></div>
        </aside>
      </div>
      {(legacyProjectState === 'available' || legacyProjectState === 'owned') && (
        <div className="legacy-project-backdrop">
          <section className="legacy-project-dialog" role="dialog" aria-modal="true" aria-labelledby="legacy-project-title">
            <span className="eyebrow">PROYECTO LOCAL</span>
            <h2 id="legacy-project-title">Encontramos un proyecto anterior</h2>
            <p>
              Este proyecto se guardó antes de iniciar sesión y aún no está asociado a una cuenta.
              Puedes importarlo a esta cuenta o continuar con un proyecto nuevo. El original se conservará en este dispositivo.
            </p>
            <div className="legacy-project-actions">
              <button type="button" className="auth-submit" onClick={() => void importLegacyProject()}>
                Importar a mi cuenta
              </button>
              <button type="button" className="legacy-dismiss" onClick={() => void dismissLegacyProject()}>
                Continuar sin importar
              </button>
            </div>
          </section>
        </div>
      )}
      {notice && <div role="status" className="toast">{notice}</div>}
    </main>
  )
}

export default App
