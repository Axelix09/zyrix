import test from 'node:test'
import assert from 'node:assert/strict'
import profile from '../src/messages/profile.js'
import business from '../src/business.js'
import { makeNewslettersApi } from '../src/newsletters.js'
import { makeCommunitiesApi } from '../src/communities.js'
import { defineNamespaces } from '../src/namespaces.js'
import { makeState } from './helpers/state.js'

const makeProfile = (responder = () => ({ tag: 'iq' })) => {
  const state = makeState()
  const queries = []
  const sock = Object.assign({}, profile, {
    auth: { state, save() { sock.saved = (sock.saved || 0) + 1 } },
    contactCache: new Map(),
    privacySettings: undefined,
    readReceiptCache: 'x',
    maxMediaBytes: 10,
    query: async (node) => { queries.push(node); return responder(node) }
  })
  return { sock, queries, state }
}

test('profile: resolveJid, aliases y caché de contactos', async () => {
  const { sock, state } = makeProfile()
  state.keys.identity = state.keys.identity || {}
  const jid = sock.resolveJid('5491100000002')
  assert.equal(jid, '5491100000002@s.whatsapp.net')
  assert.deepEqual(sock.getJidAliases('5491100000002'), ['5491100000002@s.whatsapp.net'])
  sock.rememberContact('5491100000002', { name: '  Ana  ', notify: '', age: 3 })
  const contact = await sock.contactQuery('5491100000002')
  assert.equal(contact.name, 'Ana')
  sock.rememberContact(null, { name: 'x' })
  sock.rememberContact('5491100000002', { name: ' ' })
  sock.rememberContact('no valido', { name: 'x' })
  for (let i = 0; i < 5100; i++) sock.rememberContact('5491100000002', { name: `n${i}` })
  assert.ok(sock.contactCache.size <= 5000)
  sock.contactCache.clear()
  assert.equal(await sock.contactQuery('5491100000002'), undefined)
  assert.equal(await sock.contactQuery(), undefined)
})

test('profile: status, nombre y foto actualizan auth o consultan', async () => {
  const { sock, queries, state } = makeProfile()
  await sock.updateProfileStatus('Hola')
  assert.equal(queries[0].attrs.xmlns, 'status')
  await assert.rejects(sock.updateProfileStatus('x'.repeat(140)), RangeError)
  await assert.rejects(sock.updateProfileStatus(1), RangeError)

  await sock.updateProfileName('Nuevo')
  assert.equal(queries[1].attrs.xmlns, 'profile')
  assert.equal(state.creds.me.name, 'Nuevo')
  assert.equal(sock.saved, 1)
  await assert.rejects(sock.updateProfileName(''), RangeError)
  await assert.rejects(sock.updateProfileName('x'.repeat(26)), RangeError)

  state.creds.myAppStateKeyId = 'k'
  sock.appStatePatch = async (patch) => { sock.patch = patch; return 'patched' }
  assert.equal(await sock.updateProfileName('Otro'), 'patched')
  assert.equal(sock.patch.syncAction.pushNameSetting.name, 'Otro')

  const picture = Buffer.alloc(3)
  await sock.updateProfilePicture('5491100000003', picture)
  assert.equal(queries.at(-1).attrs.target, '5491100000003@s.whatsapp.net')
  await sock.updateProfilePicture(state.creds.me.id, picture)
  assert.equal(queries.at(-1).attrs.target, undefined)
  await assert.rejects(sock.updateProfilePicture('x', Buffer.alloc(11)), TypeError)
  await assert.rejects(sock.updateProfilePicture('x'), TypeError)
  await sock.removeProfilePicture('5491100000003')
  await assert.rejects(sock.removeProfilePicture(), TypeError)
})

test('profile: URLs, status, business, blocklist y privacidad', async () => {
  const { sock, queries, state } = makeProfile((node) => {
    const tag = node.tag
    if (tag === 'iq' && node.attrs.xmlns === 'w:profile:picture') return { tag: 'iq', content: [{ tag: 'picture', attrs: { url: 'https://x' } }] }
    if (tag === 'iq' && node.attrs.xmlns === 'status') return { tag: 'iq', content: [{ tag: 'status', attrs: { t: '5' }, content: 'Hola' }] }
    if (tag === 'iq' && node.attrs.xmlns === 'w:biz') return { tag: 'iq', content: [{ tag: 'business_profile', content: [{ tag: 'profile', attrs: { jid: 'b' }, content: [{ tag: 'address', content: 'Calle' }, { tag: 'description', content: 'D' }, { tag: 'categories', content: [{ tag: 'category', content: 'Cat' }] }] }] }] }
    if (tag === 'iq' && node.attrs.xmlns === 'blocklist') return { tag: 'iq', content: [{ tag: 'list', content: [{ tag: 'item', attrs: { jid: 'b' } }, { tag: 'item', attrs: {} }] }] }
    if (tag === 'iq' && node.attrs.xmlns === 'privacy') return { tag: 'iq', content: [{ tag: 'privacy', content: [{ tag: 'category', attrs: { name: 'last', value: 'all' } }] }] }
    return { tag: 'iq' }
  })
  assert.equal(await sock.profilePictureUrl('5491100000002'), 'https://x')
  await assert.rejects(sock.profilePictureUrl('x', 'nope'), TypeError)
  assert.deepEqual(await sock.fetchStatus('5491100000002'), { status: 'Hola', setAt: 5 })
  const businessProfile = await sock.getBusinessProfile('5491100000002')
  assert.equal(businessProfile.address, 'Calle')
  assert.equal(businessProfile.category, 'Cat')
  assert.deepEqual(await sock.fetchBlocklist(), ['b'])
  const privacy = await sock.fetchPrivacySettings()
  assert.deepEqual(privacy, { last: 'all' })
  assert.equal(await sock.fetchPrivacySettings(), privacy)
  await sock.updatePrivacyCategory('last', 'none')
  assert.equal(sock.privacySettings.last, 'none')
  await assert.rejects(sock.updatePrivacyCategory('last', 'nope'), TypeError)
  await assert.rejects(sock.updatePrivacyCategory('nope', 'all'), TypeError)
  for (const method of ['updateLastSeenPrivacy', 'updateOnlinePrivacy', 'updateProfilePicturePrivacy', 'updateStatusPrivacy', 'updateReadReceiptsPrivacy', 'updateGroupsAddPrivacy', 'updateMessagesPrivacy', 'updateCallPrivacy']) {
    await sock[method]('all')
  }
  assert.equal(sock.readReceiptCache, undefined)
  await sock.updateDefaultDisappearingMode(3600)
  await assert.rejects(sock.updateDefaultDisappearingMode(-1), RangeError)

  state.keys.identity = state.keys.identity || {}
  await assert.rejects(sock.updateBlockStatus('5491100000002', 'nope'), TypeError)
  await assert.rejects(sock.updateBlockStatus('5491100000002', 'block'), { errorCode: 'LID_MAPPING_REQUIRED' })
  assert.ok(queries.length > 0)
})

test('business: catálogo, colecciones y pedidos parsean respuestas', async () => {
  const product = (id) => ({
    tag: 'product', attrs: { is_hidden: 'true' },
    content: [
      { tag: 'id', attrs: {}, content: Buffer.from(id) },
      { tag: 'name', attrs: {}, content: Buffer.from('Nombre') },
      { tag: 'price', attrs: {}, content: Buffer.from('100') },
      { tag: 'currency', attrs: {}, content: Buffer.from('USD') },
      { tag: 'media', attrs: {}, content: [{ tag: 'image', attrs: {}, content: [{ tag: 'request_image_url', attrs: {}, content: Buffer.from('u') }] }] },
      { tag: 'status_info', attrs: {}, content: [{ tag: 'status', attrs: {}, content: Buffer.from('approved') }] }
    ]
  })
  const sock = Object.assign({}, business, {
    auth: { state: makeState(), save() {} },
    query: async (node) => {
      if (node.attrs.xmlns === 'w:biz:catalog' && node.content[0].tag === 'product_catalog') {
        return { tag: 'iq', content: [{ tag: 'product_catalog', content: [product('p1'), { tag: 'paging', attrs: {}, content: [{ tag: 'after', attrs: {}, content: Buffer.from('next') }] }] }] }
      }
      if (node.attrs.xmlns === 'w:biz:catalog' && node.content[0].tag === 'collections') {
        return { tag: 'iq', content: [{ tag: 'collections', content: [{ tag: 'collection', content: [{ tag: 'id', attrs: {}, content: Buffer.from('c1') }, { tag: 'name', attrs: {}, content: Buffer.from('Col') }, product('p2'), { tag: 'status_info', attrs: {}, content: [{ tag: 'status', attrs: {}, content: Buffer.from('ok') }, { tag: 'can_appeal', attrs: {}, content: Buffer.from('true') }] }] }] }] }
      }
      if (node.attrs.xmlns === 'fb:thrift_iq') {
        return { tag: 'iq', content: [{ tag: 'order', content: [{ tag: 'price', content: [{ tag: 'total', attrs: {}, content: Buffer.from('100') }, { tag: 'currency', attrs: {}, content: Buffer.from('USD') }] }, { tag: 'product', content: [{ tag: 'id', content: Buffer.from('p') }, { tag: 'name', content: Buffer.from('N') }, { tag: 'price', content: Buffer.from('50') }, { tag: 'currency', content: Buffer.from('USD') }, { tag: 'quantity', content: Buffer.from('2') }, { tag: 'image', content: [{ tag: 'url', content: Buffer.from('img') }] }] }] }] }
      }
      return { tag: 'iq', content: [] }
    }
  })
  const catalog = await sock.getCatalog({ jid: '5491100000002', limit: 2, cursor: 'c' })
  assert.equal(catalog.products[0].id, 'p1')
  assert.equal(catalog.products[0].imageUrls.requested, 'u')
  assert.equal(catalog.nextPageCursor, 'next')
  await assert.rejects(sock.getCatalog({ limit: 0 }), RangeError)
  const collections = await sock.getCollections('5491100000002', 2)
  assert.equal(collections.collections[0].id, 'c1')
  assert.equal(collections.collections[0].status.canAppeal, true)
  const order = await sock.getOrderDetails('o1', 'token')
  assert.equal(order.price.total, 100)
  assert.equal(order.products[0].quantity, 2)
  await assert.rejects(sock.getOrderDetails('', 'x'), TypeError)
  await assert.rejects(sock.getOrderDetails('o', ''), TypeError)
})

test('business: mutaciones de producto y perfil construyen nodos válidos', async () => {
  const productNode = { tag: 'product', attrs: {}, content: [
    { tag: 'id', content: Buffer.from('p1') }, { tag: 'name', content: Buffer.from('N') }, { tag: 'price', content: Buffer.from('1') }, { tag: 'currency', content: Buffer.from('USD') }
  ] }
  const sock = Object.assign({}, business, {
    auth: { state: makeState(), save() {} },
    uploadBusinessImage: async () => ({ url: 'https://img' }),
    query: async (node) => {
      if (node.content[0].tag === 'product_catalog_delete') return { tag: 'iq', content: [{ tag: 'product_catalog_delete', attrs: { deleted_count: '2' } }] }
      return { tag: 'iq', content: [{ tag: node.content[0].tag, content: [productNode] }] }
    }
  })
  const created = await sock.productCreate({ name: 'N', description: 'D', currency: 'USD', price: 1, images: [Buffer.from('x')] })
  assert.equal(created.id, 'p1')
  await assert.rejects(sock.productCreate({ name: '', description: 'D', currency: 'USD', price: 1, images: ['x'] }), TypeError)
  await assert.rejects(sock.productCreate({ name: 'N', description: 'D', currency: 'USD', price: -1, images: ['x'] }), TypeError)
  await assert.rejects(sock.productCreate({ name: 'N', description: 'D', currency: 'USD', price: 1, images: [] }), TypeError)
  const updated = await sock.productUpdate('p1', { name: 'N2', images: [Buffer.from('y')] })
  assert.equal(updated.id, 'p1')
  await assert.rejects(sock.productUpdate('', {}), TypeError)
  await assert.rejects(sock.productUpdate('p1'), TypeError)
  assert.deepEqual(await sock.productDelete(['p1', 'p2']), { deleted: 2 })
  await assert.rejects(sock.productDelete([]), TypeError)
  await assert.rejects(sock.productDelete(['']), TypeError)

  const profileSock = Object.assign({}, business, { auth: { state: makeState() }, query: async () => ({ tag: 'iq' }) })
  await profileSock.updateBusinessProfile({
    address: 'A', email: 'e', description: 'd', websites: ['https://x'],
    hours: { timezone: 'UTC', days: [{ day: 'mon', mode: 'specific_hours', openTimeInMinutes: 0, closeTimeInMinutes: 60 }, { day: 'tue', mode: 'open_24h' }] }
  })
  await assert.rejects(profileSock.updateBusinessProfile({}), TypeError)
  await assert.rejects(profileSock.updateBusinessProfile({ address: 1 }), TypeError)
  await assert.rejects(profileSock.updateBusinessProfile({ websites: [1] }), TypeError)
  await assert.rejects(profileSock.updateBusinessProfile({ hours: { timezone: 'UTC', days: [{ day: 'nope', mode: 'open_24h' }] } }), TypeError)
  await assert.rejects(profileSock.updateBusinessProfile({ hours: { timezone: 'UTC', days: [{ day: 'mon', mode: 'nope' }] } }), TypeError)
  await assert.rejects(profileSock.updateBusinessProfile({ hours: { timezone: 'UTC', days: [{ day: 'mon', mode: 'specific_hours', openTimeInMinutes: -1, closeTimeInMinutes: 1 }] } }), RangeError)
  await assert.rejects(profileSock.removeCoverPhoto(''), TypeError)
  await profileSock.removeCoverPhoto('id')
})

test('business: uploadBusinessImage valida tipo, vacío y falla sin hosts permitidos', async () => {
  const sock = Object.assign({}, business, {
    auth: { state: makeState() },
    mediaConn: async () => ({ auth: 'a', hosts: ['evil.example.com'] }),
    maxMediaBytes: 100
  })
  await assert.rejects(sock.uploadBusinessImage(Buffer.from('x'), 'nope'), TypeError)
  await assert.rejects(sock.uploadBusinessImage(Buffer.alloc(0)), TypeError)
  await assert.rejects(sock.uploadBusinessImage(Buffer.from('x')), { errorCode: 'MEDIA_UPLOAD_FAILED' })
  await assert.rejects(sock.updateCoverPhoto(Buffer.from('x')), { errorCode: 'MEDIA_UPLOAD_FAILED' })
})

test('newsletters: create, metadata, follow/unfollow y mute/unmute', async () => {
  const queries = []
  const api = makeNewslettersApi({}, async (node) => {
    queries.push(node)
    if (node.content[0].tag === 'create') return { tag: 'iq', content: [{ tag: 'newsletter', attrs: { id: '123', invite: 'inv' } }] }
    if (node.content[0].tag === 'metadata') return { tag: 'iq', content: [{ tag: 'newsletter', attrs: { id: '123', role: 'admin', viewer_metadata: 'vm' }, content: [
      { tag: 'name', content: Buffer.from('Canal') },
      { tag: 'description', content: Buffer.from('Desc') },
      { tag: 'subscribers', attrs: { count: '42' } }
    ] }] }
    return { tag: 'iq' }
  })
  assert.deepEqual(await api.create('Canal', 'Desc'), { id: '123@newsletter', name: 'Canal', description: 'Desc', role: 'owner', invite: 'inv' })
  await assert.rejects(api.create(''), { errorCode: 'NEWSLETTER_NAME_REQUIRED' })
  const meta = await api.metadata('https://whatsapp.com/channel/abc')
  assert.equal(meta.name, 'Canal')
  assert.equal(meta.subscribers, 42)
  assert.equal(meta.role, 'admin')
  assert.equal((await api.metadata('123@newsletter')).id, '123@newsletter')
  await api.follow('123@newsletter')
  await api.unfollow('123@newsletter')
  await api.mute('123@newsletter')
  await api.unmute('123@newsletter')
  assert.equal(queries.at(-1).content[0].tag, 'unmute')

  const missing = makeNewslettersApi({}, async () => ({ tag: 'iq', content: [] }))
  await assert.rejects(missing.metadata('x'), { errorCode: 'NEWSLETTER_NOT_FOUND' })
})

test('communities: create, link, unlink y subgroups', async () => {
  const queries = []
  const api = makeCommunitiesApi({}, async (node) => {
    queries.push(node)
    if (node.content[0].tag === 'create') return { tag: 'iq', content: [{ tag: 'group', attrs: { id: '999' } }] }
    if (node.content[0].tag === 'sub_groups') return { tag: 'iq', content: [{ tag: 'sub_groups', content: [{ tag: 'group', attrs: { id: '1' } }, { tag: 'otro', attrs: {} }, { tag: 'group', attrs: {} }] }] }
    return { tag: 'iq' }
  })
  assert.deepEqual(await api.create('Comunidad', 'Desc'), { id: '999@g.us', gid: '999', subject: 'Comunidad' })
  assert.deepEqual(await api.create('Comunidad'), { id: '999@g.us', gid: '999', subject: 'Comunidad' })
  await assert.rejects(api.create(''), { errorCode: 'COMMUNITY_TITLE_REQUIRED' })
  await api.linkGroups('999@g.us', ['1@g.us', '2@g.us'])
  assert.equal(queries.at(-1).content[0].content.length, 2)
  await api.linkGroups('999@g.us', '1@g.us')
  await api.unlinkGroup('999@g.us', '1@g.us')
  assert.equal(queries.at(-1).content[0].tag, 'unlink')
  assert.deepEqual(await api.subgroups('999@g.us'), ['1@g.us'])
  const empty = makeCommunitiesApi({}, async () => ({ tag: 'iq', content: [] }))
  assert.deepEqual(await empty.subgroups('999@g.us'), [])
})

test('namespaces: todos los accesos delegan en el socket y se cachean', () => {
  const calls = []
  const record = (name) => (...args) => { calls.push([name, args]); return name }
  const target = {}
  const methods = [
    'groupCreate', 'groupMetadata', 'groupFetchAllParticipating', 'getGroupParticipant', 'getGroupAdmins', 'isGroupAdmin',
    'groupParticipantsUpdate', 'groupUpdateSubject', 'groupUpdateDescription', 'groupSettingUpdate', 'groupLeave',
    'groupInviteCode', 'groupRevokeInvite', 'groupAcceptInvite', 'groupAcceptInviteV4', 'groupGetInviteInfo',
    'groupRequestParticipantsList', 'groupRequestParticipantsUpdate', 'groupToggleEphemeral', 'groupMemberAddMode', 'groupJoinApprovalMode',
    'fetchPrivacySettings', 'updatePrivacyCategory', 'updateLastSeenPrivacy', 'updateOnlinePrivacy', 'updateProfilePicturePrivacy',
    'updateStatusPrivacy', 'updateReadReceiptsPrivacy', 'updateGroupsAddPrivacy', 'updateMessagesPrivacy', 'updateCallPrivacy', 'updateDefaultDisappearingMode',
    'updateProfileName', 'updateProfileStatus', 'updateProfilePicture', 'removeProfilePicture', 'profilePictureUrl', 'fetchStatus',
    'getBusinessProfile', 'fetchBlocklist', 'updateBlockStatus', 'onWhatsApp',
    'updateBusinessProfile', 'updateCoverPhoto', 'removeCoverPhoto', 'getCatalog', 'getCollections', 'getOrderDetails',
    'productCreate', 'productUpdate', 'productDelete', 'chatModify', 'readMessages', 'sendPresenceUpdate', 'presenceSubscribe'
  ]
  for (const method of methods) target[method] = record(method)
  target.auth = { state: { creds: { me: { id: 'me' } } } }
  defineNamespaces(target)

  target.groups.create('s', ['p'])
  target.groups.add('g', ['u'])
  target.groups.add('g', 'u')
  target.groups.kick('g', 'u')
  target.groups.promote('g', 'u')
  target.groups.demote('g', 'u')
  target.groups.rename('g', 's')
  target.groups.describe('g', 'd')
  target.groups.onlyAdminsTalk('g')
  target.groups.everyoneTalks('g')
  target.groups.lockInfo('g')
  target.groups.unlockInfo('g')
  target.groups.leave('g')
  target.groups.inviteCode('g')
  target.groups.revokeInvite('g')
  target.groups.join('c')
  target.groups.joinFromInvite('k', 'i')
  target.groups.inviteInfo('c')
  target.groups.requests('g')
  target.groups.approve('g', 'u')
  target.groups.reject('g', 'u')
  target.groups.ephemeral('g', 1)
  target.groups.memberAddMode('g', 'm')
  target.groups.joinApproval('g', 'm')
  target.groups.metadata('g')
  target.groups.all()
  target.groups.participant('g', 'u')
  target.groups.admins('g')
  target.groups.isAdmin('g', 'u')

  target.privacy.get(true)
  target.privacy.set('last', 'all')
  target.privacy.lastSeen('all')
  target.privacy.online('all')
  target.privacy.picture('all')
  target.privacy.status('all')
  target.privacy.readReceipts('all')
  target.privacy.groupAdd('all')
  target.privacy.messages('all')
  target.privacy.calls('all')
  target.privacy.disappearing(1)

  target.profile.name('n')
  target.profile.status('s')
  target.profile.picture('img')
  target.profile.picture('img', 'jid')
  target.profile.removePicture()
  target.profile.removePicture('jid')
  target.profile.pictureUrl('jid', 'image')
  target.profile.statusOf('jid')
  target.profile.business('jid')
  target.profile.blocklist()
  target.profile.block('jid')
  target.profile.unblock('jid')
  target.profile.exists('1', '2')

  target.business.profile({})
  target.business.getProfile('jid')
  target.business.coverPhoto('img')
  target.business.removeCoverPhoto('id')
  target.business.catalog({})
  target.business.collections('jid', 1)
  target.business.orderDetails('o', 't')
  target.business.createProduct({})
  target.business.updateProduct('p', {})
  target.business.deleteProducts('p')

  target.chats.pin('j')
  target.chats.unpin('j')
  target.chats.mute('j')
  target.chats.unmute('j')
  target.chats.archive('j')
  target.chats.unarchive('j')
  target.chats.markRead('j')
  target.chats.markUnread('j')
  target.chats.read('k')

  target.presence.online()
  target.presence.offline()
  target.presence.typing('j')
  target.presence.recording('j')
  target.presence.paused('j')
  target.presence.watch('j')

  assert.equal(calls.length > 60, true)
  assert.equal(target.groups, target.groups, 'el namespace se cachea')
})
