import { useEffect, useRef, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import { indexedDbProjectRepository } from './data/indexedDbProjectRepository'
import { createProjectBackup, readProjectBackup } from './domain/projectBackup'
import type { CaptionSegment, CaptionStyle, ProjectAsset, ProjectMedia, ProjectSnapshot, VideoAspectRatio } from './domain/project'
import { downloadBlob } from './utils/download'

type MediaItem = ProjectMedia & {
  file: File
  url: string
}
type Panel = 'media' | 'text' | 'audio' | 'effects' | 'captions'
type SaveStatus = 'loading' | 'saved' | 'saving' | 'error'

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
  const outputWidth = sourceAspect > aspect ? Math.round(height * aspect) : width
  const outputHeight = sourceAspect > aspect ? height : Math.round(width / aspect)
  return {
    width: Math.max(2, outputWidth - outputWidth % 2),
    height: Math.max(2, outputHeight - outputHeight % 2),
  }
}

function drawVideoFrame(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  width: number,
  height: number,
  ratio: VideoAspectRatio,
) {
  const sourceWidth = video.videoWidth
  const sourceHeight = video.videoHeight
  const targetRatio = width / height
  const sourceRatio = sourceWidth / sourceHeight
  if (ratio === 'original' || Math.abs(targetRatio - sourceRatio) < 0.001) {
    context.drawImage(video, 0, 0, width, height)
    return
  }

  if (sourceRatio > targetRatio) {
    const cropWidth = sourceHeight * targetRatio
    context.drawImage(video, (sourceWidth - cropWidth) / 2, 0, cropWidth, sourceHeight, 0, 0, width, height)
  } else {
    const cropHeight = sourceWidth / targetRatio
    context.drawImage(video, 0, (sourceHeight - cropHeight) / 2, sourceWidth, cropHeight, 0, 0, width, height)
  }
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
  const [isAspectMenuOpen, setIsAspectMenuOpen] = useState(false)
  const [transcriptionLanguage, setTranscriptionLanguage] = useState('es')
  const [isTranscribing, setIsTranscribing] = useState(false)
  const [filter, setFilter] = useState(filters[0])
  const [videoDimensions, setVideoDimensions] = useState({ width: 0, height: 0 })
  const [previewStageSize, setPreviewStageSize] = useState({ width: 0, height: 0 })
  const [isExporting, setIsExporting] = useState(false)
  const [pendingExport, setPendingExport] = useState<{ blob: Blob; filename: string } | null>(null)
  const [notice, setNotice] = useState('')
  const [dragId, setDragId] = useState('')
  const videoRef = useRef<HTMLVideoElement>(null)
  const previewStageRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const backupInputRef = useRef<HTMLInputElement>(null)
  const mediaRef = useRef(media)
  const activeIdRef = useRef(activeId)
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const saveVersionRef = useRef(0)
  const audioContextRef = useRef<AudioContext | null>(null)
  const audioOutputsRef = useRef(new WeakMap<HTMLVideoElement, MediaStreamAudioDestinationNode>())

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
    .reduce((time, item) => time + Math.max(item.trimEnd - item.trimStart, 0), 0)
    + Math.max(0, Math.min(currentTime - activeVideo.trimStart, activeVideo.trimEnd - activeVideo.trimStart))
  const totalDuration = videos.reduce(
    (total, item) => total + Math.max(item.trimEnd - item.trimStart, 0),
    0,
  )
  const previewAspectRatio = getAspectRatioValue(aspectRatio, videoDimensions.width, videoDimensions.height)
  const previewFrameHeight = Math.min(
    previewStageSize.height,
    previewStageSize.width / previewAspectRatio,
  )
  const previewFrameWidth = previewFrameHeight * previewAspectRatio

  useEffect(() => {
    const stage = previewStageRef.current
    if (!stage) return
    const observer = new ResizeObserver(([entry]) => {
      setPreviewStageSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      })
    })
    observer.observe(stage)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let cancelled = false
    indexedDbProjectRepository.load().then((saved) => {
      if (cancelled) return
      if (saved) {
        const restoredMedia = saved.snapshot.media.map((item) => {
          const asset = saved.assets.find((entry) => entry.id === item.id)
          if (!asset) throw new Error(`No se encontró el archivo "${item.name}".`)
          const file = new File([asset.blob], item.name, {
            type: item.type,
            lastModified: item.lastModified,
          })
          return { ...item, file, url: URL.createObjectURL(file) }
        })
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
  }, [])

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
      setCurrentTime(activeVideo.trimStart)
    }
  }, [activeVideo?.id])

  useEffect(() => {
    if (!isReady || !storageAvailable) return
    const snapshot: ProjectSnapshot = {
      schemaVersion: 4,
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
        .then(() => indexedDbProjectRepository.save(snapshot, assets))
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
  }, [isReady, storageAvailable, projectName, media, activeVideo?.id, overlayText, captionSegments, captionStyle, aspectRatio, filter.name])

  useEffect(() => {
    mediaRef.current = media
  }, [media])

  useEffect(() => {
    return () => {
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
    const additions = accepted.map((file) => ({
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

  const handleTimeUpdate = () => {
    const video = videoRef.current
    if (!video) return
    setCurrentTime(video.currentTime)
    const clipEnd = activeVideo?.trimEnd || trimEnd
    const clipStart = activeVideo?.trimStart ?? trimStart
    if (clipEnd > clipStart && video.currentTime >= clipEnd) {
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
    if (video.paused) {
      if (video.currentTime < clipStart || video.currentTime >= clipEnd) {
        video.currentTime = clipStart
      }
      try {
        await video.play()
        setIsPlaying(true)
      } catch {
        setNotice('No se pudo reproducir este archivo en el navegador.')
      }
    } else {
      video.pause()
      setIsPlaying(false)
    }
  }

  const seek = (time: number) => {
    const video = videoRef.current
    if (!video || !Number.isFinite(time)) return
    const nextTime = Math.max(0, Math.min(time, activeVideo?.duration ?? time))
    video.currentTime = nextTime
    setCurrentTime(nextTime)
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
      const response = await fetch('/api/transcribe', {
        method: 'POST',
        headers: { 'X-FreeCut-Request': 'transcribe' },
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
    let audioOutput: MediaStreamAudioDestinationNode
    try {
      const audioContext = audioContextRef.current ?? new AudioContext()
      audioContextRef.current = audioContext
      const existingOutput = audioOutputsRef.current.get(video)
      if (existingOutput) {
        audioOutput = existingOutput
      } else {
        audioOutput = audioContext.createMediaStreamDestination()
        const source = audioContext.createMediaElementSource(video)
        source.connect(audioOutput)
        source.connect(audioContext.destination)
        audioOutputsRef.current.set(video, audioOutput)
      }
      await audioContext.resume()
    } catch {
      stream.getTracks().forEach((track) => track.stop())
      setIsExporting(false)
      setNotice('No se pudo preparar el audio para la exportación.')
      return
    }
    audioOutput.stream.getAudioTracks().forEach((track) => stream.addTrack(track))
    const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
      .find((type) => MediaRecorder.isTypeSupported(type))
    if (!mimeType) {
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
      stream.getTracks().forEach((track) => track.stop())
      setIsExporting(false)
      setNotice('Ocurrió un error durante la exportación.')
    }
    recorder.onstop = () => {
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
      if (video.currentTime >= clipEnd || video.ended) {
        video.pause()
        recorder.stop()
        return
      }
      context.filter = filter.css
      drawVideoFrame(context, video, canvas.width, canvas.height, aspectRatio)
      context.filter = 'none'
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
      requestAnimationFrame(drawFrame)
    }

    const beginRecording = async () => {
      video.onseeked = null
      try {
        await video.play()
        requestAnimationFrame(drawFrame)
      } catch {
        recorder.stop()
        setIsExporting(false)
        setNotice('No se pudo iniciar la exportación de este video.')
      }
    }
    recorder.start()
    if (Math.abs(video.currentTime - clipStart) < 0.001) {
      void beginRecording()
    } else {
      video.onseeked = () => void beginRecording()
      video.currentTime = clipStart
    }
  }

  const exportBackup = () => {
    const snapshot: ProjectSnapshot = {
      schemaVersion: 4,
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
        .then(() => indexedDbProjectRepository.save(snapshot, restored.assets, true))
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
        </aside>

        <section className="editor-area">
          <div className="preview-toolbar">
            <div className="preview-label"><span className="live-dot" /> VISTA PREVIA <span className="divider">/</span> {activeVideo?.file.name ?? 'Sin clip seleccionado'}</div>
            <div className="ratio-control">
              <button
                className="ratio-button"
                type="button"
                aria-haspopup="true"
                aria-expanded={isAspectMenuOpen}
                onClick={() => setIsAspectMenuOpen((open) => !open)}
              >
                {aspectRatios.find((item) => item.id === aspectRatio)?.name ?? 'Original'} <span>⌄</span>
              </button>
              {isAspectMenuOpen && (
                <div className="ratio-menu" role="group" aria-label="Formato del video">
                  {aspectRatios.map((option) => (
                    <button
                      className={`ratio-option ${aspectRatio === option.id ? 'selected' : ''}`}
                      key={option.id}
                      type="button"
                      aria-pressed={aspectRatio === option.id}
                      onClick={() => {
                        setAspectRatio(option.id)
                        setIsAspectMenuOpen(false)
                      }}
                    >
                      <span className="ratio-option-icon" style={{ aspectRatio: option.value ? String(option.value) : String(previewAspectRatio) }} />
                      <span>{option.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="preview-stage" ref={previewStageRef}>
            {activeVideo ? (
              <div
                className="video-frame"
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
                  }}
                  onTimeUpdate={handleTimeUpdate}
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => setIsPlaying(false)}
                  style={{ filter: filter.css }}
                  playsInline
                />
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

          <section className="timeline">
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
            <div className="timeline-ruler">
              <span>00:00</span>
              <span>{formatTime(totalDuration / 4)}</span>
              <span>{formatTime(totalDuration / 2)}</span>
              <span>{formatTime(totalDuration * .75)}</span>
              <span>{formatTime(totalDuration)}</span>
            </div>
            <div className="timeline-track video-track">
              <div className="track-label"><span className="track-icon">▧</span><span>Video</span></div>
              <div className="track-content">
                {videos.length === 0 ? (
                  <button className="track-empty" onClick={() => fileInputRef.current?.click()}>＋ Arrastra clips aquí o importa medios</button>
                ) : videos.map((item, index) => (
                  <div
                    key={item.id}
                    className={`timeline-clip ${item.id === activeId ? 'selected' : ''}`}
                    style={{ flex: `${Math.max(item.trimEnd - item.trimStart, 1)} 1 0%` }}
                    draggable
                    onDragStart={() => setDragId(item.id)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => {
                      moveClip(dragId, item.id)
                      setDragId('')
                    }}
                    onClick={() => setActiveId(item.id)}
                    title={`${item.file.name} · clip ${index + 1}`}
                  >
                    <span className="clip-filmstrip"><span>▶</span><strong>{item.file.name}</strong>{item.duration > 0 && <small>{formatTime(item.duration)}</small>}</span>
                  </div>
                ))}
                {activeVideo && (
                  <div className="playhead" style={{ left: `${totalDuration ? (timelineTime / totalDuration) * 100 : 0}%` }}>
                    <span />
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
                <div className="section-title">Velocidad <span className="coming-soon">Próximamente</span></div>
                <div className="disabled-control">1.0× <span>⌄</span></div>
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
      {notice && <div role="status" className="toast">{notice}</div>}
    </main>
  )
}

export default App
