import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildMessage, text, buttons, interactive, list, poll, location, contact, contacts, groupInvite,
  reaction, deleteMessage, editMessage, forward, vcard, stickerPack, extractText, extractInteractiveId,
  unwrapMessage, socketMethods, REVOKE_TYPE, EDIT_TYPE
} from '../src/content.js'

const key = { id: 'msg1', remoteJid: '5491100000002@s.whatsapp.net', fromMe: false }

test('content: texto simple, preview y validaciones', () => {
  assert.deepEqual(buildMessage('hola'), { conversation: 'hola' })
  assert.deepEqual(text('hola'), { conversation: 'hola' })
  assert.deepEqual(buildMessage({ text: 'hola' }), { conversation: 'hola' })
  const preview = text('mira', { linkPreview: { url: 'https://x', title: 'T', description: 'D', thumbnail: Buffer.from('x') } })
  assert.equal(preview.extendedTextMessage.matchedText, 'https://x')
  assert.equal(preview.extendedTextMessage.title, 'T')
  assert.throws(() => text(''), TypeError)
  assert.throws(() => buildMessage(null), TypeError)
  assert.throws(() => buildMessage([1]), TypeError)
  assert.throws(() => buildMessage({ type: 'nope' }), TypeError)
})

test('content: delete, edit y forward', () => {
  const deleted = deleteMessage(key)
  assert.equal(deleted.protocolMessage.type, REVOKE_TYPE)
  assert.equal(deleted.protocolMessage.key.id, 'msg1')
  const edited = editMessage(key, 'nuevo')
  assert.equal(edited.protocolMessage.type, EDIT_TYPE)
  assert.equal(edited.protocolMessage.editedMessage.conversation, 'nuevo')
  assert.throws(() => buildMessage({ delete: { id: 'x' } }), TypeError)
  assert.throws(() => editMessage(key, ''), TypeError)

  const forwarded = forward({ key, message: { conversation: 'hola' } })
  assert.equal(forwarded.extendedTextMessage.text, 'hola')
  assert.equal(forwarded.extendedTextMessage.contextInfo.isForwarded, true)
  assert.equal(forwarded.extendedTextMessage.contextInfo.forwardingScore, 1)
  const image = forward({ imageMessage: { caption: 'x', contextInfo: { stanzaId: 'q', participant: 'p', quotedMessage: {}, remoteJid: 'r', forwardingScore: 2 } } })
  assert.equal(image.imageMessage.contextInfo.stanzaId, undefined)
  assert.equal(image.imageMessage.contextInfo.forwardingScore, 3)
  assert.throws(() => forward({}), TypeError)
  assert.throws(() => forward({ protocolMessage: {} }), TypeError)
})

test('content: contacts, groupInvite y vcard', () => {
  const vcf = vcard({ name: 'Ana', number: '+54 911 0000-0002', organization: 'ACME' })
  assert.match(vcf, /FN:Ana/)
  assert.match(vcf, /ORG:ACME/)
  assert.throws(() => vcard({ name: '', number: '1' }), TypeError)
  assert.throws(() => vcard({ name: 'Ana', number: 'x' }), TypeError)

  const array = contacts({ contacts: [{ displayName: 'Ana', vcard: vcf }] })
  assert.equal(array.contactsArrayMessage.contacts.length, 1)
  const array2 = contacts({ contacts: [{ displayName: 'Ana', vcard: vcf }], displayName: 'Dos' })
  assert.equal(array2.contactsArrayMessage.displayName, 'Dos')
  assert.throws(() => contacts({ contacts: [] }), RangeError)
  assert.throws(() => contacts({ contacts: Array.from({ length: 21 }, () => ({ displayName: 'a', vcard: 'v' })) }), RangeError)
  assert.throws(() => contacts({ contacts: [{ displayName: '', vcard: 'v' }] }), TypeError)

  const single = contact({ displayName: 'Ana', vcard: vcf })
  assert.equal(single.contactMessage.displayName, 'Ana')
  assert.throws(() => contact({ displayName: '', vcard: 'v' }), TypeError)

  const invite = groupInvite({ groupJid: 'g@g.us', inviteCode: 'C', groupName: 'G', caption: 'Hola' })
  assert.equal(invite.groupInviteMessage.inviteCode, 'C')
  assert.ok(invite.groupInviteMessage.inviteExpiration > 0)
  assert.throws(() => groupInvite({ groupJid: '', inviteCode: 'C' }), TypeError)
})

test('content: botones, interactive nativo, listas y polls', () => {
  const oldButtons = buttons({ text: 'Elegí', footer: 'f', buttons: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] })
  assert.equal(oldButtons.buttonsMessage.buttons.length, 2)
  assert.throws(() => buttons({ text: 'x', buttons: [] }), RangeError)
  assert.throws(() => buttons({ text: 'x', buttons: Array.from({ length: 4 }, (_, i) => ({ id: String(i), text: 'x' })) }), RangeError)

  const native = interactive({
    text: 'Cuerpo', title: 'T', footer: 'F', contextInfo: { a: 1 },
    buttons: [
      { text: 'Uno', id: '1' },
      { name: 'cta_url', params: { display_text: 'Dos', id: '2' } }
    ]
  })
  const inner = native.viewOnceMessage.message.interactiveMessage
  assert.equal(inner.body.text, 'Cuerpo')
  assert.equal(inner.header.title, 'T')
  assert.equal(inner.footer.text, 'F')
  assert.equal(inner.nativeFlowMessage.buttons.length, 2)
  assert.equal(inner.viewOnceMessage, undefined)
  const withHeader = interactive({ text: 'x', header: { title: 'H' }, buttons: [{ text: 'b', id: 'i' }] })
  assert.equal(withHeader.viewOnceMessage.message.interactiveMessage.header.title, 'H')
  assert.throws(() => interactive({ text: 'x', buttons: [] }), RangeError)
  assert.throws(() => interactive({ text: '', buttons: [{ text: 'b', id: 'i' }] }), TypeError)

  const l = list({ text: 'Elegí', title: 'T', buttonText: 'Ver', sections: [{ title: 'S', rows: [{ title: 'R', id: 'r1', description: 'd' }] }] })
  assert.equal(l.listMessage.sections[0].rows[0].rowId, 'r1')
  assert.throws(() => list({ text: 'x', sections: [] }), TypeError)
  assert.throws(() => list({ text: 'x', sections: [{ title: 'S', rows: [] }] }), TypeError)
  assert.throws(() => list({ text: 'x', sections: [{ title: 'S', rows: [{ title: 'R', id: '' }] }] }), TypeError)

  const p = poll({ text: '¿?', options: ['A', { name: 'B' }], selectableOptionsCount: 2 })
  assert.equal(p.pollCreationMessage.options.length, 2)
  assert.throws(() => poll({ text: 'x', options: ['A'] }), RangeError)
  assert.throws(() => poll({ text: 'x', options: Array.from({ length: 13 }, (_, i) => String(i)) }), RangeError)
  assert.throws(() => poll({ text: 'x', options: ['A', 'A'] }), TypeError)
  assert.throws(() => poll({ text: 'x', options: ['A', 'B'], selectableOptionsCount: 3 }), RangeError)
})

test('content: ubicación, reacción y contexto (quote, menciones, viewOnce)', () => {
  const loc = location({ latitude: 1, longitude: 2, name: 'N', address: 'A', comment: 'C' })
  assert.equal(loc.locationMessage.name, 'N')
  assert.throws(() => location({ latitude: 91, longitude: 0 }), RangeError)
  assert.throws(() => location({ latitude: 0, longitude: 181 }), RangeError)

  const r = reaction({ key, message: { conversation: 'x' } }, '👍')
  assert.equal(r.reactionMessage.text, '👍')
  assert.equal(r.reactionMessage.key.id, 'msg1')
  assert.throws(() => reaction({}, 'x'), TypeError)

  const quoted = { key, message: { conversation: 'hola' } }
  const withQuote = buildMessage('respuesta', { quoted, mentions: ['5491100000002', '5491100000003@s.whatsapp.net'], expiration: 60 })
  const ext = withQuote.extendedTextMessage
  assert.equal(ext.text, 'respuesta')
  assert.equal(ext.contextInfo.stanzaId, 'msg1')
  assert.equal(ext.contextInfo.mentionedJid.length, 2)
  assert.equal(ext.contextInfo.expiration, 60)
  assert.equal(ext.contextInfo.quotedMessage.conversation, 'hola')
  assert.throws(() => buildMessage('x', { quoted: {} }), TypeError)
  assert.throws(() => buildMessage('x', { mentions: [1] }), TypeError)
  assert.throws(() => buildMessage('x', { expiration: 1.5 }), RangeError)
  assert.throws(() => buildMessage('x', { expiration: -1 }), RangeError)

  const participantQuote = buildMessage('x', { quoted: { key: { id: 'q', participantAlt: 'p@lid' }, message: { conversation: 'y' } } })
  assert.equal(participantQuote.extendedTextMessage.contextInfo.participant, 'p@lid')

  const image = { imageMessage: { caption: 'foto' } }
  const imageWithContext = buildMessage(image, { quoted, mentions: ['5491100000002'] })
  assert.equal(imageWithContext.imageMessage.contextInfo.stanzaId, 'msg1')

  const once = buildMessage({ imageMessage: { caption: 'foto' } }, { viewOnce: true, quoted })
  assert.ok(once.viewOnceMessage)
  assert.equal(once.viewOnceMessage.message.imageMessage.contextInfo.stanzaId, 'msg1')

  const ephemeral = buildMessage({ ephemeralMessage: { message: { conversation: 'e' } } }, { quoted })
  assert.equal(ephemeral.ephemeralMessage.message.extendedTextMessage.contextInfo.stanzaId, 'msg1')

  assert.throws(() => buildMessage({ unknownMessage: {} }, { quoted }), /does not support contextInfo/)
})

test('content: stickerPack valida y construye metadatos', () => {
  const pack = stickerPack({ name: 'Pack', publisher: 'Yo', stickers: [{ fileName: 'a.webp', emojis: ['😀'] }] })
  assert.equal(pack.stickerPackMessage.name, 'Pack')
  assert.equal(pack.stickerPackMessage.stickers.length, 1)
  assert.equal(pack.stickerPackMessage.stickers[0].emojis[0], '😀')
  assert.throws(() => stickerPack({ stickers: [] }), RangeError)
  assert.throws(() => stickerPack({ stickers: Array.from({ length: 101 }, () => ({ fileName: 'a' })) }), RangeError)
  assert.throws(() => stickerPack({ stickers: [{}] }), TypeError)
  assert.equal(stickerPack({ stickers: [{ fileName: 'a' }] }).stickerPackMessage.name, 'Zyrix stickers')
})

test('content: unwrap, extractText y extractInteractiveId', () => {
  const wrapped = { viewOnceMessage: { message: { imageMessage: { caption: 'cap' } } } }
  assert.deepEqual(unwrapMessage(wrapped), { imageMessage: { caption: 'cap' } })
  assert.equal(extractText(wrapped), 'cap')
  assert.equal(extractText({ conversation: 'hola' }), 'hola')
  assert.equal(extractText({ extendedTextMessage: { text: 't' } }), 't')
  assert.equal(extractText({ audioMessage: { caption: 'a' } }), 'a')
  assert.equal(extractText({ pollCreationMessage: { name: 'poll' } }), 'poll')
  assert.equal(extractText({ reactionMessage: { text: '👍' } }), '👍')
  assert.equal(extractText({ stickerPackMessage: { caption: 'sp' } }), 'sp')
  assert.equal(extractText({ interactiveResponseMessage: { body: { text: 'body' } } }), 'body')
  assert.equal(extractText(null), undefined)

  assert.equal(extractInteractiveId({ buttonsResponseMessage: { selectedButtonId: 'b1' } }), 'b1')
  assert.equal(extractInteractiveId({ listResponseMessage: { singleSelectReply: { selectedRowId: 'r1' } } }), 'r1')
  assert.equal(extractInteractiveId({ templateButtonReplyMessage: { selectedId: 't1' } }), 't1')
  assert.equal(extractInteractiveId({ interactiveResponseMessage: { nativeFlowResponseMessage: { paramsJson: '{"id":"n1"}' } } }), 'n1')
  assert.equal(extractInteractiveId({ nativeFlowResponseMessage: { messageParamsJson: '{"selectedRowId":"n2"}' } }), 'n2')
  assert.equal(extractInteractiveId({ interactiveResponseMessage: { nativeFlowResponseMessage: { paramsJson: 'no-json' } } }), undefined)
  assert.equal(extractInteractiveId({ interactiveResponseMessage: { selectedId: 's1' } }), 's1')

  assert.equal(extractText({ buttonsResponseMessage: { selectedDisplayText: 'Ver' } }), 'Ver')
  assert.equal(extractText({ listResponseMessage: { title: 'Lista', singleSelectReply: { selectedRowId: 'x' } } }), 'Lista')
  assert.equal(extractText({ templateButtonReplyMessage: { selectedDisplayText: 'Tpl' } }), 'Tpl')
})

test('content: socketMethods delega en sendMessage y construye botones por tipo', async () => {
  const calls = []
  const sock = Object.assign({
    sendMessage: async (...args) => { calls.push(args); return 'ok' },
    sendReaction: async (...args) => { calls.push(['reaction', ...args]); return 'ok' },
    maxMediaBytes: 100,
    uploadMedia: async () => ({ url: 'u', directPath: 'd', mediaKey: Buffer.alloc(32), fileEncSha256: Buffer.alloc(32), fileSha256: Buffer.alloc(32), fileLength: 3 })
  }, socketMethods)

  await sock.reply('jid', 'hola', { key, message: { conversation: 'x' } })
  await sock.sendText('jid', 'hola')
  await sock.sendPoll('jid', { text: 'p', options: ['a', 'b'] })
  await sock.sendLocation('jid', { latitude: 0, longitude: 0 })
  await sock.sendContact('jid', { displayName: 'A', vcard: 'v' })
  await sock.sendContacts('jid', { contacts: [{ displayName: 'A', vcard: 'v' }] })
  await sock.sendGroupInvite('jid', { groupJid: 'g', inviteCode: 'c' })
  await sock.sendDelete('jid', key)
  await sock.sendEdit('jid', key, 'x')
  await sock.forward('jid', { conversation: 'x' })
  await sock.sendReaction('jid', key, '👍')
  assert.equal(calls.length, 11)

  await sock.sendButtons('jid', { text: 'x', buttons: [
    { text: 'A', id: 'a' },
    { type: 'quick_reply', text: 'B', id: 'b' },
    { type: 'cta_url', text: 'C', url: 'https://x' },
    { type: 'cta_copy', text: 'D', copyText: 'code' },
    { type: 'cta_call', text: 'E', phoneNumber: '123' },
    { type: 'single_select', text: 'F', id: 'f', sections: [] },
    { type: 'inapp_signup', text: 'G' }
  ] })
  const sent = calls.at(-1)[1]
  assert.equal(sent.viewOnceMessage.message.interactiveMessage.nativeFlowMessage.buttons.length, 7)
  assert.equal(calls.at(-1)[2].additionalNodes[0].tag, 'biz')
  assert.equal(calls.at(-1)[2].additionalNodes[1].tag, 'bot')
  assert.throws(() => sock.sendButtons('jid', { text: 'x', buttons: [{ type: 'nope' }] }), TypeError)

  await sock.sendList('jid', { text: 'x', sections: [{ title: 'S', rows: [{ title: 'R', id: 'r' }] }] })
  assert.ok(calls.at(-1)[1].listMessage)
  const image = Buffer.from('img')
  await sock.sendList('jid', { text: 'x', image, sections: [{ title: 'S', rows: [{ title: 'R', rowId: 'r' }] }] })
  assert.ok(calls.at(-1)[1].viewOnceMessage)
  const uploaded = calls.at(-1)[1].viewOnceMessage.message.interactiveMessage.header.imageMessage
  assert.equal(uploaded.url, 'u')

  await sock.sendInteractive('g@g.us', { text: 'x', buttons: [{ text: 'a', id: 'a' }], additionalNodes: [{ tag: 'custom', attrs: {} }] })
  assert.equal(calls.at(-1)[2].additionalNodes[0].tag, 'custom')
  await assert.rejects(sock.sendInteractive.call({ sendMessage: async () => {} }, 'jid', { image: Buffer.from('x') }), TypeError)
})
