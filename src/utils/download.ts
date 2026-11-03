import { Capacitor } from '@capacitor/core'

export function downloadBlob(blob: Blob, filename: string): boolean | Promise<boolean> {
  const file = new File([blob], filename, {
    type: blob.type || 'application/octet-stream',
  })
  if (Capacitor.isNativePlatform()) {
    if (typeof navigator.canShare !== 'function' || !navigator.canShare({ files: [file] })) {
      throw new Error('Este dispositivo no permite compartir archivos desde la app.')
    }
    return navigator.share({ files: [file], title: filename }).then(
      () => true,
      (error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return false
        throw error
      },
    )
  }

  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.style.display = 'none'
  try {
    document.body.append(link)
    link.click()
  } catch (error) {
    URL.revokeObjectURL(url)
    throw error
  } finally {
    link.remove()
  }
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  return true
}
