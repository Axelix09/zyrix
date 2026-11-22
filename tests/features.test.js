import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import features from '../src/features.js'
import { makeState } from './helpers/state.js'

const make = () => {
  const state = makeState()
  state.creds.me = { id: '5491100000001:3@s.whatsapp.net', lid: '777@lid', name: 'Yo' }
  const sent = []
  const queries = []
  const sock = Object.assign(new EventEmitter(), features, {
    auth: { state, save() { this.saved = (this.saved || 0) + 1 } },
    groupCache: new Map(),
    readReceiptCache: undefined,
    autoRejectCalls: false,
    prefix: 'p',
    counter: 0,
    deviceCache: new Map(),
    sendNode: (node) => { sent.push(node) },
    query: async (node) => { queries.push(node); return {} },
    appStatePatch: async (patch) => { sock.patch = patch; return 'patched' },
    ensurePreKeys: async () => { sock.ensured = true },
    syncAppState: async () => {}
  })
  return { sock, sent, queries, state }
}

test('features: sendReceipt agrupa ids y usa recipient en receipts de sender', async () => {
  const { sock, sent } = make()
  await sock.sendReceipt('123@s.whatsapp.net', '456@s.whatsapp.net', ['a', 'b'], 'read')
  assert.equal(sent[0].attrs.to, '123@s.whatsapp.net')
  assert.equal(sent[0].attrs.type, 'read')
  assert.ok(sent[0].attrs.t)
  assert.equal(sent[0].content[0].tag, 'list')
  assert.equal(sent[0].content[0].content.length, 1)

  await sock.sendReceipt('123@s.whatsapp.net', '456@s.whatsapp.net', ['a'], 'sender')
  assert.equal(sent[1].attrs.recipient, '123@s.whatsapp.net')
  assert.equal(sent[1].attrs.to, '456@s.whatsapp.net')

  await assert.rejects(sock.sendReceipt('1@s.whatsapp.net', null, [], 'read'), TypeError)
})

test('features: readReceiptType usa caché y privacidad, y readMessages agrupa por chat', async () => {
  const { sock, sent } = make()
  sock.readReceiptCache = { type: 'read-self', at: Date.now() }
  assert.equal(await sock.readReceiptType(), 'read-self')

  sock.readReceiptCache = undefined
  sock.fetchPrivacySettings = async () => ({ readreceipts: 'none' })
  assert.equal(await sock.readReceiptType(), 'read-self')
  assert.equal(sock.readReceiptCache.type, 'read-self')

  sock.fetchPrivacySettings = async () => ({ readreceipts: 'all' })
  sock.readReceiptCache = undefined
  assert.equal(await sock.readReceiptType(), 'read')

  sock.fetchPrivacySettings = async () => { throw new Error('sin red') }
  sock.readReceiptCache = undefined
  assert.equal(await sock.readReceiptType(), 'read')
  sock.readReceiptCache = { type: 'read-self', at: Date.now() }
  assert.equal(await sock.readReceiptType(), 'read-self')

  await assert.rejects(sock.readMessages([]), TypeError)
  sock.readReceiptType = async () => 'read'
  await sock.readMessages([
    { remoteJid: 'a@s.whatsapp.net', id: '1', fromMe: false },
    { remoteJid: 'a@s.whatsapp.net', id: '2', fromMe: false, participant: 'p' },
    { remoteJid: 'a@s.whatsapp.net', id: 'self', fromMe: true },
    null
  ])
  assert.equal(sent.length, 2)
})

test('features: presencia disponible, composing, recording y paused', () => {
  const { sock, sent } = make()
  sock.sendPresenceUpdate('available')
  assert.equal(sent[0].tag, 'presence')
  sock.sendPresenceUpdate('unavailable')
  assert.equal(sent[1].attrs.type, 'unavailable')
  sock.sendPresenceUpdate('composing', '123')
  assert.equal(sent[2].tag, 'chatstate')
  assert.equal(sent[2].content[0].tag, 'composing')
  sock.sendPresenceUpdate('recording', '123')
  assert.equal(sent[3].content[0].attrs.media, 'audio')
  sock.sendPresenceUpdate('paused', '123')
  assert.equal(sent[4].content[0].tag, 'paused')
  assert.throws(() => sock.sendPresenceUpdate('nope'), TypeError)
  assert.throws(() => sock.sendPresenceUpdate('composing'), TypeError)
  sock.presenceSubscribe('123')
  assert.equal(sent[5].attrs.type, 'subscribe')
})

test('features: rejectCall exige sesión registrada y consulta con el call-id', async () => {
  const { sock, queries, state } = make()
  await sock.rejectCall('call-1', 'a@s.whatsapp.net')
  assert.equal(queries[0].tag, 'call')
  assert.equal(queries[0].content[0].attrs['call-id'], 'call-1')
  state.creds.me = null
  await assert.rejects(sock.rejectCall('x', 'y'), { errorCode: 'SESSION_NOT_REGISTERED' })
})

test('features: onWhatsApp normaliza números, mapea LID y guarda identidades', async () => {
  const { sock, state } = make()
  sock.query = async () => ({
    tag: 'iq',
    content: [{
      tag: 'usync',
      content: [{
        tag: 'list',
        content: [
          { tag: 'user', attrs: { jid: '5491100000002@s.whatsapp.net' }, content: [
            { tag: 'contact', attrs: { type: 'in' } },
            { tag: 'lid', attrs: { val: '888@lid' } }
          ] },
          { tag: 'user', attrs: { jid: '5491100000003@s.whatsapp.net' }, content: [{ tag: 'contact', attrs: { type: 'out' } }] },
          { tag: 'user', attrs: {}, content: [] }
        ]
      }]
    }]
  })
  const results = await sock.onWhatsApp(['+54 911 0000-0002'], '5491100000003')
  assert.deepEqual(results.map((r) => [r.jid, r.exists, r.lid]), [
    ['5491100000002@s.whatsapp.net', true, '888@lid'],
    ['5491100000003@s.whatsapp.net', false, undefined]
  ])
  assert.equal(sock.auth.saved, 1)
  assert.equal(await sock.resolveJid?.call(sock, '888@lid'), undefined)
  assert.ok(state)
  await assert.rejects(sock.onWhatsApp(), TypeError)
})

test('features: chatModify construye el patch correcto y rechaza modificaciones inválidas', async () => {
  const { sock } = make()
  for (const [name, value] of [['pin', true], ['mute', 123], ['mute', null], ['archive', true], ['markRead', false]]) {
    await sock.chatModify({ [name]: value }, '123')
    assert.equal(sock.patch.index[0], { pin: 'pin_v1', mute: 'mute', archive: 'archive', markRead: 'markChatAsRead' }[name])
  }
  await assert.rejects(sock.chatModify({}, '123'), TypeError)
  await assert.rejects(sock.chatModify({ a: 1, b: 2 }, '123'), TypeError)
  await assert.rejects(sock.chatModify({ nope: 1 }, '123'), TypeError)
})

test('features: onCall cubre offer, terminate, reject, accept y ringing', () => {
  const { sock } = make()
  const calls = []
  sock.on('call', (c) => calls.push(c))
  sock.onCall({ tag: 'call', attrs: { from: 'chat' }, content: [{ tag: 'offer', attrs: { 'call-id': '1', 'call-creator': 'a', type: 'group', 'group-jid': 'g@g.us' }, content: [{ tag: 'video', attrs: {} }] }] })
  assert.equal(calls[0].status, 'offer')
  assert.equal(calls[0].isVideo, true)
  assert.equal(calls[0].isGroup, true)
  sock.onCall({ tag: 'call', attrs: { from: 'chat' }, content: [{ tag: 'terminate', attrs: { reason: 'timeout', 'call-id': '2' } }] })
  assert.equal(calls[1].status, 'timeout')
  sock.onCall({ tag: 'call', attrs: { from: 'chat' }, content: [{ tag: 'terminate', attrs: { reason: 'x' } }] })
  assert.equal(calls[2].status, 'terminate')
  sock.onCall({ tag: 'call', attrs: { from: 'chat' }, content: [{ tag: 'reject', attrs: {} }] })
  assert.equal(calls[3].status, 'reject')
  sock.onCall({ tag: 'call', attrs: { from: 'chat' }, content: [{ tag: 'accept', attrs: {} }] })
  assert.equal(calls[4].status, 'accept')
  sock.onCall({ tag: 'call', attrs: { from: 'chat' }, content: [{ tag: 'ringing', attrs: {} }] })
  assert.equal(calls[5].status, 'ringing')
  sock.onCall({ tag: 'call', attrs: { from: 'chat' }, content: [] })

  sock.autoRejectCalls = true
  sock.rejectCall = async (id, from) => { sock.rejected = [id, from] }
  sock.onCall({ tag: 'call', attrs: { from: 'chat' }, content: [{ tag: 'offer', attrs: { 'call-id': '9', 'call-creator': 'a' } }] })
  assert.deepEqual(sock.rejected, ['9', 'a'])
})

test('features: presencia, chatstate y devices se emiten o ignoran según los attrs', () => {
  const { sock } = make()
  const updates = []
  sock.on('presence.update', (u) => updates.push(u))
  sock.onPresenceNode({ attrs: { from: 'a', type: 'unavailable', last: '100' } })
  assert.equal(updates[0].presences.a.lastKnownPresence, 'unavailable')
  assert.equal(updates[0].presences.a.lastSeen, 100)
  sock.onPresenceNode({ attrs: { from: 'a', type: 'available', last: 'deny' } })
  assert.equal(updates[1].presences.a.lastSeen, undefined)
  sock.onPresenceNode({ attrs: { from: 'a', type: 'subscribe' } })
  sock.onPresenceNode({ attrs: {} })
  sock.onChatState({ attrs: { from: 'a' }, content: [] })
  sock.onChatState({ attrs: { from: 'a', participant: 'p' }, content: [{ tag: 'composing', attrs: { media: 'audio' } }] })
  assert.equal(updates[2].presences.p.lastKnownPresence, 'recording')
  sock.onChatState({ attrs: { from: 'a' }, content: [{ tag: 'paused', attrs: {} }] })
  assert.equal(updates[3].presences.a.lastKnownPresence, 'paused')
  sock.onChatState({ attrs: { from: 'a' }, content: [{ tag: 'otro', attrs: {} }] })
  sock.onDevicesNotification({ attrs: {} })
  sock.deviceCache.set('a@s.whatsapp.net', [1])
  sock.onDevicesNotification({ attrs: { from: 'a:2@s.whatsapp.net' } })
  assert.equal(sock.deviceCache.get('a@s.whatsapp.net'), undefined)
})

test('features: encrypt notification borra sesiones o asegura prekeys', async () => {
  const { sock, state } = make()
  const changes = []
  sock.on('identity.changed', (e) => changes.push(e))
  sock.onEncryptNotification({ attrs: { from: '5491100000002@s.whatsapp.net' }, content: [{ tag: 'identity', attrs: {} }] })
  assert.equal(changes.length, 1)
  assert.equal(sock.auth.saved, 1)
  await sock.onEncryptNotification({ attrs: { from: '5491100000002@s.whatsapp.net' }, content: [] })
  assert.equal(sock.ensured, true)
  state.creds.me = null
})

test('features: onIb responde offline y limpia colecciones dirty', () => {
  const { sock, sent } = make()
  sock.groupCache.set('g@g.us', {})
  sock.onIb({ content: [{ tag: 'offline_preview', attrs: {} }, { tag: 'dirty', attrs: { type: 'groups', timestamp: '7' } }, { tag: 'dirty', attrs: { type: 'account_sync' } }] })
  assert.equal(sent[0].tag, 'ib')
  assert.equal(sock.groupCache.size, 0)
})

test('features: onGroupNotification actualiza subject, descripción y ajustes', () => {
  const { sock } = make()
  const updates = []
  sock.on('groups.update', (u) => updates.push(...u))
  sock.onGroupNotification({
    tag: 'notification', attrs: { from: 'g@g.us', participant: 'a', t: '10', offline: '' },
    content: [
      { tag: 'subject', attrs: { subject: 'Nuevo', s_o: 'a', s_t: '5' } },
      { tag: 'description', attrs: { id: 'd1' }, content: [{ tag: 'body', attrs: {}, content: 'detalle' }] },
      { tag: 'description', attrs: { id: 'd2', delete: 'true' } },
      { tag: 'announcement', attrs: {} },
      { tag: 'not_announcement', attrs: {} },
      { tag: 'locked', attrs: {} },
      { tag: 'unlocked', attrs: {} },
      { tag: 'ephemeral', attrs: { expiration: '86400' } },
      { tag: 'not_ephemeral', attrs: {} },
      { tag: 'membership_approval_mode', attrs: {}, content: [{ tag: 'group_join', attrs: { state: 'on' } }] },
      { tag: 'member_add_mode', attrs: {}, content: 'all_member_add' },
      { tag: 'ignorado', attrs: {} }
    ]
  })
  assert.equal(updates[0].subject, 'Nuevo')
  assert.equal(updates[1].desc, 'detalle')
  assert.equal(updates[2].desc, undefined)
  assert.equal(updates[3].announce, true)
  assert.equal(updates[4].announce, false)
  assert.equal(updates[5].restrict, true)
  assert.equal(updates[6].restrict, false)
  assert.equal(updates[7].ephemeralDuration, 86400)
  assert.equal(updates[8].ephemeralDuration, 0)
  assert.equal(updates[9].joinApprovalMode, true)
  assert.equal(updates[10].memberAddMode, true)

  sock.onGroupNotification({ attrs: { from: 'no-group' }, content: [] })
  sock.onGroupNotification({ attrs: {}, content: [] })
})
