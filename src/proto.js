import * as ns from '@wppconnect/wa-proto'
import { ZyrixError, ErrorKind } from './errors.js'

const waproto = ns.waproto || (ns.default && ns.default.waproto)

if (!waproto || !waproto.Message || !waproto.HandshakeMessage) {
  throw new ZyrixError('the @wppconnect/wa-proto dependency does not expose the schema Zyrix needs', { kind: ErrorKind.INVALID, errorCode: 'PROTO_SCHEMA_MISSING' })
}

export const proto = waproto
