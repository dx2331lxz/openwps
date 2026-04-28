#!/usr/bin/env node
// @ts-nocheck
import { executeDocumentToolCore, fail } from '../../src/shared/document/tools.js'

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  input += chunk
})
process.stdin.on('end', async () => {
  try {
    const request = JSON.parse(input || '{}')
    process.stdout.write(JSON.stringify(await executeDocumentToolCore(request)))
  } catch (error) {
    process.stdout.write(JSON.stringify(fail(error instanceof Error ? error.message : String(error))))
  }
})
