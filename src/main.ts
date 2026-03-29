import { prepareWithSegments } from '@chenglou/pretext'

// --- Config ---

const RIPPLE_SPEED = 500 // pixels per second
const FADE_WIDTH = 250 // soft edge in pixels
const SCRAMBLE_WIDTH = 80 // scramble zone ahead of the fade edge
const JITTER_RANGE = 100 // per-span random offset to stagger reveal
const WOBBLE_AMP = 60 // angle-based wavefront distortion amplitude
const WOBBLE_FREQ = 3 // number of lobes in the wobble pattern
const DISSOLVE_OUT_SPEED = 3000 // pixels per second (faster than reveal)
const DISSOLVE_OUT_DELAY = 300 // ms to wait before navigating
const OVERSHOOT_RANGE = 150 // how far past text the canvas scramble extends
const GRID_X = 14 // canvas overshoot grid spacing
const GRID_Y = 28
const SCRAMBLE_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789@#$%&=+<>/?!~^*'

function getThemeColors() {
  const style = getComputedStyle(document.documentElement)
  return {
    revealed: style.getPropertyValue('--fg').trim(),
    rgb: style.getPropertyValue('--fg-rgb').trim(),
  }
}

let theme = getThemeColors()

function glowShadow(alpha: number = 0.15): string {
  return `0 0 6px rgba(${theme.rgb},${alpha})`
}

// --- Types ---

type RevealSpan = {
  element: HTMLSpanElement
  originalText: string
  x: number // left edge
  y: number // top edge
  cx: number
  cy: number
  width: number
  height: number
  font: string
  revealed: number // 0..1
  state: 'hidden' | 'revealed'
  isSpace: boolean
  jitter: number // random offset to stagger reveal timing
  wobbleSeed: number // per-span angle offset for wavefront distortion
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
let dissolveOut: { originX: number; originY: number; startTime: number; href: string } | null = null

// --- Canvas overlay ---

const canvas = document.getElementById('scramble') as HTMLCanvasElement
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

function scrambleString(length: number): string {
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

    // Preserve leading/trailing whitespace that Pretext normalization strips
    const hasLeadingSpace = /^\s/.test(text)
    const hasTrailingSpace = /\s$/.test(text)

    const prepared = prepareWithSegments(text, font)
    const fragment = document.createDocumentFragment()

    if (hasLeadingSpace && prepared.segments.length > 0 && !/^\s/.test(prepared.segments[0]!)) {
      const spacer = document.createElement('span')
      spacer.className = 'reveal-span'
      spacer.textContent = ' '
      fragment.appendChild(spacer)
      spans.push(spacer)
    }

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

    if (hasTrailingSpace && prepared.segments.length > 0 && !/\s$/.test(prepared.segments[prepared.segments.length - 1]!)) {
      const spacer = document.createElement('span')
      spacer.className = 'reveal-span'
      spacer.textContent = ' '
      fragment.appendChild(spacer)
      spans.push(spacer)
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
    const style = getComputedStyle(span)
    const font = `${style.fontStyle !== 'normal' ? style.fontStyle + ' ' : ''}${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
    return {
      element: span,
      originalText: text,
      x: rect.left,
      y: rect.top,
      cx: rect.left + rect.width / 2,
      cy: rect.top + rect.height / 2,
      width: rect.width,
      height: rect.height,
      font,
      revealed: 0,
      state: 'hidden' as const,
      isSpace,
      jitter: (Math.random() - 0.5) * JITTER_RANGE,
      wobbleSeed: Math.random() * Math.PI * 2,
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

function renderCanvas(now: number): void {
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight)

  const vw = window.innerWidth
  const vh = window.innerHeight

  // Draw scramble text at span positions
  for (const span of allSpans) {
    if (span.isSpace || span.revealed >= 1) continue

    let inScrambleZone = false
    let bestScrambleAlpha = 0

    for (const ripple of ripples) {
      const elapsed = (now - ripple.startTime) / 1000
      const radius = elapsed * RIPPLE_SPEED
      const sdx = span.cx - ripple.originX
      const sdy = span.cy - ripple.originY
      const dist = Math.hypot(sdx, sdy)
      const angle = Math.atan2(sdy, sdx)
      const wobble = Math.sin(angle * WOBBLE_FREQ + span.wobbleSeed) * WOBBLE_AMP
      const effectiveDist = dist - span.jitter - wobble

      if (effectiveDist < radius + SCRAMBLE_WIDTH && effectiveDist > radius - FADE_WIDTH * 0.3 && span.revealed < 0.5) {
        inScrambleZone = true
        const ringWidth = SCRAMBLE_WIDTH + FADE_WIDTH * 0.3
        const ringPos = (effectiveDist - (radius - FADE_WIDTH * 0.3)) / ringWidth
        const fade = ringPos < 0.5 ? ringPos * 2 : (1 - ringPos) * 2
        bestScrambleAlpha = Math.max(bestScrambleAlpha, fade * (0.3 + Math.random() * 0.5))
      }
    }

    if (inScrambleZone) {
      ctx.font = span.font
      ctx.textBaseline = 'top'
      ctx.fillStyle = `rgba(${theme.rgb},${bestScrambleAlpha})`
      ctx.fillText(scrambleString(span.originalText.length), span.x, span.y)
    }
  }

  // Draw overshoot grid scramble
  ctx.font = '18px Georgia, serif'
  ctx.textBaseline = 'top'

  for (const ripple of ripples) {
    const elapsed = (now - ripple.startTime) / 1000
    const radius = elapsed * RIPPLE_SPEED
    const outerRadius = radius + SCRAMBLE_WIDTH + OVERSHOOT_RANGE
    const innerRadius = radius - FADE_WIDTH * 0.3

    const minX = Math.max(0, Math.floor((ripple.originX - outerRadius) / GRID_X) * GRID_X)
    const maxX = Math.min(vw, Math.ceil((ripple.originX + outerRadius) / GRID_X) * GRID_X)
    const minY = Math.max(0, Math.floor((ripple.originY - outerRadius) / GRID_Y) * GRID_Y)
    const maxY = Math.min(vh, Math.ceil((ripple.originY + outerRadius) / GRID_Y) * GRID_Y)

    for (let y = minY; y < maxY; y += GRID_Y) {
      for (let x = minX; x < maxX; x += GRID_X) {
        const dist = Math.hypot(x - ripple.originX, y - ripple.originY)
        if (dist < innerRadius || dist > outerRadius) continue

        const ringPos = (dist - innerRadius) / (outerRadius - innerRadius)
        const ringFade = ringPos < 0.5 ? ringPos * 2 : (1 - ringPos) * 2

        const alpha = ringFade * (0.2 + Math.random() * 0.5)
        if (alpha < 0.02) continue

        ctx.fillStyle = `rgba(${theme.rgb},${alpha})`
        ctx.fillText(randomChar(), x, y)
      }
    }
  }
}

function render(): void {
  const now = performance.now()
  let allDone = true
  let anyRippleActive = false

  // Compute dissolve-out factor per span
  let dissolveOutRadius = 0
  if (dissolveOut) {
    const elapsed = (now - dissolveOut.startTime) / 1000
    dissolveOutRadius = elapsed * DISSOLVE_OUT_SPEED

    // Navigate once the delay has passed
    if (now - dissolveOut.startTime >= DISSOLVE_OUT_DELAY) {
      window.location.href = dissolveOut.href
      return
    }
  }

  for (const span of allSpans) {
    if (span.isSpace) {
      if (span.state !== 'revealed' && !dissolveOut) span.state = 'revealed'
      continue
    }

    // --- Reveal in ---
    let bestReveal = span.revealed

    for (const ripple of ripples) {
      const elapsed = (now - ripple.startTime) / 1000
      const radius = elapsed * RIPPLE_SPEED
      const dx = span.cx - ripple.originX
      const dy = span.cy - ripple.originY
      const dist = Math.hypot(dx, dy)
      const angle = Math.atan2(dy, dx)
      const wobble = Math.sin(angle * WOBBLE_FREQ + span.wobbleSeed) * WOBBLE_AMP

      const raw = Math.max(0, Math.min(1, (radius - dist + span.jitter + wobble) / FADE_WIDTH))
      const reveal = raw * raw * (3 - 2 * raw)
      bestReveal = Math.max(bestReveal, reveal)

      const maxDist = Math.hypot(
        Math.max(Math.abs(ripple.originX), Math.abs(window.innerWidth - ripple.originX)),
        Math.max(Math.abs(ripple.originY), Math.abs(window.innerHeight - ripple.originY)),
      )
      if (radius < maxDist + SCRAMBLE_WIDTH + OVERSHOOT_RANGE) {
        anyRippleActive = true
      }
    }

    // --- Dissolve out (reverse ripple) ---
    let dissolveAlpha = 1
    if (dissolveOut) {
      const ddx = span.cx - dissolveOut.originX
      const ddy = span.cy - dissolveOut.originY
      const dist = Math.hypot(ddx, ddy)
      const angle = Math.atan2(ddy, ddx)
      const wobble = Math.sin(angle * WOBBLE_FREQ + span.wobbleSeed) * WOBBLE_AMP
      const raw = Math.max(0, Math.min(1, (dissolveOutRadius - dist + span.jitter + wobble) / FADE_WIDTH))
      const fade = raw * raw * (3 - 2 * raw)
      dissolveAlpha = 1 - fade
      anyRippleActive = true
    }

    const finalAlpha = Math.min(bestReveal, dissolveAlpha)

    if (finalAlpha >= 1 && !dissolveOut) {
      if (span.state !== 'revealed') {
        span.state = 'revealed'
        span.element.style.color = theme.revealed
        span.element.style.textShadow = glowShadow()
      }
      span.revealed = 1
    } else if (finalAlpha > 0) {
      span.revealed = bestReveal
      span.element.style.color = `rgba(${theme.rgb},${finalAlpha})`
      span.element.style.textShadow = glowShadow(finalAlpha * 0.4)
      allDone = false
    } else {
      if (span.state !== 'hidden') {
        span.state = 'hidden'
        span.element.style.color = 'transparent'
        span.element.style.textShadow = 'none'
      }
      allDone = false
    }
  }

  if (anyRippleActive || dissolveOut) {
    renderCanvas(now)
  } else {
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight)
  }

  if (allDone && !anyRippleActive && !dissolveOut) {
    for (const span of allSpans) {
      span.element.style.color = theme.revealed
      span.element.style.textShadow = glowShadow()
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

document.addEventListener('click', (e) => {
  if (dissolveOut) return

  // Check if click was on a same-origin nav link
  const link = (e.target as HTMLElement).closest('a[href]') as HTMLAnchorElement | null
  if (link) {
    const url = new URL(link.href)
    if (url.origin === window.location.origin) {
      if (url.pathname === window.location.pathname) {
        e.preventDefault()
        return
      }
      e.preventDefault()
      sessionStorage.setItem('ripple', JSON.stringify({ x: e.clientX, y: e.clientY }))
      dissolveOut = {
        originX: e.clientX,
        originY: e.clientY,
        startTime: performance.now(),
        href: link.href,
      }
      startAnimation()
      return
    }
  }

  // Regular click — reveal ripple
  addRipple(e.clientX, e.clientY)
})

window.addEventListener('resize', () => {
  sizeCanvas()
  for (const span of allSpans) {
    const rect = span.element.getBoundingClientRect()
    span.x = rect.left
    span.y = rect.top
    span.cx = rect.left + rect.width / 2
    span.cy = rect.top + rect.height / 2
  }
  computeTextBounds()
})

// --- Init ---

setup()

const stored = sessionStorage.getItem('ripple')
if (stored) {
  sessionStorage.removeItem('ripple')
  const { x, y } = JSON.parse(stored)
  requestAnimationFrame(() => addRipple(x, y))
}

// --- Theme picker ---

function setActiveThemeSwatch(name: string): void {
  document.querySelectorAll('.theme-swatch').forEach(s => s.classList.remove('active'))
  document.querySelector(`.theme-swatch[data-swatch="${name}"]`)?.classList.add('active')
}

const savedTheme = localStorage.getItem('theme')
if (savedTheme) {
  document.documentElement.setAttribute('data-theme', savedTheme)
  theme = getThemeColors()
}
setActiveThemeSwatch(savedTheme || 'matrix')

document.querySelectorAll('.theme-swatch').forEach(swatch => {
  swatch.addEventListener('click', (e) => {
    e.stopPropagation()
    const name = (swatch as HTMLElement).dataset.swatch!
    const themeAttr = name === 'matrix' ? '' : name
    if (themeAttr) {
      document.documentElement.setAttribute('data-theme', themeAttr)
      localStorage.setItem('theme', themeAttr)
    } else {
      document.documentElement.removeAttribute('data-theme')
      localStorage.removeItem('theme')
    }
    theme = getThemeColors()
    setActiveThemeSwatch(name)
    for (const span of allSpans) {
      if (span.state === 'revealed') {
        span.element.style.color = theme.revealed
        span.element.style.textShadow = glowShadow()
      }
    }
  })
})

// --- Font picker ---

function setActiveFontSwatch(name: string): void {
  document.querySelectorAll('.font-swatch').forEach(s => s.classList.remove('active'))
  document.querySelector(`.font-swatch[data-font="${name}"]`)?.classList.add('active')
}

const savedFont = localStorage.getItem('font')
if (savedFont) {
  document.documentElement.setAttribute('data-font', savedFont)
}
setActiveFontSwatch(savedFont || 'serif')

document.querySelectorAll('.font-swatch').forEach(swatch => {
  swatch.addEventListener('click', (e) => {
    e.stopPropagation()
    const name = (swatch as HTMLElement).dataset.font!
    if (name === 'serif') {
      document.documentElement.removeAttribute('data-font')
      localStorage.removeItem('font')
    } else {
      document.documentElement.setAttribute('data-font', name)
      localStorage.setItem('font', name)
    }
    setActiveFontSwatch(name)
  })
})

// --- Nav active state ---

document.querySelectorAll('.nav-links a').forEach(link => {
  const href = (link as HTMLAnchorElement).getAttribute('href')!
  const path = window.location.pathname.replace(/\/$/, '') || '/'
  const linkPath = href.replace(/\/$/, '') || '/'
  if (path === linkPath) {
    link.classList.add('nav-active')
  }
})
