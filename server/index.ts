import express from 'express'
import cors from 'cors'
import healthRouter from './routes/health.js'
import aiRouter from './routes/ai.js'

const app = express()
const PORT = 5174

app.use(cors())
app.use(express.json())

app.use('/api', healthRouter)
app.use('/api/ai', aiRouter)

app.listen(PORT, () => {
  console.log(`[server] Backend running at http://localhost:${PORT}`)
})

export default app
