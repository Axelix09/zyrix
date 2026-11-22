import fs from 'fs'
import https from 'https'
import { ZyrixError, ErrorKind } from './errors.js'

const postFile = (host, pathname, filePath, size, timeoutMs = 120000) =>
  new Promise((resolve, reject) => {
    const req = https.request(
      {
        host,
        method: 'POST',
        path: pathname,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': size,
          Origin: 'https://web.whatsapp.com'
        }
      },
      (res) => {
        const chunks = []
        let total = 0
        res.on('data', (chunk) => {
          total += chunk.length
          if (total > 64 * 1024) {
            res.destroy(new ZyrixError('media upload response too large', { kind: ErrorKind.MEDIA, errorCode: 'UPLOAD_RESPONSE_TOO_LARGE' }))
            return
          }
          chunks.push(chunk)
        })
        res.on('error', reject)
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks, total).toString('utf8') }))
      }
    )
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => req.destroy(new ZyrixError('timed out uploading media', { kind: ErrorKind.TIMEOUT, errorCode: 'UPLOAD_TIMEOUT' })))
    const input = fs.createReadStream(filePath)
    input.on('error', (error) => req.destroy(error))
    input.pipe(req)
  })

export { postFile }
