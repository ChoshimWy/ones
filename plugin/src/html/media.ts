import type { MediaChunk } from '../adapters/bug-media.ts'
import { readPluginImageHeader, PLUGIN_IMAGE_MIME } from '../vendor/image-header.ts'
import { button, el, notice, request, UIError } from './dom.ts'

const CHUNK = 512 * 1024
const MAX_FILE = 32 * 1024 * 1024
const MAX_MEMORY = 64 * 1024 * 1024
const supported = new Set(['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm'])
let used = 0
let pending = 0
let queue: Promise<void> = Promise.resolve()
const unavailable = () => new UIError('媒体不可用或超出支持范围，请在原单查看。')

export async function loadMedia(
  read: (offset: number) => Promise<MediaChunk>,
  kind: 'image' | 'video',
  signal: AbortSignal
): Promise<{ url: string; dispose(): void }> {
  if (pending >= 32) throw unavailable()
  pending++
  const previous = queue
  let release = () => {}
  queue = new Promise<void>((resolve) => {
    release = resolve
  })
  let reserved = 0
  let url = ''
  const dispose = () => {
    if (url) {
      URL.revokeObjectURL(url)
      url = ''
    }
    used -= reserved
    reserved = 0
  }
  try {
    await previous
    let offset = 0,
      mime = ''
    let bytes: Uint8Array<ArrayBuffer> | undefined
    for (;;) {
      signal.throwIfAborted()
      const chunk = await read(offset)
      signal.throwIfAborted()
      if (
        !chunk ||
        !supported.has(chunk.mime) ||
        !chunk.mime.startsWith(kind + '/') ||
        !Number.isSafeInteger(chunk.total) ||
        chunk.total < 1 ||
        chunk.total > MAX_FILE ||
        chunk.offset !== offset ||
        typeof chunk.data !== 'string' ||
        chunk.data.length > Math.ceil(CHUNK / 3) * 4 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk.data)
      )
        throw unavailable()
      if (!bytes) {
        if (used + chunk.total > MAX_MEMORY) throw unavailable()
        reserved = chunk.total
        used += reserved
        mime = chunk.mime
        bytes = new Uint8Array(reserved)
      }
      if (chunk.mime !== mime || chunk.total !== reserved) throw unavailable()
      const raw = atob(chunk.data),
        end = offset + raw.length
      if (
        !raw.length ||
        raw.length > CHUNK ||
        end > reserved ||
        chunk.next !== (end === reserved ? null : end) ||
        (chunk.next !== null && raw.length !== CHUNK)
      )
        throw unavailable()
      for (let i = 0; i < raw.length; i++) bytes[offset + i] = raw.charCodeAt(i)
      if (chunk.next === null) break
      offset = chunk.next
    }
    if (kind === 'image') {
      const header = readPluginImageHeader(bytes)
      if (typeof header === 'string' || PLUGIN_IMAGE_MIME[header.format] !== mime)
        throw unavailable()
    } else if (mime === 'video/mp4') {
      if (String.fromCharCode(...bytes.subarray(4, 8)) !== 'ftyp') throw unavailable()
    } else if (![0x1a, 0x45, 0xdf, 0xa3].every((v, i) => bytes[i] === v)) throw unavailable()
    signal.throwIfAborted()
    url = URL.createObjectURL(new Blob([bytes], { type: mime }))
    return { url, dispose }
  } catch (error) {
    dispose()
    throw error
  } finally {
    pending--
    release()
  }
}

export class MediaView {
  readonly element: HTMLElement
  private controller = new AbortController()
  private loaded?: { url: string; dispose(): void }
  private observer?: IntersectionObserver
  private active = false
  private closed = false
  private body = el('div', 'media-placeholder stack')
  constructor(
    private detailId: string,
    private resourceId: string,
    private kind: 'image' | 'video',
    label: string
  ) {
    this.element = el('figure', '', el('figcaption', '', label), this.body)
    this.placeholder()
    if (kind === 'image') {
      this.observer = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          this.observer?.disconnect()
          void this.load(label)
        }
      })
      this.observer.observe(this.element)
    }
    this.element.dataset.label = label
  }
  private placeholder(failed = false): void {
    this.body.replaceChildren(
      ...(failed ? [notice(unavailable().message, true)] : []),
      button(
        this.active ? '正在加载媒体…' : '加载媒体',
        () => this.load(this.element.dataset.label ?? '媒体'),
        this.active
      )
    )
  }
  private async load(label: string): Promise<void> {
    if (this.closed || this.active) return
    this.active = true
    this.placeholder()
    try {
      const loaded = await loadMedia(
        (offset) =>
          request<MediaChunk>(
            'bugs.media',
            { detailId: this.detailId, resourceId: this.resourceId, offset },
            this.controller.signal
          ),
        this.kind,
        this.controller.signal
      )
      if (this.closed) {
        loaded.dispose()
        return
      }
      this.loaded = loaded
      const media = this.kind === 'image' ? el('img') : el('video')
      if (media instanceof HTMLImageElement) {
        media.alt = label
        media.className = 'media-thumbnail'
      }
      else {
        media.controls = true
        media.preload = 'metadata'
        media.playsInline = true
        media.setAttribute('aria-label', label)
        media.autoplay = false
      }
      media.addEventListener('error', () => {
        if (!this.closed) {
          this.release()
          this.placeholder(true)
        }
      })
      media.src = loaded.url
      this.body.className = media instanceof HTMLImageElement ? 'media-image-frame' : ''
      this.body.replaceChildren(media)
    } catch {
      if (!this.closed) this.placeholder(true)
    } finally {
      this.active = false
      if (!this.closed && !this.loaded) this.placeholder(true)
    }
  }
  private release(): void {
    for (const media of this.body.querySelectorAll('video')) {
      media.pause()
      media.removeAttribute('src')
      media.load()
    }
    this.loaded?.dispose()
    this.loaded = undefined
    this.body.className = 'media-placeholder stack'
  }
  dispose(): void {
    this.closed = true
    this.controller.abort()
    this.observer?.disconnect()
    this.release()
    this.body.replaceChildren()
  }
}
