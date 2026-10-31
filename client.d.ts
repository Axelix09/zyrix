export const clientProfiles: { ubuntu: () => [string, string, string] }
export const fetchProtocolVersion: () => Promise<{ version: [number, number, number] }>
export function useZyrixAuth(directory: string): Promise<{ state: AuthState['state']; saveCreds: AuthState['save']; auth: AuthState }>
export function createClient(options?: Record<string, any>): Socket
export function createMessageId(): string
export function createMessageEnvelope(jid: string, message: Record<string, any>, options?: Record<string, any>): IncomingMessage
export function createMessage(jid: string, content: MessageContent, options?: Record<string, any>): Promise<IncomingMessage>
export function createMessageContent(content: MessageContent, options?: Record<string, any>): Promise<Record<string, any>>
export function readMediaStream(sock: Socket, message: Record<string, any>, mediaType?: string): Promise<AsyncIterable<Uint8Array>>
export function attachMessageDelivery(sock: Socket): Socket
