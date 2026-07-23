import express, { Request, Response, Express } from "express"
import { env } from "./config/env.js"
import { createNodeMiddleware, Webhooks } from "@octokit/webhooks"

const webhooks = new Webhooks({ secret: env.GITHUB_WEBHOOK_SECRET })

const app: Express = express()

app.use(createNodeMiddleware(webhooks, {path: '/api/github/webhooks'}))
app.use(express.json())

app.use('/api/v1/inngest', () => {

})

app.get('/api/v1/health', (req: Request, res: Response) => {
    return res.status(200).json({
        status: 'ok'
    })
})

app.use((err:unknown, req: Request, res: Response) => {
    console.error("unhandled error ", err)
    res.status(500).json({
        message: 'internal server err'
    })
})

app.listen(env.PORT, () => {
    console.log('Server is live')
})

export { app }