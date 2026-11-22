import type { SendOptions, SocketOptions } from '../index.js'

// The `@ts-expect-error` directives make `npm run typecheck` fail if a public type ever
// starts accepting a value it should reject, or if the error disappears.

// @ts-expect-error maxMediaBytes is a number
const badMediaLimit: SocketOptions = { maxMediaBytes: '100MiB' }

// @ts-expect-error waitAck is a boolean
const badWaitAck: SendOptions = { waitAck: 'yes' }

// @ts-expect-error messageId is a string
const badMessageId: SendOptions = { messageId: 42 }

// @ts-expect-error unknown options are rejected
const unknownOption: SendOptions = { notAnOption: true }

void [badMediaLimit, badWaitAck, badMessageId, unknownOption]
