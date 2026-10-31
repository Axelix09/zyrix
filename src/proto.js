import * as ns from '@wppconnect/wa-proto'

const waproto = ns.waproto || (ns.default && ns.default.waproto)

if (!waproto || !waproto.Message || !waproto.HandshakeMessage) {
  throw new Error('La dependencia @wppconnect/wa-proto no expone el esquema requerido por Zyrix')
}

export const proto = waproto
