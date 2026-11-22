import { ZyrixError, ErrorKind } from './errors.js'

// Minimal protobuf codec for the small Signal wire messages: varint (wire type 0)
// and length-delimited bytes (wire type 2) fields only.

const MAX_FIELD_NUMBER = 536870911
const MAX_MESSAGE_BYTES = 1024 * 1024

const assertField = (field, fail) => {
  if (!Number.isSafeInteger(field) || field < 1 || field > MAX_FIELD_NUMBER) throw fail(`invalid protobuf field number: ${String(field)}`)
}

const varint = (n) => {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('protobuf varint must be a non-negative safe integer')
  const out = []
  while (n > 127) {
    out.push((n % 128) | 128)
    n = Math.floor(n / 128)
  }
  out.push(n)
  return Buffer.from(out)
}

const pbEncode = (fields) => {
  const seen = new Set()
  return Buffer.concat(
    fields
      .filter(([, val]) => val !== undefined && val !== null)
      .map(([num, val]) => {
        if (!Number.isSafeInteger(num) || num < 1 || num > MAX_FIELD_NUMBER) throw new RangeError(`invalid protobuf field number: ${String(num)}`)
        if (seen.has(num)) throw new RangeError(`duplicate protobuf field number: ${num}`)
        seen.add(num)
        return typeof val === 'number'
          ? Buffer.concat([varint(num * 8), varint(val)])
          : Buffer.concat([varint(num * 8 + 2), varint(val.length), Buffer.from(val)])
      })
  )
}

// Reglas explícitas: se rechazan el field 0, números fuera de rango, varints no canónicos
// (sobrecodificados) y campos duplicados. Aceptarlos en silencio permitiría dos parsers
// distintos del mismo byte stream, que es justo cómo se cuelan discrepancias de protocolo.
const pbDecode = (buf, errorCode = 'PROTOBUF_MALFORMED') => {
  const fail = (message) => new ZyrixError(message, { kind: ErrorKind.DECRYPT, errorCode })
  if (!Buffer.isBuffer(buf) && !(buf instanceof Uint8Array)) throw fail('protobuf input must be bytes')
  buf = Buffer.from(buf)
  if (buf.length === 0) throw fail('empty protobuf message')
  if (buf.length > MAX_MESSAGE_BYTES) throw fail(`protobuf message exceeds ${MAX_MESSAGE_BYTES} bytes`)
  const out = {}
  const seen = new Set()
  let i = 0
  const readVarint = () => {
    let r = 0
    let s = 1
    for (let count = 0; count < 10; count++) {
      const b = buf[i++]
      if (b === undefined) throw fail('truncated protobuf')
      r += (b & 127) * s
      if (!(b & 128)) {
        if (count > 0 && b === 0) throw fail('non-canonical varint')
        if (!Number.isSafeInteger(r)) throw fail('protobuf varint too large')
        return r
      }
      s *= 128
    }
    throw fail('varint too long')
  }
  while (i < buf.length) {
    const tag = readVarint()
    const field = Math.floor(tag / 8)
    const wire = tag % 8
    assertField(field, fail)
    if (seen.has(field)) throw fail(`duplicate protobuf field: ${field}`)
    seen.add(field)
    if (wire === 0) out[field] = readVarint()
    else if (wire === 2) {
      const len = readVarint()
      if (len > buf.length - i) throw fail('truncated protobuf field')
      out[field] = Buffer.from(buf.subarray(i, i + len))
      i += len
    } else throw fail('unsupported wire type')
  }
  return out
}

export { varint, pbEncode, pbDecode }
