import WebSocket from 'ws'
import { EventEmitter } from 'events'
import { ZyrixError, ErrorKind } from './errors.js'

const WA_URL = 'wss://web.whatsapp.com/ws/chat'
const WA_HEADER = Buffer.from([87, 65, 6, 3])
const MAX_FRAME_SIZE = 0xffffff
const MAX_BUFFER_SIZE = MAX_FRAME_SIZE * 2 + 6

class Transport extends EventEmitter {
  constructor() {
    super()
    this.ws = null
    this.buffer = Buffer.alloc(0)
    this.headerSent = false
    this.opened = false
    this.openTimer = null
    this.lastError = null
  }

  connect() {
    this.lastError = null
    this.ws = new WebSocket(WA_URL, {
      origin: 'https://web.whatsapp.com',
      handshakeTimeout: 20000,
      perMessageDeflate: true
    })
    this.openTimer = setTimeout(() => {
      if (!this.opened) {
        this.lastError = new ZyrixError('WebSocket did not open within 20 seconds; check the network, VPN, proxy or WebSocket blocking', { kind: ErrorKind.TIMEOUT, errorCode: 'WEBSOCKET_OPEN_TIMEOUT' })
        this.emit('error', this.lastError)
      }
      this.close()
    }, 20000)
    this.ws.on('open', () => {
      this.opened = true
      clearTimeout(this.openTimer)
      this.openTimer = null
      this.emit('open')
    })
    this.ws.on('close', (code, _reason) => {
      clearTimeout(this.openTimer)
      this.openTimer = null
      if (!this.opened && code === 1006 && !this.lastError) {
        this.lastError = new ZyrixError('WhatsApp closed the WebSocket before the handshake (code 1006); the pairing code could not be requested', { kind: ErrorKind.CLOSED, errorCode: 'WEBSOCKET_CLOSED_BEFORE_HANDSHAKE' })
        this.lastError.name = 'WebSocketHandshakeError'
        this.lastError.code = 1006
        this.emit('error', this.lastError)
      }
      this.emit('close', code)
    })
    this.ws.on('error', (err) => {
      this.lastError = err
      this.emit('error', err)
    })
    this.ws.on('message', (data) => {
      try {
        this.onData(Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data))
      } catch (err) {
        this.emit('error', err)
        this.close()
      }
    })
  }

  send(payload) {
    if (!Buffer.isBuffer(payload) && !(payload instanceof Uint8Array)) throw new TypeError('payload must be a Buffer or Uint8Array')
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new ZyrixError('the transport is not connected', { kind: ErrorKind.NOT_READY, errorCode: 'TRANSPORT_NOT_CONNECTED' })
    const len = payload.length
    if (len > MAX_FRAME_SIZE) throw new RangeError(`frame too large: ${len} bytes`)
    const prefix = Buffer.from([len >> 16, (len >> 8) & 255, len & 255])
    const parts = this.headerSent ? [prefix, payload] : [WA_HEADER, prefix, payload]
    this.ws.send(Buffer.concat(parts))
    this.headerSent = true
  }

  onData(chunk) {
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk)
    if (this.buffer.length + chunk.length > MAX_BUFFER_SIZE) throw new RangeError('transport buffer exceeds the allowed limit')
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (this.buffer.length >= 3) {
      const len = (this.buffer[0] << 16) | (this.buffer[1] << 8) | this.buffer[2]
      if (len > MAX_FRAME_SIZE) throw new RangeError(`received frame too large: ${len} bytes`)
      if (this.buffer.length < 3 + len) break
      const frame = this.buffer.subarray(3, 3 + len)
      this.buffer = this.buffer.subarray(3 + len)
      this.emit('frame', frame)
    }
  }

  close() {
    clearTimeout(this.openTimer)
    this.openTimer = null
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED && this.ws.readyState !== WebSocket.CLOSING) this.ws.close()
  }
}

export { Transport, WA_HEADER, MAX_FRAME_SIZE }
