import { prepareWithSegments } from '@chenglou/pretext'

// --- Config ---

const RIPPLE_SPEED = 500 // pixels per second
const FADE_WIDTH = 100 // soft edge in pixels
const SCRAMBLE_WIDTH = 80 // scramble zone ahead of the fade edge
const OVERSHOOT_RANGE = 150 // how far past text the canvas scramble extends
const GRID_X = 14 // canvas scramble grid spacing
const GRID_Y = 28
const REVEALED_COLOR = '#00ff41'
const SCRAMBLE_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789@#$%&=+<>/?!~^*'

// --- Types ---

type RevealSpan = {
  element: HTMLSpanElement
  originalText: string
  cx: number
  cy: number
  width: number
  revealed: number // 0..1
  state: 'hidden' | 'scramble' | 'revealed'
  isSpace: boolean
}

type Ripple = {
  originX: number
  originY: number
  startTime: number
}

// --- State ---

let allSpans: RevealSpan[] = []
let ripples: Ripple[] = []
let animating = false
let textBounds = { top: 0, bottom: 0, left: 0, right: 0 }

// --- Canvas overlay ---

const canvas = document.createElement('canvas')
canvas.className = 'scramble-canvas'
document.body.appendChild(canvas)
const ctx = canvas.getContext('2d')!

function sizeCanvas(): void {
  const dpr = window.devicePixelRatio || 1
  canvas.width = window.innerWidth * dpr
  canvas.height = window.innerHeight * dpr
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
}

sizeCanvas()

// --- Scramble ---

function randomChar(): string {
  return SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)]!
}

function scrambleText(length: number): string {
  let s = ''
  for (let i = 0; i < length; i++) s += randomChar()
  return s
}

// --- Setup ---

function wrapTextNodes(el: HTMLElement): HTMLSpanElement[] {
  const spans: HTMLSpanElement[] = []
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  const textNodes: Text[] = []
  let node: Text | null
  while ((node = walker.nextNode() as Text | null)) {
    if (node.textContent && node.textContent.length > 0) {
      textNodes.push(node)
    }
  }

  for (const textNode of textNodes) {
    const text = textNode.textContent!
    const parent = textNode.parentElement!
    const style = getComputedStyle(parent)
    const font = `${style.fontStyle !== 'normal' ? style.fontStyle + ' ' : ''}${style.fontWeight} ${style.fontSize} ${style.fontFamily}`

    const prepared = prepareWithSegments(text, font)
    const fragment = document.createDocumentFragment()

    for (let i = 0; i < prepared.segments.length; i++) {
      const segText = prepared.segments[i]!
      const kind = prepared.kinds[i]!
      if (kind === 'hard-break') continue

      const span = document.createElement('span')
      span.className = 'reveal-span'
      span.textContent = segText
      fragment.appendChild(span)
      spans.push(span)
    }

    textNode.replaceWith(fragment)
  }

  return spans
}

function measureSpanPositions(spans: HTMLSpanElement[]): RevealSpan[] {
  return spans.map(span => {
    const rect = span.getBoundingClientRect()
    const text = span.textContent!
    const isSpace = text.trim().length === 0
    if (!isSpace) {
      span.style.display = 'inline-block'
      span.style.width = `${rect.width}px`
    }
    return {
      element: span,
      originalText: text,
      cx: rect.left + rect.width / 2,
      cy: rect.top + rect.height / 2,
      width: rect.width,
      revealed: 0,
      state: 'hidden' as const,
      isSpace,
    }
  })
}

function computeTextBounds(): void {
  let top = Infinity, bottom = 0, left = Infinity, right = 0
  for (const span of allSpans) {
    if (span.isSpace) continue
    const halfW = span.width / 2
    const halfH = GRID_Y / 2
    top = Math.min(top, span.cy - halfH)
    bottom = Math.max(bottom, span.cy + halfH)
    left = Math.min(left, span.cx - halfW)
    right = Math.max(right, span.cx + halfW)
  }
  textBounds = { top, bottom, left, right }
}

function distFromTextBounds(x: number, y: number): number {
  const dx = Math.max(0, textBounds.left - x, x - textBounds.right)
  const dy = Math.max(0, textBounds.top - y, y - textBounds.bottom)
  return Math.sqrt(dx * dx + dy * dy)
}

function setup(): void {
  const containers = document.querySelectorAll('[data-reveal]')
  if (containers.length === 0) return

  const spans: HTMLSpanElement[] = []

  for (const container of containers) {
    const targets = container.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6, p, li, blockquote, a')
    for (const el of targets) {
      if (el.tagName === 'A' && el.closest('p, li, blockquote, h1, h2, h3, h4, h5, h6')) continue
      spans.push(...wrapTextNodes(el))
    }
  }

  allSpans = measureSpanPositions(spans)
  computeTextBounds()
}

// --- Animation ---

function isNearSpan(x: number, y: number): boolean {
  for (const span of allSpans) {
    if (span.isSpace) continue
    if (Math.abs(x - span.cx) < span.width / 2 + 4 && Math.abs(y - span.cy) < GRID_Y / 2 + 2) {
      return true
    }
  }
  return false
}

function renderCanvasOvershoot(now: number): void {
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight)
  ctx.font = '18px Georgia, serif'
  ctx.textBaseline = 'top'

  const vw = window.innerWidth
  const vh = window.innerHeight

  for (const ripple of ripples) {
    const elapsed = (now - ripple.startTime) / 1000
    const radius = elapsed * RIPPLE_SPEED
    const outerRadius = radius + SCRAMBLE_WIDTH + OVERSHOOT_RANGE
    const innerRadius = radius - FADE_WIDTH * 0.3

    // Only iterate grid cells within the bounding box of the outer ring
    const minX = Math.max(0, Math.floor((ripple.originX - outerRadius) / GRID_X) * GRID_X)
    const maxX = Math.min(vw, Math.ceil((ripple.originX + outerRadius) / GRID_X) * GRID_X)
    const minY = Math.max(0, Math.floor((ripple.originY - outerRadius) / GRID_Y) * GRID_Y)
    const maxY = Math.min(vh, Math.ceil((ripple.originY + outerRadius) / GRID_Y) * GRID_Y)

    for (let y = minY; y < maxY; y += GRID_Y) {
      for (let x = minX; x < maxX; x += GRID_X) {
        const dist = Math.hypot(x - ripple.originX, y - ripple.originY)
        if (dist < innerRadius || dist > outerRadius) continue

        // Skip cells that overlap with actual text spans
        if (isNearSpan(x, y)) continue

        // Fade based on distance from text content
        const textDist = distFromTextBounds(x, y)
        if (textDist > OVERSHOOT_RANGE) continue

        const overshootFade = 1 - textDist / OVERSHOOT_RANGE
        // Fade based on position in the scramble ring
        const ringPos = (dist - innerRadius) / (outerRadius - innerRadius)
        const ringFade = ringPos < 0.5 ? ringPos * 2 : (1 - ringPos) * 2

        const alpha = overshootFade * ringFade * (0.1 + Math.random() * 0.2)
        if (alpha < 0.02) continue

        ctx.fillStyle = `rgba(0,255,65,${alpha})`
        ctx.fillText(randomChar(), x, y)
      }
    }
  }
}

function render(): void {
  const now = performance.now()
  let allDone = true
  let anyRippleActive = false

  for (const span of allSpans) {
    if (span.isSpace) {
      if (span.state !== 'revealed') span.state = 'revealed'
      continue
    }

    let bestReveal = span.revealed
    let inScrambleZone = false

    for (const ripple of ripples) {
      const elapsed = (now - ripple.startTime) / 1000
      const radius = elapsed * RIPPLE_SPEED
      const dist = Math.hypot(span.cx - ripple.originX, span.cy - ripple.originY)

      const reveal = Math.max(0, Math.min(1, (radius - dist) / FADE_WIDTH))
      bestReveal = Math.max(bestReveal, reveal)

      if (dist < radius + SCRAMBLE_WIDTH && dist > radius - FADE_WIDTH * 0.3) {
        inScrambleZone = true
      }

      // Check if this ripple can still reach any unrevealed content
      const maxDist = Math.hypot(
        Math.max(Math.abs(ripple.originX), Math.abs(window.innerWidth - ripple.originX)),
        Math.max(Math.abs(ripple.originY), Math.abs(window.innerHeight - ripple.originY)),
      )
      if (radius < maxDist + SCRAMBLE_WIDTH + OVERSHOOT_RANGE) {
        anyRippleActive = true
      }
    }

    if (bestReveal >= 1) {
      if (span.state !== 'revealed') {
        span.state = 'revealed'
        span.element.textContent = span.originalText
        span.element.style.color = REVEALED_COLOR
      }
      span.revealed = 1
    } else if (bestReveal > 0) {
      span.state = 'scramble'
      span.revealed = bestReveal
      span.element.textContent = span.originalText
      span.element.style.color = `rgba(0,255,65,${bestReveal})`
      allDone = false
    } else if (inScrambleZone) {
      span.state = 'scramble'
      span.element.textContent = scrambleText(span.originalText.length)
      span.element.style.color = `rgba(0,255,65,${0.15 + Math.random() * 0.25})`
      allDone = false
    } else {
      if (span.state !== 'hidden') {
        span.state = 'hidden'
        span.element.textContent = span.originalText
        span.element.style.color = 'transparent'
      }
      allDone = false
    }
  }

  // Render canvas overshoot
  if (anyRippleActive) {
    renderCanvasOvershoot(now)
  } else {
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight)
  }

  if (allDone && !anyRippleActive) {
    for (const span of allSpans) {
      span.element.style.color = REVEALED_COLOR
      if (!span.isSpace) {
        span.element.style.display = ''
        span.element.style.width = ''
      }
    }
    canvas.style.display = 'none'
    animating = false
  } else {
    requestAnimationFrame(render)
  }
}

function startAnimation(): void {
  canvas.style.display = 'block'
  if (!animating) {
    animating = true
    requestAnimationFrame(render)
  }
}

// --- Ripple ---

function addRipple(x: number, y: number): void {
  ripples.push({
    originX: x,
    originY: y,
    startTime: performance.now(),
  })
  startAnimation()
}

// --- Events ---

// Capture click position on nav links before navigation
document.querySelectorAll('a[href]').forEach(link => {
  link.addEventListener('click', (e) => {
    const me = e as MouseEvent
    sessionStorage.setItem('ripple', JSON.stringify({ x: me.clientX, y: me.clientY }))
  })
})

document.addEventListener('pointerdown', (e) => {
  addRipple(e.clientX, e.clientY)
})

window.addEventListener('resize', () => {
  sizeCanvas()
  for (const span of allSpans) {
    const rect = span.element.getBoundingClientRect()
    span.cx = rect.left + rect.width / 2
    span.cy = rect.top + rect.height / 2
  }
  computeTextBounds()
})

// --- Init ---

setup()

// If we arrived via a click (e.g. nav link), trigger ripple from that location
const stored = sessionStorage.getItem('ripple')
if (stored) {
  sessionStorage.removeItem('ripple')
  const { x, y } = JSON.parse(stored)
  requestAnimationFrame(() => addRipple(x, y))
}
