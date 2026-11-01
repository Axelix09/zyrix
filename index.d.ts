export type MessageKey = {
  remoteJid: string
  remoteJidAlt?: string
  id: string
  fromMe: boolean
  participant?: string
  participantAlt?: string
}

export type IncomingMessage = {
  key: MessageKey
  message: Record<string, unknown>
  pushName?: string
  messageTimestamp?: number
  offline?: boolean
}

export type SendOptions = {
  quoted?: IncomingMessage
  mentions?: string[]
  contextInfo?: Record<string, unknown>
  expiration?: number
  viewOnce?: boolean
  linkPreview?: { url: string; title?: string; description?: string; thumbnail?: Uint8Array }
  messageId?: string
  waitAck?: boolean
  ackTimeoutMs?: number
  additionalNodes?: ProtocolNode[]
}

export type ProtocolNode = {
  tag: string
  attrs: Record<string, string>
  content?: (ProtocolNode | Uint8Array | string)[]
}

export type ButtonOption = { id: string; text: string }
export type ListRow = { id: string; title: string; description?: string }
export type ListSection = { title: string; rows: ListRow[] }
export type GroupParticipant = {
  id: string
  jid?: string
  phoneNumber?: string
  lid?: string
  username?: string
  admin: string | null
  isAdmin: boolean
  isSuperAdmin: boolean
  isOwner: boolean
}
export type GroupMetadata = {
  id: string
  subject?: string
  desc?: string
  descId?: string
  owner?: string
  participants: GroupParticipant[]
  announce?: boolean
  restrict?: boolean
  memberAddMode?: boolean
  joinApprovalMode?: boolean
  ephemeralDuration?: number
  addressingMode?: 'lid' | 'pn'
}

export type MessageContent = string | Record<string, unknown> & {
  text?: string
  type?: 'text' | 'buttons' | 'interactive' | 'list' | 'poll' | 'location' | 'contact' | 'reaction'
  quoted?: IncomingMessage
  mentions?: string[]
}

export type AuthState = {
  state: { creds: Record<string, unknown>; keys: Record<string, unknown> }
  save(): void
  flush?(): Promise<void>
  onSaveError?: ((error: Error) => void) | null
}

export type CloseReason = { code?: number; reason?: number | 'qr-timeout'; loggedOut?: boolean; reconnecting?: boolean }
export type SendResult = { key: MessageKey; message: Record<string, unknown>; status: 'sent' | 'unconfirmed'; messageTimestamp: number }
export type MediaInput = Uint8Array | string | { url: string; timeout?: number; headers?: Record<string, string> } | { path: string } | { stream: AsyncIterable<Uint8Array> }
export type ParsedMessage = {
  id: string
  chat: string
  sender?: string
  senderAlt?: string
  fromMe: boolean
  isGroup: boolean
  pushName?: string
  timestamp: number
  offline: boolean
  type: string
  text?: string
  mentions: string[]
  quoted: { key: MessageKey; message: Record<string, unknown>; sender?: string } | null
  media: { type: string; mimetype?: string; fileName?: string; fileLength: number; seconds?: number; width?: number; height?: number; caption?: string; ptt: boolean; gif: boolean } | null
  isForwarded: boolean
  expiration?: number
  viewOnce: boolean
  key: MessageKey
  message: Record<string, unknown>
}
export type CallEvent = { chatId: string; from: string; id: string; date: Date; offline: boolean; status: 'offer' | 'ringing' | 'accept' | 'reject' | 'terminate' | 'timeout'; isVideo?: boolean; isGroup?: boolean; groupJid?: string }
export type GroupParticipantsUpdate = { id: string; author?: string; authorPn?: string; action: 'add' | 'remove' | 'promote' | 'demote' | 'leave'; participants: string[]; participantsInfo: GroupParticipant[]; timestamp?: number; offline?: boolean }
export type PresenceState = 'available' | 'unavailable' | 'composing' | 'recording' | 'paused'
export type ConnectionUpdate = { connection?: 'connecting' | 'open' | 'close'; qr?: string; isNewLogin?: boolean; lastDisconnect?: { reason?: number | 'qr-timeout'; code?: number; date: Date } }
export type TrustPolicy = 'update' | 'tofu' | ((id: string, incoming: Uint8Array, stored: Uint8Array) => boolean | Promise<boolean>)
export declare const DisconnectReason: Readonly<Record<'connectionClosed' | 'connectionLost' | 'timedOut' | 'connectionReplaced' | 'loggedOut' | 'forbidden' | 'badSession' | 'restartRequired' | 'multideviceMismatch' | 'clientOutdated' | 'unavailableService', number>>
export type ZyrixMessages = {
  disconnect: Record<string, string>
  fatal: Record<string, string>
  relaunch: Record<string, string>
  issue: Record<string, (...args: unknown[]) => string>
  signal: Record<string, string | ((signal: string) => string)>
}
export declare const DEFAULT_MESSAGES: Readonly<ZyrixMessages>
export declare function mergeMessages(custom?: Partial<ZyrixMessages>): ZyrixMessages
export type MediaOptions = SendOptions & {
  image?: MediaInput; video?: MediaInput; audio?: MediaInput
  document?: MediaInput; sticker?: MediaInput
  caption?: string; mimetype?: string; fileName?: string; ptt?: boolean; gif?: boolean
  thumbnail?: Uint8Array; width?: number; height?: number; seconds?: number; waveform?: Uint8Array
  viewOnce?: boolean
}
export type AlbumItem = SendOptions & ({ image: Uint8Array; video?: never } | { video: Uint8Array; image?: never }) & { caption?: string }
export type StickerPackSticker = { fileName: string; isAnimated?: boolean; emojis?: string[]; accessibilityLabel?: string; isLottie?: boolean; mimetype?: string; premium?: number }
export type StickerPackOptions = SendOptions & { pack?: Uint8Array; file?: Uint8Array; archive?: Uint8Array; stickerPackId?: string; name?: string; publisher?: string; packDescription?: string; caption?: string; trayIconFileName?: string; stickerPackOrigin?: number; stickers: StickerPackSticker[] }

export type NewsletterRole = 'owner' | 'admin' | 'subscriber' | 'viewer'
export type NewsletterMetadata = {
  id: string
  name: string | null
  description: string | null
  subscribers: number
  role: NewsletterRole
  invite?: string | null
  viewerMetadata?: Record<string, unknown> | null
}

export type NewslettersApi = {
  create(name: string, description?: string): Promise<NewsletterMetadata>
  metadata(jidOrInvite: string): Promise<NewsletterMetadata>
  follow(jid: string): Promise<void>
  unfollow(jid: string): Promise<void>
  mute(jid: string): Promise<void>
  unmute(jid: string): Promise<void>
}

export type CommunityApi = {
  create(subject: string, description?: string): Promise<{ id: string; gid: string; subject: string }>
  linkGroups(communityJid: string, groupJids: string | string[]): Promise<unknown>
  unlinkGroup(communityJid: string, groupJid: string): Promise<unknown>
  subgroups(communityJid: string): Promise<string[]>
}

export type SocketEventMap = {
  open: () => void
  close: (reason?: CloseReason) => void
  qr: (qr: string) => void
  'pairing-code': (code: string) => void
  'messages.upsert': (message: IncomingMessage) => void
  receipt: (receipt: Record<string, unknown>) => void
  'contacts.upsert': (contact: Record<string, unknown>) => void
  'chats.update': (update: Record<string, unknown>) => void
  'app-state.mutation': (mutation: Record<string, unknown>) => void
  'connection.update': (update: ConnectionUpdate) => void
  'group-participants.update': (update: GroupParticipantsUpdate) => void
  'groups.update': (updates: (Partial<GroupMetadata> & { author?: string; timestamp?: number; offline?: boolean })[]) => void
  'presence.update': (update: { id: string; presences: Record<string, { lastKnownPresence: PresenceState; lastSeen?: number }> }) => void
  call: (call: CallEvent) => void
  'identity.changed': (info: { id: string; accepted?: boolean }) => void
  'send.warning': (info: { id: string; chat: string; missingDevices: string[] }) => void
  message: (m: MessageContext) => void
  'message.edit': (e: { chat: string; key: MessageKey; author?: string; text?: string; message: Record<string, unknown>; ctx: MessageContext }) => void
  'message.revoke': (e: { chat: string; key: MessageKey; author?: string; ctx: MessageContext }) => void
  'message.reaction': (e: { chat: string; key: MessageKey; emoji: string; removed: boolean; author?: string; ctx: MessageContext }) => void
  'poll.vote': (e: { chat: string; pollKey?: MessageKey; author?: string; raw: Record<string, unknown>; ctx: MessageContext }) => void
  error: (error: Error) => void
}

export type ErrorKindValue = 'timeout' | 'closed' | 'not-ready' | 'rejected' | 'invalid' | 'no-session' | 'decrypt' | 'media' | 'auth' | 'not-found'
export const ErrorKind: Readonly<{ TIMEOUT: 'timeout'; CLOSED: 'closed'; NOT_READY: 'not-ready'; REJECTED: 'rejected'; INVALID: 'invalid'; NO_SESSION: 'no-session'; DECRYPT: 'decrypt'; MEDIA: 'media'; AUTH: 'auth'; NOT_FOUND: 'not-found' }>
export class ZyrixError extends Error {
  constructor(message: string, options?: { kind?: ErrorKindValue | string; code?: number | string; details?: unknown; cause?: unknown })
  kind: ErrorKindValue | string
  code?: number | string
  details?: unknown
  readonly retryable: boolean
  toJSON(): { name: string; kind: string; code?: number | string; message: string; retryable: boolean }
}
export function isZyrixError(value: unknown, kind?: ErrorKindValue): value is ZyrixError

export type AskOptions = { timeout?: number; filter?: (m: MessageContext) => boolean; strict?: boolean }
export class MessageContext {
  readonly sock: Socket
  readonly event: IncomingMessage
  readonly number?: string
  readonly isMentioned: boolean
  readonly hasMedia: boolean
  id: string
  chat: string
  sender?: string
  senderAlt?: string
  fromMe: boolean
  isGroup: boolean
  pushName?: string
  timestamp: number
  offline: boolean
  type: string
  text: string
  mentions: string[]
  quoted: { key: MessageKey; message: Record<string, unknown>; sender?: string } | null
  media: { type: string; mimetype?: string; fileName?: string; fileLength: number; seconds?: number; width?: number; height?: number; caption?: string; ptt: boolean; gif: boolean } | null
  isForwarded: boolean
  expiration?: number
  viewOnce: boolean
  key: MessageKey
  message: Record<string, unknown>
  command?: string
  prefix?: string
  args?: string[]
  argText?: string
  match?: RegExpExecArray | unknown
  reply(content: MessageContent, options?: Omit<SendOptions, 'quoted'>): Promise<SendResult>
  say(content: MessageContent, options?: SendOptions): Promise<SendResult>
  react(emoji?: string): Promise<SendResult>
  unreact(): Promise<SendResult>
  delete(): Promise<SendResult>
  edit(text: string): Promise<SendResult>
  forward(to: string, options?: SendOptions): Promise<SendResult>
  read(): Promise<void>
  download(): Promise<Uint8Array>
  typing(ms?: number, state?: 'composing' | 'recording'): Promise<void>
  group(): Promise<GroupMetadata | null>
  isAdmin(): Promise<boolean>
  isBotAdmin(): Promise<boolean>
  getQuoted(): MessageContext | null
  ask(prompt?: MessageContent, options?: AskOptions): Promise<MessageContext | null>
}

export type SessionEncryptionKey = string | Uint8Array
export type SessionOptions = { debounceMs?: number; encryptionKey?: SessionEncryptionKey }
export type SessionAdapter = { read(): string | null | undefined | Promise<string | null | undefined>; write(data: string): void | Promise<void> }
export function useAdapterAuthState(adapter: SessionAdapter, options?: SessionOptions): Promise<AuthState>
export function useMemoryAuthState(initial?: string | null): Promise<AuthState>
export function memoryAdapter(initial?: string | null): SessionAdapter
export type MongoSessionCollection = {
  findOne(filter: { _id: string }): Promise<unknown>
  updateOne(
    filter: { _id: string },
    update: { $set: { data: string; updatedAt: Date; byteLength?: number } },
    options?: { upsert?: boolean },
  ): Promise<unknown>
}
export function mongoAdapter(collection: MongoSessionCollection, id?: string): SessionAdapter
export const MAX_MONGO_DOCUMENT_BYTES: number

export type ConnectOptions = Omit<Partial<SocketOptions>, 'auth'> & { session?: string | SessionAdapter; sessionEncryptionKey?: SessionEncryptionKey; auth?: AuthState }
export function connect(options?: ConnectOptions): Promise<Socket>

export type GroupsApi = {
  create(subject: string, participants?: string[]): Promise<{ id: string; gid: string; subject: string }>
  metadata(group: string): Promise<GroupMetadata>
  all(): Promise<Record<string, GroupMetadata>>
  participant(group: string, user: string): Promise<GroupParticipant | undefined>
  admins(group: string): Promise<GroupParticipant[]>
  isAdmin(group: string, user: string): Promise<boolean>
  add(group: string, users: string | string[]): Promise<Record<string, string>[]>
  kick(group: string, users: string | string[]): Promise<Record<string, string>[]>
  promote(group: string, users: string | string[]): Promise<Record<string, string>[]>
  demote(group: string, users: string | string[]): Promise<Record<string, string>[]>
  rename(group: string, subject: string): Promise<unknown>
  describe(group: string, description: string): Promise<unknown>
  onlyAdminsTalk(group: string): Promise<unknown>
  everyoneTalks(group: string): Promise<unknown>
  lockInfo(group: string): Promise<unknown>
  unlockInfo(group: string): Promise<unknown>
  leave(group: string): Promise<unknown>
  inviteCode(group: string): Promise<string | undefined>
  revokeInvite(group: string): Promise<string | undefined>
  join(code: string): Promise<string | undefined>
  joinFromInvite(keyOrJid: string | MessageKey, invite: Record<string, unknown>): Promise<string | undefined>
  inviteInfo(code: string): Promise<GroupMetadata | undefined>
  requests(group: string): Promise<Record<string, string>[]>
  approve(group: string, users: string | string[]): Promise<Record<string, string>[]>
  reject(group: string, users: string | string[]): Promise<Record<string, string>[]>
  ephemeral(group: string, seconds: number): Promise<unknown>
  memberAddMode(group: string, mode: 'admin_add' | 'all_member_add'): Promise<unknown>
  joinApproval(group: string, mode: 'on' | 'off'): Promise<unknown>
}
export type PrivacyValue = 'all' | 'contacts' | 'contact_blacklist' | 'none' | 'match_last_seen'
export type PrivacyApi = {
  get(force?: boolean): Promise<Record<string, string>>
  set(name: string, value: PrivacyValue): Promise<unknown>
  lastSeen(value: PrivacyValue): Promise<unknown>
  online(value: 'all' | 'match_last_seen'): Promise<unknown>
  picture(value: PrivacyValue): Promise<unknown>
  status(value: PrivacyValue): Promise<unknown>
  readReceipts(value: 'all' | 'none'): Promise<unknown>
  groupAdd(value: PrivacyValue): Promise<unknown>
  messages(value: PrivacyValue): Promise<unknown>
  calls(value: PrivacyValue): Promise<unknown>
  disappearing(seconds: number): Promise<unknown>
}
export type ProfileApi = {
  name(name: string): Promise<unknown>
  status(status: string): Promise<unknown>
  picture(image: Uint8Array, jid?: string): Promise<unknown>
  removePicture(jid?: string): Promise<unknown>
  pictureUrl(jid: string, type?: 'preview' | 'image'): Promise<string | undefined>
  statusOf(jid: string): Promise<{ status?: string; setAt?: number } | undefined>
  business(jid: string): Promise<Record<string, unknown> | undefined>
  blocklist(): Promise<string[]>
  block(jid: string): Promise<unknown>
  unblock(jid: string): Promise<unknown>
  exists(...numbers: (string | string[])[]): Promise<{ jid: string; exists: boolean; lid?: string }[]>
}
export type BusinessHoursDay =
  | { day: 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat'; mode: 'specific_hours'; openTimeInMinutes: number | string; closeTimeInMinutes: number | string }
  | { day: 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat'; mode: 'open_24h' | 'appointment_only' }
export type BusinessProfileUpdate = {
  address?: string
  email?: string
  description?: string
  websites?: string[]
  hours?: { timezone: string; days: BusinessHoursDay[] }
}
export type CatalogProductInput = {
  name: string
  description: string
  price: number
  currency: string
  images: MediaInput[]
  retailerId?: string
  url?: string
  isHidden?: boolean
  originCountryCode?: string
}
export type CatalogProductUpdate = Partial<Omit<CatalogProductInput, 'originCountryCode'>> & { originCountryCode?: string | undefined }
export type CatalogProduct = {
  id: string
  imageUrls: { requested?: string; original?: string }
  reviewStatus: { whatsapp: string }
  availability: 'in stock'
  name: string
  retailerId?: string
  url?: string
  description: string
  price: number
  currency: string
  isHidden: boolean
}
export type CatalogCollection = {
  id: string
  name: string
  products: CatalogProduct[]
  status: { status: string; canAppeal: boolean }
}
export type BusinessOrderDetails = {
  price: { total: number; currency: string }
  products: { id: string; name: string; imageUrl: string; price: number; currency: string; quantity: number }[]
}
export type BusinessApi = {
  profile(profile: BusinessProfileUpdate): Promise<unknown>
  getProfile(jid: string): Promise<Record<string, unknown> | undefined>
  coverPhoto(image: MediaInput): Promise<unknown>
  removeCoverPhoto(id: string): Promise<unknown>
  catalog(options?: { jid?: string; limit?: number; cursor?: string }): Promise<{ products: CatalogProduct[]; nextPageCursor?: string }>
  collections(jid?: string, limit?: number): Promise<{ collections: CatalogCollection[] }>
  orderDetails(orderId: string, tokenBase64: string): Promise<BusinessOrderDetails>
  createProduct(product: CatalogProductInput): Promise<CatalogProduct>
  updateProduct(productId: string, update: CatalogProductUpdate): Promise<CatalogProduct>
  deleteProducts(productIds: string | string[]): Promise<{ deleted: number }>
}
export type ChatsApi = {
  pin(jid: string): Promise<unknown>
  unpin(jid: string): Promise<unknown>
  mute(jid: string, until?: number | true): Promise<unknown>
  unmute(jid: string): Promise<unknown>
  archive(jid: string): Promise<unknown>
  unarchive(jid: string): Promise<unknown>
  markRead(jid: string): Promise<unknown>
  markUnread(jid: string): Promise<unknown>
  read(keys: MessageKey | MessageKey[]): Promise<void>
}
export type PresenceApi = {
  online(): void
  offline(): void
  typing(jid: string): void
  recording(jid: string): void
  paused(jid: string): void
  watch(jid: string): void
}

export class Socket {
  constructor(options: SocketOptions)
  readonly ev: Socket
  readonly user?: { id: string; lid?: string; name?: string }
  readonly authState: AuthState
  readonly groups: Readonly<GroupsApi>
  readonly privacy: Readonly<PrivacyApi>
  readonly profile: Readonly<ProfileApi>
  readonly chats: Readonly<ChatsApi>
  readonly presence: Readonly<PresenceApi>
  readonly business: Readonly<BusinessApi>
  readonly newsletters: Readonly<NewslettersApi>
  readonly communities: Readonly<CommunityApi>
  start(): Promise<this>
  waitForMessage(filter?: (m: MessageContext) => boolean, timeout?: number): Promise<MessageContext | null>
  on<E extends keyof SocketEventMap>(event: E, listener: SocketEventMap[E]): this
  once<E extends keyof SocketEventMap>(event: E, listener: SocketEventMap[E]): this
  off<E extends keyof SocketEventMap>(event: E, listener: SocketEventMap[E]): this
  sendMessage(to: string, content: MessageContent, options?: SendOptions): Promise<SendResult>
  sendText(to: string, text: string, options?: SendOptions): Promise<SendResult>
  reply(to: string, text: string, quoted: IncomingMessage, options?: Omit<SendOptions, 'quoted'>): Promise<SendResult>
  sendMedia(to: string, options: MediaOptions): Promise<SendResult>
  sendImage(to: string, image: MediaInput, options?: MediaOptions): Promise<SendResult>
  sendVideo(to: string, video: MediaInput, options?: MediaOptions): Promise<SendResult>
  sendAudio(to: string, audio: MediaInput, options?: MediaOptions): Promise<SendResult>
  sendDocument(to: string, document: MediaInput, options?: MediaOptions): Promise<SendResult>
  sendSticker(to: string, sticker: MediaInput, options?: MediaOptions): Promise<SendResult>
  sendAlbum(to: string, items: AlbumItem[], options?: SendOptions): Promise<{ messages: IncomingMessage[]; expectedImageCount: number; expectedVideoCount: number }>
  sendStickerPack(to: string, options: StickerPackOptions): Promise<SendResult>
  sendButtons(to: string, options: SendOptions & { text: string; footer?: string; buttons: ButtonOption[] }): Promise<SendResult>
  sendInteractive(to: string, options: SendOptions & { text: string; title?: string; footer?: string; buttons: ButtonOption[] }): Promise<SendResult>
  sendList(to: string, options: SendOptions & { text: string; title?: string; footer?: string; buttonText?: string; sections: ListSection[] }): Promise<SendResult>
  sendPoll(to: string, options: SendOptions & { text: string; options: string[]; selectableOptionsCount?: number }): Promise<SendResult>
  sendReaction(to: string, target: IncomingMessage | MessageKey, emoji?: string): Promise<SendResult>
  sendLocation(to: string, options: SendOptions & { latitude: number; longitude: number; name?: string; address?: string; comment?: string }): Promise<SendResult>
  sendContact(to: string, options: SendOptions & { displayName: string; vcard: string }): Promise<SendResult>
  downloadMedia(message: Record<string, unknown>): Promise<Uint8Array>
  downloadMediaToFile(message: Record<string, unknown>, outputPath: string, options?: { maxBytes?: number; timeout?: number; mediaType?: 'image' | 'video' | 'audio' | 'document' | 'sticker' }): Promise<string>
  updateProfileStatus(status: string): Promise<unknown>
  updateProfileName(name: string): Promise<unknown>
  updateProfilePicture(jid: string, image: Uint8Array): Promise<unknown>
  removeProfilePicture(jid: string): Promise<unknown>
  profilePictureUrl(jid: string, type?: 'preview' | 'image'): Promise<string | undefined>
  fetchStatus(jid: string): Promise<{ status?: string; setAt?: number } | undefined>
  getBusinessProfile(jid: string): Promise<Record<string, unknown> | undefined>
  getCatalog(options?: { jid?: string; limit?: number; cursor?: string }): Promise<{ products: CatalogProduct[]; nextPageCursor?: string }>
  getCollections(jid?: string, limit?: number): Promise<{ collections: CatalogCollection[] }>
  getOrderDetails(orderId: string, tokenBase64: string): Promise<BusinessOrderDetails>
  productCreate(product: CatalogProductInput): Promise<CatalogProduct>
  productUpdate(productId: string, update: CatalogProductUpdate): Promise<CatalogProduct>
  productDelete(productIds: string[]): Promise<{ deleted: number }>
  updateBusinessProfile(profile: BusinessProfileUpdate): Promise<unknown>
  updateCoverPhoto(image: MediaInput): Promise<unknown>
  removeCoverPhoto(id: string): Promise<unknown>
  fetchBlocklist(): Promise<string[]>
  updateBlockStatus(jid: string, action: 'block' | 'unblock'): Promise<unknown>
  fetchPrivacySettings(force?: boolean): Promise<Record<string, string>>
  updatePrivacyCategory(name: string, value: 'all' | 'contacts' | 'contact_blacklist' | 'none' | 'match_last_seen'): Promise<unknown>
  updateLastSeenPrivacy(value: 'all' | 'contacts' | 'contact_blacklist' | 'none'): Promise<unknown>
  updateOnlinePrivacy(value: 'all' | 'match_last_seen'): Promise<unknown>
  updateProfilePicturePrivacy(value: 'all' | 'contacts' | 'contact_blacklist' | 'none'): Promise<unknown>
  updateStatusPrivacy(value: 'all' | 'contacts' | 'contact_blacklist' | 'none'): Promise<unknown>
  updateReadReceiptsPrivacy(value: 'all' | 'none'): Promise<unknown>
  updateGroupsAddPrivacy(value: 'all' | 'contacts' | 'contact_blacklist'): Promise<unknown>
  updateMessagesPrivacy(value: 'all' | 'contacts' | 'contact_blacklist' | 'none'): Promise<unknown>
  updateCallPrivacy(value: 'all' | 'contacts' | 'contact_blacklist' | 'none'): Promise<unknown>
  updateDefaultDisappearingMode(seconds: number): Promise<unknown>
  resolveJid(value: string | number): string
  getJidAliases(value: string | number): string[]
  groupCreate(subject: string, participants?: string[]): Promise<{ id: string; gid: string; subject: string }>
  groupMetadata(jid: string): Promise<GroupMetadata>
  getGroupParticipant(group: string, user: string): Promise<GroupParticipant | undefined>
  isGroupAdmin(group: string, user: string): Promise<boolean>
  getGroupAdmins(group: string): Promise<GroupParticipant[]>
  groupParticipantsUpdate(group: string, participants: string[], action: 'add' | 'remove' | 'promote' | 'demote'): Promise<Record<string, string>[]>
  groupUpdateSubject(group: string, subject: string): Promise<unknown>
  groupUpdateDescription(group: string, description: string): Promise<unknown>
  groupSettingUpdate(group: string, setting: 'announcement' | 'not_announcement' | 'locked' | 'unlocked'): Promise<unknown>
  groupLeave(group: string): Promise<unknown>
  groupInviteCode(group: string): Promise<string | undefined>
  groupRevokeInvite(group: string): Promise<string | undefined>
  groupAcceptInvite(code: string): Promise<string | undefined>
  groupGetInviteInfo(code: string): Promise<GroupMetadata | undefined>
  groupAcceptInviteV4(keyOrJid: string | MessageKey, inviteMessage: Record<string, unknown>): Promise<string | undefined>
  groupFetchAllParticipating(): Promise<Record<string, GroupMetadata>>
  groupRequestParticipantsList(group: string): Promise<Record<string, string>[]>
  groupRequestParticipantsUpdate(group: string, participants: string[], action: 'approve' | 'reject'): Promise<Record<string, string>[]>
  groupToggleEphemeral(group: string, seconds: number): Promise<unknown>
  groupMemberAddMode(group: string, mode: 'admin_add' | 'all_member_add'): Promise<unknown>
  groupJoinApprovalMode(group: string, mode: 'on' | 'off'): Promise<unknown>
  sendPresence(jid: string, state: 'composing' | 'recording' | 'paused'): void
  sendPresenceUpdate(type: PresenceState, to?: string): void
  presenceSubscribe(jid: string): void
  readMessages(keys: MessageKey[]): Promise<void>
  sendReceipt(jid: string, participant: string | undefined, messageIds: string[], type?: 'read' | 'read-self' | 'sender' | 'played'): Promise<void>
  rejectCall(callId: string, callFrom: string): Promise<unknown>
  onWhatsApp(...phones: (string | string[])[]): Promise<{ jid: string; exists: boolean; lid?: string }[]>
  contactQuery(jid: string): Promise<{ id: string; name?: string; shortName?: string; notify?: string } | undefined>
  chatModify(modification: { pin: boolean } | { mute: number | null } | { archive: boolean } | { markRead: boolean }, jid: string): Promise<Record<string, unknown>>
  parseMessage(event: IncomingMessage): ParsedMessage
  sendContacts(to: string, options: SendOptions & { displayName?: string; contacts: { displayName: string; vcard: string }[] }): Promise<SendResult>
  sendGroupInvite(to: string, options: SendOptions & { groupJid: string; inviteCode: string; inviteExpiration?: number; groupName?: string; caption?: string }): Promise<SendResult>
  sendDelete(to: string, target: IncomingMessage | MessageKey): Promise<SendResult>
  sendEdit(to: string, target: IncomingMessage | MessageKey, text: string): Promise<SendResult>
  forward(to: string, source: IncomingMessage | Record<string, unknown>, options?: SendOptions): Promise<SendResult>
  waitForOpen(timeout?: number): Promise<Socket>
  logout(): Promise<void>
  readonly isOpen: boolean
  requestPairingCode(phone: string): Promise<string>
  syncAppState(): Promise<void>
  appStatePatch(options: { type?: string; index: string[]; syncAction: Record<string, unknown>; apiVersion?: number; operation?: 0 | 1 }): Promise<Record<string, unknown>>
  end(): Promise<void>
}

export type SocketOptions = {
  auth: AuthState
  phoneNumber?: string
  browser?: [string, string, string]
  version?: [number, number, number]
  printQR?: boolean
  maxMediaBytes?: number
  maxFileBytes?: number
  logger?: boolean | Partial<Record<'trace' | 'debug' | 'info' | 'warn' | 'error', (...args: unknown[]) => void>>
  getMessage?: (key: MessageKey) => Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined
  autoRejectCalls?: boolean
  markOnlineOnConnect?: boolean
  syncFullHistory?: boolean
  minSendIntervalMs?: number
  keepAliveIntervalMs?: number
  trustPolicy?: TrustPolicy
  reconnect?: boolean
  maxReconnectAttempts?: number
  sentCacheSize?: number
  groupCacheSize?: number
  queryTimeoutMs?: number
}

export type Store = {
  loadMessage(jid: string, id: string): IncomingMessage | undefined
  getMessage(key: MessageKey): Record<string, unknown> | undefined
  getMessages(jid: string, limit?: number): IncomingMessage[]
  getChat(jid: string): Record<string, unknown> | undefined
  getChats(): Record<string, unknown>[]
  getContact(jid: string): Record<string, unknown> | undefined
  getContacts(): Record<string, unknown>[]
  getGroup(jid: string): Partial<GroupMetadata> | undefined
  getGroups(): Partial<GroupMetadata>[]
  getPresence(jid: string): Record<string, unknown> | undefined
  toJSON(): Record<string, unknown>
  fromJSON(data: Record<string, unknown>): Store
  writeToFile(file: string): Promise<void>
  readFromFile(file: string): Store
  unbind(): void
}

export function makeSocket(options: SocketOptions): Promise<Socket>
export function useFileAuthState(dir: string, options?: SessionOptions): AuthState
export function createStore(socket: Socket, options?: { maxMessagesPerChat?: number; maxChats?: number; maxContacts?: number }): Store
export function makeInMemoryStore(options?: { maxMessagesPerChat?: number; maxChats?: number; maxContacts?: number }): Store & { bind(socket: Socket): Store }
export function parseMessage(event: IncomingMessage, options?: { self?: string }): ParsedMessage
export const proto: Record<string, any>
export const content: {
  buildMessage(input: MessageContent, options?: SendOptions): Record<string, unknown>
  text(text: string, options?: SendOptions): Record<string, unknown>
  buttons(options: SendOptions & { text: string; footer?: string; buttons: ButtonOption[] }): Record<string, unknown>
  interactive(options: SendOptions & { text: string; title?: string; footer?: string; header?: Record<string, unknown>; messageParamsJson?: string; buttons: ButtonOption[] }): Record<string, unknown>
  list(options: SendOptions & { text: string; title?: string; footer?: string; buttonText?: string; sections: ListSection[] }): Record<string, unknown>
  poll(options: SendOptions & { text: string; options: string[]; selectableOptionsCount?: number }): Record<string, unknown>
  location(options: SendOptions & { latitude: number; longitude: number; name?: string; address?: string }): Record<string, unknown>
  contact(options: SendOptions & { displayName: string; vcard: string }): Record<string, unknown>
  reaction(target: IncomingMessage | MessageKey, emoji?: string): Record<string, unknown>
  contacts(options: SendOptions & { displayName?: string; contacts: { displayName: string; vcard: string }[] }): Record<string, unknown>
  groupInvite(options: SendOptions & { groupJid: string; inviteCode: string; inviteExpiration?: number; groupName?: string; caption?: string }): Record<string, unknown>
  deleteMessage(target: IncomingMessage | MessageKey): Record<string, unknown>
  editMessage(target: IncomingMessage | MessageKey, text: string): Record<string, unknown>
  forward(source: IncomingMessage | Record<string, unknown>, options?: SendOptions): Record<string, unknown>
  vcard(options: { name: string; number: string; organization?: string }): string
  stickerPack(options: StickerPackOptions): Record<string, unknown>
  extractText(input: IncomingMessage | Record<string, unknown>): string | undefined
  extractInteractiveId(input: IncomingMessage | Record<string, unknown>): unknown
  REVOKE_TYPE: number
  EDIT_TYPE: number
  unwrapMessage(message: Record<string, unknown>): Record<string, unknown>
}
export function jidDecode(jid: string): { server: string; user: string; domainType: number; device?: number } | undefined
export function jidEncode(user: string, server: string, device?: number): string
export function normalizeJid(value: string | number, defaultServer?: string): string
export function jidNormalizedUser(jid: string): string
export function jidWithoutDevice(jid: string): string
export function jidType(jid: string): 'group' | 'lid' | 'pn' | 'broadcast' | 'newsletter' | 'status' | 'other'
export function isJidUser(jid: string): boolean
export function isJidLid(jid: string): boolean
export function isJidPN(jid: string): boolean
export function isJidGroup(jid: string): boolean
export * from './client.js'
export type LauncherStatus =
  | { state: 'connecting'; registered: boolean; phoneNumber: string | null }
  | { state: 'pairing' }
  | { state: 'open' }
  | { state: 'reconnecting'; reason?: number; name?: string; restart: boolean }
  | { state: 'relaunching'; why: string }
export type LauncherIssue =
  | { type: 'sender-key-miss'; count: number }
  | { type: 'stream-error' | 'connection-rejected'; code?: number; name?: string; error: Error }
  | { type: 'idle' | 'timeout' | 'error' | 'save-error' | 'setup-error' | 'cleanup-error'; error: Error }
  | { type: 'session-deleted' }
export type LauncherFatal = { reason: string; error?: Error | null; code?: number; why?: string }
export type LauncherEventMap = {
  socket: (sock: Socket) => void
  open: (sock: Socket) => void
  qr: (qr: string) => void
  'pairing-code': (code: string, formatted: string) => void
  status: (status: LauncherStatus) => void
  issue: (issue: LauncherIssue) => void
  fatal: (info: LauncherFatal) => void
  signal: (signal: string) => void
  stopped: () => void
}
export type LauncherOptions = Omit<Partial<SocketOptions>, 'auth'> & {
  session?: string | SessionAdapter
  sessionEncryptionKey?: SessionEncryptionKey
  phoneNumber?: string | number | (() => string | number | null | undefined | Promise<string | number | null | undefined>)
  setup?: (sock: Socket, launcher: Launcher) => void | (() => unknown) | { stop(): unknown } | Promise<void | (() => unknown) | { stop(): unknown }>
  connector?: (options: SocketOptions) => Promise<Socket>
  autoReset?: boolean
  maxRelaunches?: number
  relaunchWindowMs?: number
  relaunchDelayMs?: number
  watchSession?: boolean
  watchIntervalMs?: number
  signals?: boolean | string[]
  exit?: boolean
  printCode?: boolean
  on?: Partial<LauncherEventMap>
}
export class Launcher {
  constructor(options?: LauncherOptions)
  readonly sock: Socket | null
  readonly isOpen: boolean
  readonly knownPhone: string | null
  on<E extends keyof LauncherEventMap>(event: E, listener: LauncherEventMap[E]): this
  once<E extends keyof LauncherEventMap>(event: E, listener: LauncherEventMap[E]): this
  off<E extends keyof LauncherEventMap>(event: E, listener: LauncherEventMap[E]): this
  start(): Promise<this>
  stop(): Promise<void>
  logout(): Promise<void>
}
export function createLauncher(options?: LauncherOptions): Launcher
export function start(options?: LauncherOptions): Promise<Launcher>
export function parsePhoneNumber(value: unknown): string | null
export function formatPairingCode(code: string): string
export type PromptInput = {
  readonly isTTY?: boolean
  on(event: string, listener: (...args: never[]) => void): unknown
}
export type PromptOutput = { write(chunk: string): unknown }
export function promptPhone(question: string, options?: { input?: PromptInput; output?: PromptOutput; attempts?: number; invalid?: string }): Promise<string | null>
export function reasonName(reason: number): keyof typeof DisconnectReason | undefined
export function sniffMimeType(buffer: ArrayLike<number> | null | undefined, fallback?: string): string | undefined
