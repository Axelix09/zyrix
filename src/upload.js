import fs from 'fs'
import https from 'https'

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
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('error', reject)
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
      }
    )
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => req.destroy(new Error('tiempo de espera agotado subiendo el media')))
    const input = fs.createReadStream(filePath)
    input.on('error', (error) => req.destroy(error))
    input.pipe(req)
  })

export { postFile }
