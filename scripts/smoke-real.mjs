#!/usr/bin/env node
// Manual real-account harness. It is NOT part of `npm test` and it is NOT a test suite.
// See REAL-WORLD-TESTING.md. It sends one message to the account itself and exits.
import process from 'node:process'
import { useFileAuthState } from '../src/auth.js'
import { createClient } from '../src/client.js'

if (process.env.ZYRIX_SMOKE !== '1') {
  console.error('Refusing to touch a real account. Set ZYRIX_SMOKE=1 after reading REAL-WORLD-TESTING.md.')
  process.exit(2)
}

const session = process.env.ZYRIX_SMOKE_SESSION || '/tmp/zyrix-smoke'
const phoneNumber = process.env.ZYRIX_SMOKE_PHONE || undefined
const timeoutMs = Number(process.env.ZYRIX_SMOKE_TIMEOUT_MS || 180000)
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10000) {
  console.error('ZYRIX_SMOKE_TIMEOUT_MS must be an integer of at least 10000 ms.')
  process.exit(2)
}

const auth = useFileAuthState(session)
const sock = createClient({ auth, phoneNumber, printQRInTerminal: true })

const finish = async (code, message) => {
  clearTimeout(timer)
  if (message) (code === 0 ? console.log : console.error)(message)
  try { await sock.end() } catch {}
  process.exit(code)
}

const timer = setTimeout(() => {
  finish(1, `FAIL: no open connection after ${timeoutMs} ms`)
}, timeoutMs)
timer.unref?.()

sock.on('error', (error) => {
  console.error(`error: ${error?.errorCode || ''} ${error?.message || error}`)
})

sock.on('open', async () => {
  try {
    const me = sock.user
    if (!me?.id) return finish(1, 'FAIL: connected but creds.me is empty')
    console.log(`open as ${me.id}`)
    const sent = await sock.sendMessage(me.id, { text: `Zyrix smoke ${new Date().toISOString()}` }, { waitAck: true, ackTimeoutMs: 20000 })
    if (sent.status !== 'sent') return finish(1, `FAIL: self-send status ${sent.status}`)
    return finish(0, `PASS: connect + self-send ack (${sent.key.id})`)
  } catch (error) {
    return finish(1, `FAIL: ${error?.errorCode || ''} ${error?.message || error}`)
  }
})

sock.on('close', ({ reconnecting }) => {
  if (!reconnecting) finish(1, 'FAIL: connection closed before the self-send completed')
})
