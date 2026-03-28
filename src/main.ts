import { prepareWithSegments } from '@chenglou/pretext'

// --- Config ---

const RIPPLE_SPEED = 500 // pixels per second
const FADE_WIDTH = 100 // soft edge in pixels
const SCRAMBLE_WIDTH = 80 // scramble zone ahead of the fade edge
const REVEALED_COLOR = '#00ff41'
const SCRAMBLE_CHARS = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン0123456789@#$%&=+<>/'

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
    // Lock width so scramble chars don't cause reflow
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

function setup(): void {
  const containers = document.querySelectorAll('[data-reveal]')
  if (containers.length === 0) return

  const spans: HTMLSpanElement[] = []

  for (const container of containers) {
    // Wrap text in nav links directly, and in block elements within content
    const targets = container.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6, p, li, blockquote, a')
    for (const el of targets) {
      // Skip if a child of another target we'll process (e.g. <a> inside <p>)
      if (el.tagName === 'A' && el.closest('p, li, blockquote, h1, h2, h3, h4, h5, h6')) continue
      spans.push(...wrapTextNodes(el))
    }
  }

  allSpans = measureSpanPositions(spans)
}

// --- Animation ---

function render(): void {
  const now = performance.now()
  let allDone = true

  for (const span of allSpans) {
    if (span.isSpace) {
      // Spaces don't need visual treatment
      if (span.state !== 'revealed') span.state = 'revealed'
      continue
    }

    // Find best state across all ripples
    let bestReveal = span.revealed
    let inScrambleZone = false

    for (const ripple of ripples) {
      const elapsed = (now - ripple.startTime) / 1000
      const radius = elapsed * RIPPLE_SPEED
      const dist = Math.hypot(span.cx - ripple.originX, span.cy - ripple.originY)

      // Reveal zone: inside the main radius
      const reveal = Math.max(0, Math.min(1, (radius - dist) / FADE_WIDTH))
      bestReveal = Math.max(bestReveal, reveal)

      // Scramble zone: ahead of the reveal edge
      if (dist < radius + SCRAMBLE_WIDTH && dist > radius - FADE_WIDTH * 0.3) {
        inScrambleZone = true
      }
    }

    if (bestReveal >= 1) {
      // Fully revealed
      if (span.state !== 'revealed') {
        span.state = 'revealed'
        span.element.textContent = span.originalText
        span.element.style.color = REVEALED_COLOR
      }
      span.revealed = 1
    } else if (bestReveal > 0) {
      // Partially revealed — show real text fading in
      span.state = 'scramble'
      span.revealed = bestReveal
      span.element.textContent = span.originalText
      span.element.style.color = `rgba(0,255,65,${bestReveal})`
      allDone = false
    } else if (inScrambleZone) {
      // In scramble zone — show flickering random chars
      span.state = 'scramble'
      span.element.textContent = scrambleText(span.originalText.length)
      span.element.style.color = `rgba(0,255,65,${0.15 + Math.random() * 0.25})`
      allDone = false
    } else {
      // Hidden
      if (span.state !== 'hidden') {
        span.state = 'hidden'
        span.element.textContent = span.originalText
        span.element.style.color = 'transparent'
      }
      allDone = false
    }
  }

  if (allDone) {
    // Clean up: remove inline-block locks
    for (const span of allSpans) {
      span.element.style.color = REVEALED_COLOR
      if (!span.isSpace) {
        span.element.style.display = ''
        span.element.style.width = ''
      }
    }
    animating = false
  } else {
    requestAnimationFrame(render)
  }
}

function startAnimation(): void {
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

document.addEventListener('pointerdown', (e) => {
  addRipple(e.clientX, e.clientY)
})

window.addEventListener('resize', () => {
  for (const span of allSpans) {
    const rect = span.element.getBoundingClientRect()
    span.cx = rect.left + rect.width / 2
    span.cy = rect.top + rect.height / 2
  }
})

// --- Init ---

setup()

// Auto-trigger ripple from upper-center of viewport on page load
requestAnimationFrame(() => {
  addRipple(window.innerWidth / 2, window.innerHeight / 3)
})
