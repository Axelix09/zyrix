import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import groups from '../src/messages/groups.js'
import { makeState } from './helpers/state.js'

const GROUP = '120363000000000001@g.us'

const metadataNode = () => ({
  tag: 'group',
  attrs: {
    id: GROUP,
    subject: 'Equipo',
    creator: '5491100000001@s.whatsapp.net',
    creator_lid: '777@lid',
    announce: 'true',
    restrict: 'false',
    member_add_mode: 'all_member_add',
    addressing_mode: 'lid'
  },
  content: [
    { tag: 'description', attrs: { id: 'd1' }, content: [{ tag: 'body', attrs: {}, content: 'desc' }] },
    { tag: 'ephemeral', attrs: { expiration: '3600' } },
    { tag: 'participant', attrs: { jid: '5491100000001@s.whatsapp.net', type: 'superadmin', notify: 'Yo' } },
    { tag: 'participant', attrs: { lid: '888@lid', phone_number: '5491100000002@s.whatsapp.net', type: 'admin' } },
    { tag: 'participant', attrs: {} }
  ]
})

const make = (responder = () => ({ tag: 'iq', attrs: { type: 'result' } })) => {
  const state = makeState()
  state.creds.me = { id: '5491100000001:3@s.whatsapp.net', lid: '777@lid' }
  const queries = []
  const sock = Object.assign(new EventEmitter(), groups, {
    auth: { state, save() {} },
    groupCache: new Map(),
    query: async (node) => { queries.push(node); return responder(node) }
  })
  return { sock, queries, state }
}

test('groups: groupCreate valida y devuelve id, limpiando la caché', async () => {
  const { sock } = make(() => ({ tag: 'iq', content: [{ tag: 'group', attrs: { id: GROUP } }] }))
  sock.groupCache.set(GROUP, {})
  const result = await sock.groupCreate('Equipo', ['5491100000002'])
  assert.deepEqual(result, { id: GROUP, gid: GROUP, subject: 'Equipo' })
  assert.equal(sock.groupCache.has(GROUP), false)
  await assert.rejects(sock.groupCreate('  '), TypeError)
  await assert.rejects(sock.groupCreate('x', 'no'), TypeError)
  const broken = make(() => ({ tag: 'iq', content: [] })).sock
  await assert.rejects(broken.groupCreate('x'), { errorCode: 'GROUP_RESPONSE_INVALID' })
})

test('groups: metadata parsea participantes, owner, ephemeral y addressing mode', async () => {
  let calls = 0
  const { sock } = make(() => { calls++; return { tag: 'iq', content: [metadataNode()] } })
  const meta = await sock.groupMetadata(GROUP)
  assert.equal(meta.subject, 'Equipo')
  assert.equal(meta.desc, 'desc')
  assert.equal(meta.descId, 'd1')
  assert.equal(meta.announce, true)
  assert.equal(meta.restrict, false)
  assert.equal(meta.memberAddMode, true)
  assert.equal(meta.ephemeralDuration, 3600)
  assert.equal(meta.addressingMode, 'lid')
  assert.equal(meta.owner, '5491100000001@s.whatsapp.net')
  assert.equal(meta.participants.length, 2)
  assert.equal(meta.participants[0].isOwner, true)
  assert.equal(meta.participants[0].admin, 'superadmin')
  assert.equal(meta.participants[1].lid, '888@lid')
  assert.equal(meta.participants[1].jid, '5491100000002@s.whatsapp.net')
  await sock.groupMetadata(GROUP)
  assert.equal(calls, 1, 'usa la caché')

  const broken = make(() => ({ tag: 'iq', content: [] })).sock
  await assert.rejects(broken.groupMetadata(GROUP), { errorCode: 'GROUP_RESPONSE_INVALID' })
})

test('groups: consultas de participantes y administradores', async () => {
  const { sock } = make(() => ({ tag: 'iq', content: [metadataNode()] }))
  const participant = await sock.getGroupParticipant(GROUP, '5491100000002@s.whatsapp.net')
  assert.equal(participant.lid, '888@lid')
  assert.equal(await sock.getGroupParticipant(GROUP, '5491199999999@s.whatsapp.net'), undefined)
  assert.equal(await sock.isGroupAdmin(GROUP, '5491100000002@s.whatsapp.net'), true)
  assert.equal(await sock.isGroupAdmin(GROUP, '5491199999999@s.whatsapp.net'), false)
  const admins = await sock.getGroupAdmins(GROUP)
  assert.equal(admins.length, 2)
  await assert.rejects(sock.getGroupParticipant('no', 'x'), TypeError)
})

test('groups: actualizaciones de participantes, subject, descripción y ajustes', async () => {
  const { sock, queries } = make((node) => {
    if (node.content?.[0]?.tag === 'query') return { tag: 'iq', content: [metadataNode()] }
    if (node.content?.[0]?.tag === 'add' || node.content?.[0]?.tag === 'remove') {
      return { tag: 'iq', content: [{ tag: 'add', content: [{ tag: 'participant', attrs: { jid: '5491100000002@s.whatsapp.net', error: '409' } }] }] }
    }
    return { tag: 'iq', attrs: { type: 'result' } }
  })
  sock.groupCache.set(GROUP, {})
  const result = await sock.groupParticipantsUpdate(GROUP, ['5491100000002'], 'add')
  assert.equal(result[0].error, '409')
  await assert.rejects(sock.groupParticipantsUpdate('no', ['x'], 'add'), TypeError)
  await assert.rejects(sock.groupParticipantsUpdate(GROUP, ['x'], 'nope'), TypeError)
  await assert.rejects(sock.groupParticipantsUpdate(GROUP, [], 'add'), TypeError)

  sock.groupCache.set(GROUP, {})
  await sock.groupUpdateSubject(GROUP, 'Otro')
  assert.equal(queries.at(-1).content[0].tag, 'subject')
  await assert.rejects(sock.groupUpdateSubject('no', 'x'), TypeError)
  await assert.rejects(sock.groupUpdateSubject(GROUP, ' '), TypeError)

  sock.groupCache.delete(GROUP)
  await sock.groupUpdateDescription(GROUP, 'nueva')
  assert.equal(queries.at(-1).content[0].attrs.prev, 'd1')
  await sock.groupUpdateDescription(GROUP, '')
  assert.equal(queries.at(-1).content[0].attrs.delete, 'true')
  await assert.rejects(sock.groupUpdateDescription(GROUP, 1), TypeError)

  for (const setting of ['announcement', 'not_announcement', 'locked', 'unlocked']) {
    await sock.groupSettingUpdate(GROUP, setting)
    assert.equal(queries.at(-1).content[0].tag, setting)
  }
  await assert.rejects(sock.groupSettingUpdate(GROUP, 'nope'), TypeError)
  await assert.rejects(sock.groupSettingUpdate('no', 'locked'), TypeError)

  await sock.groupLeave(GROUP)
  assert.equal(queries.at(-1).content[0].tag, 'leave')
  await assert.rejects(sock.groupLeave('no'), TypeError)
})

test('groups: invitaciones (código, revoke, accept, info y V4)', async () => {
  const { sock, queries } = make((node) => {
    const tag = node.content?.[0]?.tag
    if (tag === 'invite' && node.attrs.type === 'get') return { tag: 'iq', content: [{ tag: 'invite', attrs: { code: 'ABC' } }] }
    if (tag === 'invite') return { tag: 'iq', content: [{ tag: 'invite', attrs: {}, content: 'XYZ' }] }
    if (tag === 'participating') {
      return { tag: 'iq', content: [{ tag: 'groups', content: [{ ...metadataNode(), attrs: { ...metadataNode().attrs, id: 'g2@g.us' } }] }] }
    }
    if (tag === 'accept') return { tag: 'iq', content: [{ tag: 'group', attrs: { jid: 'joined@g.us' } }] }
    if (tag === 'invite' || node.attrs.type === 'set') return { tag: 'iq', content: [{ tag: 'group', attrs: { jid: 'joined@g.us' } }] }
    return { tag: 'iq', content: [] }
  })
  assert.equal(await sock.groupInviteCode(GROUP), 'ABC')
  assert.equal(await sock.groupRevokeInvite(GROUP), 'XYZ')
  sock.query = async () => ({ tag: 'iq', content: [{ tag: 'group', attrs: { jid: 'joined@g.us' } }] })
  assert.equal(await sock.groupAcceptInvite('https://chat.whatsapp.com/CODE'), 'joined@g.us')
  assert.equal(await sock.groupAcceptInvite('CODE'), 'joined@g.us')
  assert.equal(await sock.groupAcceptInviteV4('admin@s.whatsapp.net', { groupJid: GROUP, inviteCode: 'C', inviteExpiration: 10 }), 'joined@g.us')
  assert.equal(await sock.groupAcceptInviteV4({ remoteJid: 'admin@s.whatsapp.net' }, { groupJid: GROUP, inviteCode: 'C' }), 'joined@g.us')
  await assert.rejects(sock.groupAcceptInvite(' '), TypeError)
  await assert.rejects(sock.groupGetInviteInfo(' '), TypeError)
  await assert.rejects(sock.groupAcceptInviteV4('a', {}), TypeError)
  await assert.rejects(sock.groupAcceptInviteV4(null, { groupJid: GROUP, inviteCode: 'C' }), TypeError)

  sock.query = async () => ({ tag: 'iq', content: [{ tag: 'group', ...metadataNode(), attrs: { ...metadataNode().attrs, id: GROUP } }] })
  const info = await sock.groupGetInviteInfo('CODE')
  assert.equal(info.id, GROUP)

  sock.query = async () => ({ tag: 'iq', content: [{ tag: 'groups', content: [{ ...metadataNode(), attrs: { ...metadataNode().attrs, id: 'g2@g.us' } }] }] })
  const updates = []
  sock.on('groups.update', (g) => updates.push(g))
  const all = await sock.groupFetchAllParticipating()
  assert.deepEqual(Object.keys(all), ['g2@g.us'])
  assert.equal(updates.length, 1)
  assert.ok(queries.length > 0)
})

test('groups: solicitudes de ingreso, ephemeral y modos', async () => {
  const { sock, queries } = make((node) => {
    const tag = node.content?.[0]?.tag
    if (tag === 'membership_approval_requests') {
      return { tag: 'iq', content: [{ tag: 'membership_approval_requests', content: [{ tag: 'membership_approval_request', attrs: { jid: 'a@s.whatsapp.net' } }] }] }
    }
    if (tag === 'membership_requests_action') {
      return { tag: 'iq', content: [{ tag: 'membership_requests_action', content: [{ tag: 'approve', content: [{ tag: 'participant', attrs: { jid: 'a@s.whatsapp.net' } }] }] }] }
    }
    return { tag: 'iq', attrs: { type: 'result' } }
  })
  const requests = await sock.groupRequestParticipantsList(GROUP)
  assert.equal(requests[0].jid, 'a@s.whatsapp.net')
  const approved = await sock.groupRequestParticipantsUpdate(GROUP, ['a@s.whatsapp.net'], 'approve')
  assert.deepEqual(approved[0], { status: '200', jid: 'a@s.whatsapp.net' })
  await assert.rejects(sock.groupRequestParticipantsList('no'), TypeError)
  await assert.rejects(sock.groupRequestParticipantsUpdate(GROUP, [], 'approve'), TypeError)

  await sock.groupToggleEphemeral(GROUP, 86400)
  assert.equal(queries.at(-1).content[0].tag, 'ephemeral')
  await sock.groupToggleEphemeral(GROUP, 0)
  assert.equal(queries.at(-1).content[0].tag, 'not_ephemeral')
  await assert.rejects(sock.groupToggleEphemeral(GROUP, -1), RangeError)
  await assert.rejects(sock.groupToggleEphemeral(GROUP, 7776001), RangeError)

  await sock.groupMemberAddMode(GROUP, 'admin_add')
  assert.equal(queries.at(-1).content[0].content, 'admin_add')
  await assert.rejects(sock.groupMemberAddMode(GROUP, 'nope'), TypeError)
  await sock.groupJoinApprovalMode(GROUP, 'on')
  assert.equal(queries.at(-1).content[0].tag, 'membership_approval_mode')
  await assert.rejects(sock.groupJoinApprovalMode(GROUP, 'nope'), TypeError)
})
