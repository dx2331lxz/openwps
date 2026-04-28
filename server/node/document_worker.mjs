#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const generatedWorker = resolve(here, '.generated/server/node/document_worker.js')

if (!existsSync(generatedWorker)) {
  process.stderr.write('Generated document worker is missing. Run `npm run build:worker` first.\n')
  process.exit(1)
}

await import(generatedWorker)
