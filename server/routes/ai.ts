import { Router, Request, Response } from 'express'
import { readConfig, writeConfig } from '../services/configService.js'
import { processAIMessage } from '../services/aiService.js'

const router = Router()

// GET /api/ai/settings
router.get('/settings', (_req: Request, res: Response) => {
  const config = readConfig()
  res.json({
    endpoint: config.endpoint,
    model: config.model,
    provider: config.provider,
    hasApiKey: Boolean(config.apiKey),
  })
})

// PUT /api/ai/settings
router.put('/settings', (req: Request, res: Response) => {
  const { endpoint, apiKey, model } = req.body as {
    endpoint?: string
    apiKey?: string
    model?: string
  }
  const updated = writeConfig({ endpoint, apiKey, model })
  res.json({
    success: true,
    endpoint: updated.endpoint,
    model: updated.model,
    provider: updated.provider,
    hasApiKey: Boolean(updated.apiKey),
  })
})

// POST /api/ai/chat
router.post('/chat', async (req: Request, res: Response) => {
  const { message, context } = req.body as {
    message: string
    context?: Record<string, unknown>
  }
  if (!message) {
    res.status(400).json({ error: 'message is required' })
    return
  }
  const result = await processAIMessage(message, context ?? {})
  res.json(result)
})

export default router
