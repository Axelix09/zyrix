import { ZyrixError, ErrorKind } from './errors.js'

// Minimal protobuf codec for the small Signal wire messages: varint (wire type 0)
// and length-delimited bytes (wire type 2) fields only.

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

const pbEncode = (fields) =>
  Buffer.concat(
    fields
      .filter(([, val]) => val !== undefined && val !== null)
      .map(([num, val]) =>
        typeof val === 'number'
          ? Buffer.concat([varint(num * 8), varint(val)])
          : Buffer.concat([varint(num * 8 + 2), varint(val.length), Buffer.from(val)])
      )
  )

const pbDecode = (buf, errorCode = 'PROTOBUF_MALFORMED') => {
  const fail = (message) => new ZyrixError(message, { kind: ErrorKind.DECRYPT, errorCode })
  const out = {}
  let i = 0
  const readVarint = () => {
    let r = 0
    let s = 1
    for (let count = 0; count < 10; count++) {
      const b = buf[i++]
      if (b === undefined) throw fail('truncated protobuf')
      r += (b & 127) * s
      if (!(b & 128)) {
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
