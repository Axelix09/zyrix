import profileMethods from './messages/profile.js'
import groupMethods from './messages/groups.js'
import messagingMethods from './messages/messaging.js'

export { participantFromNode, parseGroupMetadata, nodeText } from './messages/shared.js'

const messages = { ...profileMethods, ...groupMethods, ...messagingMethods }

export default messages
