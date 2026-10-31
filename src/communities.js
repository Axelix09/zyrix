import { jidNormalizedUser } from './jid.js'

export function makeCommunitiesApi(socket, queryRunner) {
  const runQuery = async (query) => {
    if (typeof queryRunner === 'function') {
      return await queryRunner(query)
    }
    return await socket.query(query)
  }

  return Object.freeze({
    async create(subject, description = '') {
      if (!subject || typeof subject !== 'string') {
        throw new Error('El título de la comunidad es obligatorio')
      }

      const result = await runQuery({
        tag: 'iq',
        attrs: {
          to: '@g.us',
          type: 'set',
          xmlns: 'w:g2'
        },
        content: [
          {
            tag: 'create',
            attrs: {
              subject,
              parent_group: '1'
            },
            content: description
              ? [{ tag: 'description', attrs: {}, content: Buffer.from(description, 'utf8') }]
              : []
          }
        ]
      })

      const groupNode = result.content?.find(n => n.tag === 'group')
      const gid = groupNode?.attrs?.id
      return {
        id: gid ? `${gid}@g.us` : null,
        gid,
        subject
      }
    },

    async linkGroups(communityJid, groupJids) {
      const parentJid = jidNormalizedUser(communityJid)
      const list = Array.isArray(groupJids) ? groupJids : [groupJids]

      return await runQuery({
        tag: 'iq',
        attrs: {
          to: parentJid,
          type: 'set',
          xmlns: 'w:g2'
        },
        content: [
          {
            tag: 'links',
            attrs: {},
            content: list.map(jid => ({
              tag: 'link',
              attrs: {
                group_jid: jidNormalizedUser(jid),
                link_type: 'sub_group'
              }
            }))
          }
        ]
      })
    },

    async unlinkGroup(communityJid, groupJid) {
      const parentJid = jidNormalizedUser(communityJid)
      const subJid = jidNormalizedUser(groupJid)

      return await runQuery({
        tag: 'iq',
        attrs: {
          to: parentJid,
          type: 'set',
          xmlns: 'w:g2'
        },
        content: [
          {
            tag: 'unlink',
            attrs: {
              group_jid: subJid,
              unlink_type: 'sub_group'
            }
          }
        ]
      })
    },

    async subgroups(communityJid) {
      const parentJid = jidNormalizedUser(communityJid)

      const result = await runQuery({
        tag: 'iq',
        attrs: {
          to: parentJid,
          type: 'get',
          xmlns: 'w:g2'
        },
        content: [{ tag: 'sub_groups', attrs: {} }]
      })

      const subGroupsNode = result.content?.find(n => n.tag === 'sub_groups')
      if (!subGroupsNode || !Array.isArray(subGroupsNode.content)) {
        return []
      }

      return subGroupsNode.content
        .filter(n => n.tag === 'group' && n.attrs?.id)
        .map(n => `${n.attrs.id}@g.us`)
    }
  })
}