const list = (value) => [].concat(value)

const spaces = {
  groups: (s) => ({
    create: (subject, participants) => s.groupCreate(subject, participants),
    metadata: (group) => s.groupMetadata(group),
    all: () => s.groupFetchAllParticipating(),
    participant: (group, user) => s.getGroupParticipant(group, user),
    admins: (group) => s.getGroupAdmins(group),
    isAdmin: (group, user) => s.isGroupAdmin(group, user),
    add: (group, users) => s.groupParticipantsUpdate(group, list(users), 'add'),
    kick: (group, users) => s.groupParticipantsUpdate(group, list(users), 'remove'),
    promote: (group, users) => s.groupParticipantsUpdate(group, list(users), 'promote'),
    demote: (group, users) => s.groupParticipantsUpdate(group, list(users), 'demote'),
    rename: (group, subject) => s.groupUpdateSubject(group, subject),
    describe: (group, description) => s.groupUpdateDescription(group, description),
    onlyAdminsTalk: (group) => s.groupSettingUpdate(group, 'announcement'),
    everyoneTalks: (group) => s.groupSettingUpdate(group, 'not_announcement'),
    lockInfo: (group) => s.groupSettingUpdate(group, 'locked'),
    unlockInfo: (group) => s.groupSettingUpdate(group, 'unlocked'),
    leave: (group) => s.groupLeave(group),
    inviteCode: (group) => s.groupInviteCode(group),
    revokeInvite: (group) => s.groupRevokeInvite(group),
    join: (code) => s.groupAcceptInvite(code),
    joinFromInvite: (key, invite) => s.groupAcceptInviteV4(key, invite),
    inviteInfo: (code) => s.groupGetInviteInfo(code),
    requests: (group) => s.groupRequestParticipantsList(group),
    approve: (group, users) => s.groupRequestParticipantsUpdate(group, list(users), 'approve'),
    reject: (group, users) => s.groupRequestParticipantsUpdate(group, list(users), 'reject'),
    ephemeral: (group, seconds) => s.groupToggleEphemeral(group, seconds),
    memberAddMode: (group, mode) => s.groupMemberAddMode(group, mode),
    joinApproval: (group, mode) => s.groupJoinApprovalMode(group, mode)
  }),

  privacy: (s) => ({
    get: (force) => s.fetchPrivacySettings(force),
    set: (name, value) => s.updatePrivacyCategory(name, value),
    lastSeen: (value) => s.updateLastSeenPrivacy(value),
    online: (value) => s.updateOnlinePrivacy(value),
    picture: (value) => s.updateProfilePicturePrivacy(value),
    status: (value) => s.updateStatusPrivacy(value),
    readReceipts: (value) => s.updateReadReceiptsPrivacy(value),
    groupAdd: (value) => s.updateGroupsAddPrivacy(value),
    messages: (value) => s.updateMessagesPrivacy(value),
    calls: (value) => s.updateCallPrivacy(value),
    disappearing: (seconds) => s.updateDefaultDisappearingMode(seconds)
  }),

  profile: (s) => ({
    name: (name) => s.updateProfileName(name),
    status: (status) => s.updateProfileStatus(status),
    picture: (image, jid) => s.updateProfilePicture(jid || s.auth.state.creds.me.id, image),
    removePicture: (jid) => s.removeProfilePicture(jid || s.auth.state.creds.me.id),
    pictureUrl: (jid, type) => s.profilePictureUrl(jid, type),
    statusOf: (jid) => s.fetchStatus(jid),
    business: (jid) => s.getBusinessProfile(jid),
    blocklist: () => s.fetchBlocklist(),
    block: (jid) => s.updateBlockStatus(jid, 'block'),
    unblock: (jid) => s.updateBlockStatus(jid, 'unblock'),
    exists: (...numbers) => s.onWhatsApp(...numbers)
  }),

  business: (s) => ({
    profile: (profile) => s.updateBusinessProfile(profile),
    getProfile: (jid) => s.getBusinessProfile(jid),
    coverPhoto: (image) => s.updateCoverPhoto(image),
    removeCoverPhoto: (id) => s.removeCoverPhoto(id),
    catalog: (options) => s.getCatalog(options),
    collections: (jid, limit) => s.getCollections(jid, limit),
    orderDetails: (orderId, tokenBase64) => s.getOrderDetails(orderId, tokenBase64),
    createProduct: (product) => s.productCreate(product),
    updateProduct: (productId, update) => s.productUpdate(productId, update),
    deleteProducts: (productIds) => s.productDelete(list(productIds))
  }),

  chats: (s) => ({
    pin: (jid) => s.chatModify({ pin: true }, jid),
    unpin: (jid) => s.chatModify({ pin: false }, jid),
    mute: (jid, until = true) => s.chatModify({ mute: until }, jid),
    unmute: (jid) => s.chatModify({ mute: null }, jid),
    archive: (jid) => s.chatModify({ archive: true }, jid),
    unarchive: (jid) => s.chatModify({ archive: false }, jid),
    markRead: (jid) => s.chatModify({ markRead: true }, jid),
    markUnread: (jid) => s.chatModify({ markRead: false }, jid),
    read: (keys) => s.readMessages(list(keys))
  }),

  presence: (s) => ({
    online: () => s.sendPresenceUpdate('available'),
    offline: () => s.sendPresenceUpdate('unavailable'),
    typing: (jid) => s.sendPresenceUpdate('composing', jid),
    recording: (jid) => s.sendPresenceUpdate('recording', jid),
    paused: (jid) => s.sendPresenceUpdate('paused', jid),
    watch: (jid) => s.presenceSubscribe(jid)
  })
}

const defineNamespaces = (target) => {
  const cache = new WeakMap()
  for (const [name, factory] of Object.entries(spaces)) {
    Object.defineProperty(target, name, {
      configurable: true,
      get() {
        let bag = cache.get(this)
        if (!bag) cache.set(this, (bag = {}))
        return bag[name] || (bag[name] = Object.freeze(factory(this)))
      }
    })
  }
}

export { defineNamespaces, spaces }
