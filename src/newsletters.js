import { jidNormalizedUser } from './jid.js'

export function makeNewslettersApi(socket, queryRunner) {
  const runQuery = async (query) => {
    if (typeof queryRunner === 'function') {
      return await queryRunner(query)
    }
    return await socket.query(query)
  }

  return Object.freeze({
    async create(name, description = '') {
      if (!name || typeof name !== 'string') {
        throw new Error('El nombre del canal es obligatorio')
      }

      const result = await runQuery({
        tag: 'iq',
        attrs: {
          to: 'newsletter',
          type: 'set',
          xmlns: 'newsletter'
        },
        content: [
          {
            tag: 'create',
            attrs: {},
            content: [
              { tag: 'name', attrs: {}, content: Buffer.from(name, 'utf8') },
              { tag: 'description', attrs: {}, content: Buffer.from(description, 'utf8') }
            ]
          }
        ]
      })

      const newsletterNode = result.content?.find(n => n.tag === 'newsletter')
      const jid = newsletterNode?.attrs?.id ? `${newsletterNode.attrs.id}@newsletter` : null
      return {
        id: jid,
        name,
        description,
        role: 'owner',
        invite: newsletterNode?.attrs?.invite || null
      }
    },

    async metadata(jidOrInvite) {
      const isJid = typeof jidOrInvite === 'string' && jidOrInvite.endsWith('@newsletter')
      const queryAttrs = isJid
        ? { jid: jidOrInvite }
        : { invite: jidOrInvite.replace('https://whatsapp.com/channel/', '').trim() }

      const result = await runQuery({
        tag: 'iq',
        attrs: {
          to: 'newsletter',
          type: 'get',
          xmlns: 'newsletter'
        },
        content: [
          {
            tag: 'metadata',
            attrs: queryAttrs
          }
        ]
      })

      const data = result.content?.find(n => n.tag === 'newsletter')
      if (!data) {
        throw new Error('No se encontró información del canal')
      }

      const nameNode = data.content?.find(n => n.tag === 'name')
      const descNode = data.content?.find(n => n.tag === 'description')
      const subscribersNode = data.content?.find(n => n.tag === 'subscribers')

      return {
        id: `${data.attrs.id}@newsletter`,
        name: nameNode ? nameNode.content?.toString('utf8') : null,
        description: descNode ? descNode.content?.toString('utf8') : null,
        subscribers: subscribersNode ? Number(subscribersNode.attrs.count || 0) : 0,
        role: data.attrs.role || 'viewer',
        viewerMetadata: data.attrs.viewer_metadata || null
      }
    },

    async follow(newsletterJid) {
      const jid = jidNormalizedUser(newsletterJid)
      await runQuery({
        tag: 'iq',
        attrs: {
          to: jid,
          type: 'set',
          xmlns: 'newsletter'
        },
        content: [{ tag: 'follow', attrs: {} }]
      })
    },

    async unfollow(newsletterJid) {
      const jid = jidNormalizedUser(newsletterJid)
      await runQuery({
        tag: 'iq',
        attrs: {
          to: jid,
          type: 'set',
          xmlns: 'newsletter'
        },
        content: [{ tag: 'unfollow', attrs: {} }]
      })
    },

    async mute(newsletterJid) {
      const jid = jidNormalizedUser(newsletterJid)
      await runQuery({
        tag: 'iq',
        attrs: {
          to: jid,
          type: 'set',
          xmlns: 'newsletter'
        },
        content: [{ tag: 'mute', attrs: {} }]
      })
    },

    async unmute(newsletterJid) {
      const jid = jidNormalizedUser(newsletterJid)
      await runQuery({
        tag: 'iq',
        attrs: {
          to: jid,
          type: 'set',
          xmlns: 'newsletter'
        },
        content: [{ tag: 'unmute', attrs: {} }]
      })
    }
  })
}