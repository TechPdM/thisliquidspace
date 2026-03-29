import { readdir, readFile, writeFile, mkdir, cp } from 'fs/promises'
import { join } from 'path'

const ROOT = import.meta.dir + '/..'
const OUT = join(ROOT, 'dist')

// Clean and create output dir
await Bun.$`rm -rf ${OUT}`
await mkdir(OUT, { recursive: true })

// Bundle the TS entry point
const result = await Bun.build({
  entrypoints: [join(ROOT, 'src/main.ts')],
  outdir: join(OUT, 'assets'),
  minify: true,
  target: 'browser',
})

if (!result.success) {
  console.error('Build failed:', result.logs)
  process.exit(1)
}

const jsFilename = 'assets/' + result.outputs[0]!.path.split('/').pop()!

// Bundle CSS
const css = await readFile(join(ROOT, 'src/styles.css'), 'utf-8')
await mkdir(join(OUT, 'assets'), { recursive: true })
await writeFile(join(OUT, 'assets/styles.css'), css)

// Process HTML files — replace TS/CSS references with built versions
const htmlFiles = (await readdir(ROOT)).filter(f => f.endsWith('.html'))

for (const file of htmlFiles) {
  let html = await readFile(join(ROOT, file), 'utf-8')
  html = html.replace('./src/main.ts', '/' + jsFilename)
  html = html.replace('./src/styles.css', '/assets/styles.css')
  await writeFile(join(OUT, file), html)
}

// Generate Netlify clean URL redirects
const redirects = htmlFiles
  .filter(f => f !== 'index.html')
  .map(f => `/${f.replace('.html', '')} /${f} 200`)
  .join('\n')
await writeFile(join(OUT, '_redirects'), redirects + '\n')

console.log(`Built ${htmlFiles.length} pages → dist/`)
