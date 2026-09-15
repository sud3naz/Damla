import { resolve } from 'node:path'
import { LIMITS, NETWORKS, SERVER, enabledNetworks } from './config.js'
import { openDb } from './db.js'
import { createServer } from './server.js'
import { createTrigger } from './trigger.js'

const db = openDb(SERVER.dbPath)
const webRoot = SERVER.serveStatic ? resolve(process.cwd()) : null
const app = createServer(db, { webRoot })
const trigger = createTrigger(db)

const nets = enabledNetworks()
const tickMs = Math.min(...nets.map((k) => NETWORKS[k].tickMs))
trigger.start(tickMs, LIMITS.draftTtlSeconds)

app.listen(SERVER.port, SERVER.host, () => {
  console.log(`damla api on http://${SERVER.host}:${SERVER.port} networks=${nets.join(',')} tick=${tickMs}ms db=${SERVER.dbPath}${webRoot ? ' static=' + webRoot : ''}`)
})

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { trigger.stop(); app.close(); db.close(); process.exit(0) })
