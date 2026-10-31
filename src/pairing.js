import crypto from 'crypto'
import { Curve, hkdf, gcmEncrypt, aesCtr, pbkdf2 } from './crypto.js'
import { getChild, jidEncode } from './binary.js'
import { S_WHATSAPP_NET as S } from './util.js'

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTVWXYZ'
const ITERATIONS = 2 << 16
const PAIRING_PLATFORMS = {
  Chrome: { id: '1', name: 'Chrome' },
  Firefox: { id: '2', name: 'Firefox' },
  IE: { id: '3', name: 'IE' },
  Opera: { id: '4', name: 'Opera' },
  Safari: { id: '5', name: 'Safari' },
  Edge: { id: '6', name: 'Edge' }
}
const PAIRING_OS = new Set(['Mac OS', 'Windows', 'Ubuntu'])
const pairingPlatform = (browser = ['Mac OS', 'Chrome']) => {
  const os = PAIRING_OS.has(browser[0]) ? browser[0] : 'Mac OS'
  const platform = PAIRING_PLATFORMS[browser[1]] || PAIRING_PLATFORMS.Chrome
  return { id: platform.id, display: `${platform.name} (${os})` }
}

const toCrockford = (buf) => {
  let value = 0
  let bits = 0
  let out = ''
  for (const b of buf) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
    value &= (1 << bits) - 1
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

export default {
  async requestPairingCode(phone) {
    const { creds } = this.auth.state
    const number = String(phone).replace(/\D/g, '')
    creds.pairingCode = toCrockford(crypto.randomBytes(5))
    const jid = jidEncode(number, S)
    const salt = crypto.randomBytes(32)
    const iv = crypto.randomBytes(16)
    const key = pbkdf2(Buffer.from(creds.pairingCode), salt, ITERATIONS, 32)
    const wrapped = Buffer.concat([salt, iv, aesCtr(creds.pairingEphemeralKeyPair.public, key, iv)])
    const browser = this.browser || ['Ubuntu', 'Chrome', '22.04.4']
    const platform = pairingPlatform(browser)
    try {
      await this.query({
        tag: 'iq',
        attrs: { to: S, type: 'set', xmlns: 'md' },
        content: [{
          tag: 'link_code_companion_reg',
          attrs: { jid, stage: 'companion_hello', should_show_push_notification: 'true' },
          content: [
            { tag: 'link_code_pairing_wrapped_companion_ephemeral_pub', attrs: {}, content: wrapped },
            { tag: 'companion_server_auth_key_pub', attrs: {}, content: creds.noiseKey.public },
            { tag: 'companion_platform_id', attrs: {}, content: platform.id },
            { tag: 'companion_platform_display', attrs: {}, content: platform.display },
            { tag: 'link_code_pairing_nonce', attrs: {}, content: '0' }
          ]
        }]
      })
    } catch (error) {
      if (!creds.registered) delete creds.pairingCode
      throw error
    }
    creds.me = { id: jid, name: '~' }
    this.pairingMode = true
    this.auth.save()
    return creds.pairingCode
  },

  async onLinkCode(node) {
    const reg = getChild(node, 'link_code_companion_reg')
    const { creds } = this.auth.state
    if (!reg || !creds.pairingCode) return
    const ref = getChild(reg, 'link_code_pairing_ref').content
    const primaryIdentity = getChild(reg, 'primary_identity_pub').content
    const wrapped = getChild(reg, 'link_code_pairing_wrapped_primary_ephemeral_pub').content
    const unwrapKey = pbkdf2(Buffer.from(creds.pairingCode), wrapped.subarray(0, 32), ITERATIONS, 32)
    const primaryEphemeral = aesCtr(wrapped.subarray(48), unwrapKey, wrapped.subarray(32, 48))
    const companionShared = Curve.sharedKey(creds.pairingEphemeralKeyPair.private, primaryEphemeral)
    const random = crypto.randomBytes(32)
    const bundleSalt = crypto.randomBytes(32)
    const bundleKey = hkdf(companionShared, 32, bundleSalt, 'link_code_pairing_key_bundle_encryption_key')
    const bundleIv = crypto.randomBytes(12)
    const encrypted = gcmEncrypt(
      Buffer.concat([creds.signedIdentityKey.public, primaryIdentity, random]),
      bundleKey,
      bundleIv,
      Buffer.alloc(0)
    )
    const identityShared = Curve.sharedKey(creds.signedIdentityKey.private, primaryIdentity)
    creds.advSecretKey = hkdf(Buffer.concat([companionShared, identityShared, random]), 32, null, 'adv_secret').toString('base64')
    this.auth.save()
    const finish = {
      tag: 'iq',
      attrs: { to: S, type: 'set', id: `${this.prefix}-${++this.counter}`, xmlns: 'md' },
      content: [
        {
          tag: 'link_code_companion_reg',
          attrs: { jid: creds.me.id, stage: 'companion_finish' },
          content: [
            { tag: 'link_code_pairing_wrapped_key_bundle', attrs: {}, content: Buffer.concat([bundleSalt, bundleIv, encrypted]) },
            { tag: 'companion_identity_public', attrs: {}, content: creds.signedIdentityKey.public },
            { tag: 'link_code_pairing_ref', attrs: {}, content: ref }
          ]
        }
      ]
    }
    if (typeof this.query === 'function') await this.query(finish)
    else this.sendNode(finish)
  }
}
