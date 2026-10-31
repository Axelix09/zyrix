import WebSocket from 'ws'
import { EventEmitter } from 'events'

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
        this.lastError = new Error('WebSocket no abrió en 20 segundos; comprueba la red, VPN, proxy o bloqueo de WebSocket')
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
    this.ws.on('close', (code, reason) => {
      clearTimeout(this.openTimer)
      this.openTimer = null
      if (!this.opened && code === 1006 && !this.lastError) {
        this.lastError = new Error('WhatsApp cerró el WebSocket antes del handshake (código 1006); no se pudo solicitar el código de emparejamiento')
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
    if (!Buffer.isBuffer(payload) && !(payload instanceof Uint8Array)) throw new TypeError('payload debe ser un Buffer o Uint8Array')
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('el transporte no está conectado')
    const len = payload.length
    if (len > MAX_FRAME_SIZE) throw new RangeError(`frame demasiado grande: ${len} bytes`)
    const prefix = Buffer.from([len >> 16, (len >> 8) & 255, len & 255])
    const parts = this.headerSent ? [prefix, payload] : [WA_HEADER, prefix, payload]
    this.ws.send(Buffer.concat(parts))
    this.headerSent = true
  }

  onData(chunk) {
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk)
    if (this.buffer.length + chunk.length > MAX_BUFFER_SIZE) throw new RangeError('buffer del transporte excede el límite permitido')
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (this.buffer.length >= 3) {
      const len = (this.buffer[0] << 16) | (this.buffer[1] << 8) | this.buffer[2]
      if (len > MAX_FRAME_SIZE) throw new RangeError(`frame recibido demasiado grande: ${len} bytes`)
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
