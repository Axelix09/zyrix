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
        let total = 0
        res.on('data', (chunk) => {
          total += chunk.length
          if (total > 64 * 1024) {
            res.destroy(new Error('respuesta de subida de media demasiado grande'))
            return
          }
          chunks.push(chunk)
        })
        res.on('error', reject)
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks, total).toString('utf8') }))
      }
    )
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => req.destroy(new Error('tiempo de espera agotado subiendo el media')))
    const input = fs.createReadStream(filePath)
    input.on('error', (error) => req.destroy(error))
    input.pipe(req)
  })

export { postFile }
