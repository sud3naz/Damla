import { Networks } from '@stellar/stellar-sdk'

const env = process.env

export const NETWORKS = {
  testnet: {
    key: 'testnet',
    passphrase: Networks.TESTNET,
    horizon: env.DAMLA_TESTNET_HORIZON || 'https://horizon-testnet.stellar.org',
    friendbot: 'https://friendbot.stellar.org',
    usdc: { code: 'USDC', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
    explorer: 'https://stellar.expert/explorer/testnet',
    treasurySecret: env.DAMLA_TESTNET_TREASURY_SECRET || null,
    baseFee: 100,
    tickMs: 5000,
    maxAmount: 10000,
    enabled: true,
    channelFunding: '5', // XLM from the testnet treasury (friendbot only if no treasury is configured)
  },
  mainnet: {
    key: 'mainnet',
    passphrase: Networks.PUBLIC,
    horizon: env.DAMLA_MAINNET_HORIZON || 'https://horizon.stellar.org',
    friendbot: null,
    usdc: { code: 'USDC', issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' },
    explorer: 'https://stellar.expert/explorer/public',
    treasurySecret: env.DAMLA_MAINNET_TREASURY_SECRET || null,
    baseFee: 1000,
    tickMs: 30000,
    maxAmount: Number(env.DAMLA_MAINNET_MAX_AMOUNT || 250), // beta cap per purchase, bounds the "bad moment" risk
    enabled: env.DAMLA_MAINNET_ENABLED === '1', // key may be prepared before the treasury is funded
    channelFunding: '2.5', // XLM: 1 XLM base reserve + fees, merged back when the plan ends
  },
}

// period lengths in seconds. "minute" exists for testnet demos only.
export const PERIODS = {
  minute: { seconds: 60, label: 'every minute (demo)', testnetOnly: true },
  daily: { seconds: 86400, label: 'every day' },
  weekly: { seconds: 7 * 86400, label: 'every week' },
  monthly: { seconds: 30 * 86400, label: 'every 30 days' },
}

export const LIMITS = {
  minAmount: 1,
  maxAmount: 10000,
  minCount: 2,
  maxCount: 24,
  ceilings: [10, 25, 50], // percent above the price at signing after which a purchase is skipped
  draftTtlSeconds: 30 * 60,
  signingAllowanceSeconds: 60, // first window opens this long after the plan is built
}

export const SERVER = {
  host: env.HOST || '127.0.0.1',
  port: Number(env.PORT || 8944),
  dbPath: env.DAMLA_DB || './damla.db',
  serveStatic: env.DAMLA_SERVE_STATIC === '1',
  corsOrigins: (env.DAMLA_CORS || 'https://damla-lake.vercel.app,http://localhost:8944,http://127.0.0.1:8944')
    .split(',').map((s) => s.trim()).filter(Boolean),
}

export function enabledNetworks() {
  return Object.values(NETWORKS)
    .filter((n) => n.enabled && (n.friendbot || n.treasurySecret))
    .map((n) => n.key)
}
