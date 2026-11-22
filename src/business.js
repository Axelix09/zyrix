import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { getChild, getChildren } from './binary.js'
import { jidNormalizedUser } from './jid.js'
import { toBuffer } from './util.js'
import { postFile } from './upload.js'
import { ZyrixError, ErrorKind } from './errors.js'

const S = 's.whatsapp.net'
const uploadToken = (buffer) => encodeURIComponent(buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''))
const childText = (node, tag) => {
  const child = getChild(node, tag)
  if (!child || child.content == null) return undefined
  if (Buffer.isBuffer(child.content) || child.content instanceof Uint8Array) return Buffer.from(child.content).toString('utf8')
  return String(child.content)
}
const requiredText = (node, tag) => {
  const value = childText(node, tag)
  if (value === undefined || value === '') throw new ZyrixError(`invalid Business response: missing ${tag}`, { kind: ErrorKind.PROTOCOL, errorCode: 'BUSINESS_RESPONSE_INVALID' })
  return value
}
const parseProduct = (node) => {
  if (!node) throw new ZyrixError('invalid Business response: missing product', { kind: ErrorKind.PROTOCOL, errorCode: 'BUSINESS_RESPONSE_INVALID' })
  const media = getChild(node, 'media')
  const image = getChild(media, 'image')
  const status = getChild(node, 'status_info')
  return {
    id: requiredText(node, 'id'),
    imageUrls: image ? {
      requested: childText(image, 'request_image_url'),
      original: childText(image, 'original_image_url')
    } : {},
    reviewStatus: { whatsapp: childText(status, 'status') || 'unknown' },
    availability: 'in stock',
    name: childText(node, 'name') || '',
    retailerId: childText(node, 'retailer_id'),
    url: childText(node, 'url'),
    description: childText(node, 'description') || '',
    price: Number(childText(node, 'price') || 0),
    currency: childText(node, 'currency') || '',
    isHidden: node.attrs?.is_hidden === 'true'
  }
}
const parseCatalog = (node) => {
  const catalog = getChild(node, 'product_catalog')
  if (!catalog) throw new ZyrixError('invalid Business response: missing product_catalog', { kind: ErrorKind.PROTOCOL, errorCode: 'BUSINESS_RESPONSE_INVALID' })
  const paging = getChild(catalog, 'paging')
  return { products: getChildren(catalog, 'product').map(parseProduct), nextPageCursor: childText(paging, 'after') }
}
const parseCollections = (node) => {
  const root = getChild(node, 'collections')
  if (!root) throw new ZyrixError('invalid Business response: missing collections', { kind: ErrorKind.PROTOCOL, errorCode: 'BUSINESS_RESPONSE_INVALID' })
  return {
    collections: getChildren(root, 'collection').map((collection) => {
      const status = getChild(collection, 'status_info')
      return {
        id: requiredText(collection, 'id'),
        name: requiredText(collection, 'name'),
        products: getChildren(collection, 'product').map(parseProduct),
        status: { status: childText(status, 'status') || 'unknown', canAppeal: childText(status, 'can_appeal') === 'true' }
      }
    })
  }
}
const toProductNode = (productId, product) => {
  const attrs = {}
  const content = []
  const addText = (tag, value) => {
    if (value !== undefined) content.push({ tag, attrs: {}, content: Buffer.from(String(value)) })
  }
  if (productId !== undefined) addText('id', productId)
  addText('name', product.name)
  addText('description', product.description)
  addText('retailer_id', product.retailerId)
  if (product.images !== undefined) {
    if (!Array.isArray(product.images)) throw new TypeError('images must be an array')
    content.push({
      tag: 'media', attrs: {}, content: product.images.map((image) => {
        if (!image || typeof image.url !== 'string' || !image.url) throw new TypeError('every product image must be uploaded and have a url')
        return { tag: 'image', attrs: {}, content: [{ tag: 'url', attrs: {}, content: Buffer.from(image.url) }] }
      })
    })
  }
  addText('price', product.price)
  addText('currency', product.currency)
  if (Object.hasOwn(product, 'originCountryCode')) {
    if (product.originCountryCode === undefined) attrs.compliance_category = 'COUNTRY_ORIGIN_EXEMPT'
    else content.push({ tag: 'compliance_info', attrs: {}, content: [{ tag: 'country_code_origin', attrs: {}, content: Buffer.from(product.originCountryCode) }] })
  }
  if (product.isHidden !== undefined) attrs.is_hidden = String(Boolean(product.isHidden))
  return { tag: 'product', attrs, content }
}
const parseOrderDetails = (node) => {
  const order = getChild(node, 'order')
  if (!order) throw new ZyrixError('invalid Business response: missing order', { kind: ErrorKind.PROTOCOL, errorCode: 'BUSINESS_RESPONSE_INVALID' })
  const price = getChild(order, 'price')
  return {
    price: { total: Number(requiredText(price, 'total')), currency: requiredText(price, 'currency') },
    products: getChildren(order, 'product').map((product) => ({
      id: requiredText(product, 'id'),
      name: requiredText(product, 'name'),
      imageUrl: childText(getChild(product, 'image'), 'url') || '',
      price: Number(requiredText(product, 'price')),
      currency: requiredText(product, 'currency'),
      quantity: Number(requiredText(product, 'quantity'))
    }))
  }
}
const ensureId = (value, name) => {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a non-empty string`)
  return value.trim()
}

export default {
  async uploadBusinessImage(input, mediaType = 'product-catalog-image') {
    if (!['product-catalog-image', 'biz-cover-photo'].includes(mediaType)) throw new TypeError('Business upload type not allowed')
    const buffer = await toBuffer(input, this.maxMediaBytes)
    if (!buffer.length) throw new TypeError('the image cannot be empty')
    const digest = crypto.createHash('sha256').update(buffer).digest()
    const token = uploadToken(digest)
    const conn = await this.mediaConn()
    const pathname = mediaType === 'product-catalog-image' ? '/product/image' : '/pps/biz-cover-photo'
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zyrix-business-'))
    const tempFile = path.join(tempDir, 'image.bin')
    let lastError
    try {
      await fs.writeFile(tempFile, buffer, { mode: 0o600 })
      for (const host of conn.hosts || []) {
        if (typeof host !== 'string' || !(/^mmg\d+\.whatsapp\.net$/i.test(host) || host.toLowerCase() === 'mmg.whatsapp.net')) continue
        try {
          const response = await postFile(host, `${pathname}/${token}?auth=${encodeURIComponent(conn.auth)}&token=${token}`, tempFile, buffer.length)
          if (response.status < 200 || response.status >= 300) {
            if (response.status === 401 || response.status === 403) this.mediaConnCache = null
            lastError = new ZyrixError(`upload host responded ${response.status}`, { kind: ErrorKind.MEDIA, errorCode: 'UPLOAD_HOST_ERROR' })
            continue
          }
          const result = JSON.parse(response.body)
          if (result.url || result.direct_path || result.fbid) {
            const directPath = result.direct_path
            const url = result.url || (directPath ? `https://mmg.whatsapp.net${directPath}` : undefined)
            return { ...result, url, directPath, fileSha256: digest, fileLength: buffer.length }
          }
          lastError = new ZyrixError('the upload response has no url, direct_path or fbid', { kind: ErrorKind.MEDIA, errorCode: 'UPLOAD_RESPONSE_INVALID' })
        } catch (error) {
          lastError = error
        }
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
    }
    throw new ZyrixError(`Business image upload failed${lastError ? `: ${lastError.message}` : ''}`, { kind: ErrorKind.MEDIA, errorCode: 'MEDIA_UPLOAD_FAILED', cause: lastError })
  },

  async getCatalog({ jid, limit = 10, cursor } = {}) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit must be a positive integer')
    const target = jidNormalizedUser(jid || this.auth.state.creds.me?.id || '')
    const content = [
      { tag: 'limit', attrs: {}, content: Buffer.from(String(limit)) },
      { tag: 'width', attrs: {}, content: Buffer.from('100') },
      { tag: 'height', attrs: {}, content: Buffer.from('100') }
    ]
    if (cursor) content.push({ tag: 'after', attrs: {}, content: Buffer.from(String(cursor)) })
    const response = await this.query({
      tag: 'iq', attrs: { to: S, type: 'get', xmlns: 'w:biz:catalog' },
      content: [{ tag: 'product_catalog', attrs: { jid: target, allow_shop_source: 'true' }, content }]
    })
    return parseCatalog(response)
  },

  async getCollections(jid, limit = 51) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit must be a positive integer')
    const target = jidNormalizedUser(jid || this.auth.state.creds.me?.id || '')
    const response = await this.query({
      tag: 'iq', attrs: { to: S, type: 'get', xmlns: 'w:biz:catalog', smax_id: '35' },
      content: [{ tag: 'collections', attrs: { biz_jid: target }, content: [
        { tag: 'collection_limit', attrs: {}, content: Buffer.from(String(limit)) },
        { tag: 'item_limit', attrs: {}, content: Buffer.from(String(limit)) },
        { tag: 'width', attrs: {}, content: Buffer.from('100') },
        { tag: 'height', attrs: {}, content: Buffer.from('100') }
      ] }]
    })
    return parseCollections(response)
  },

  async getOrderDetails(orderId, tokenBase64) {
    ensureId(orderId, 'orderId')
    ensureId(tokenBase64, 'tokenBase64')
    const response = await this.query({
      tag: 'iq', attrs: { to: S, type: 'get', xmlns: 'fb:thrift_iq', smax_id: '5' },
      content: [{ tag: 'order', attrs: { op: 'get', id: orderId }, content: [
        { tag: 'image_dimensions', attrs: {}, content: [
          { tag: 'width', attrs: {}, content: Buffer.from('100') },
          { tag: 'height', attrs: {}, content: Buffer.from('100') }
        ] },
        { tag: 'token', attrs: {}, content: Buffer.from(tokenBase64) }
      ] }]
    })
    return parseOrderDetails(response)
  },

  async productCreate(product) {
    if (!product || typeof product !== 'object') throw new TypeError('product is required')
    for (const field of ['name', 'description', 'currency']) ensureId(product[field], field)
    if (!Number.isFinite(product.price) || product.price < 0) throw new TypeError('price must be a non-negative number')
    if (!Array.isArray(product.images) || product.images.length === 0) throw new TypeError('images must contain at least one image')
    const images = await Promise.all(product.images.map(async (image) => {
      const uploaded = await this.uploadBusinessImage(image, 'product-catalog-image')
      return { url: uploaded.url }
    }))
    const body = { ...product, images, isHidden: Boolean(product.isHidden) }
    const response = await this.query({
      tag: 'iq', attrs: { to: S, type: 'set', xmlns: 'w:biz:catalog' },
      content: [{ tag: 'product_catalog_add', attrs: { v: '1' }, content: [toProductNode(undefined, body),
        { tag: 'width', attrs: {}, content: '100' }, { tag: 'height', attrs: {}, content: '100' }
      ] }]
    })
    return parseProduct(getChild(getChild(response, 'product_catalog_add'), 'product'))
  },

  async productUpdate(productId, update) {
    ensureId(productId, 'productId')
    if (!update || typeof update !== 'object') throw new TypeError('update is required')
    const body = { ...update }
    if (update.images !== undefined) {
      if (!Array.isArray(update.images)) throw new TypeError('images must be an array')
      body.images = await Promise.all(update.images.map(async (image) => ({ url: (await this.uploadBusinessImage(image, 'product-catalog-image')).url })))
    }
    const response = await this.query({
      tag: 'iq', attrs: { to: S, type: 'set', xmlns: 'w:biz:catalog' },
      content: [{ tag: 'product_catalog_edit', attrs: { v: '1' }, content: [toProductNode(productId, body),
        { tag: 'width', attrs: {}, content: '100' }, { tag: 'height', attrs: {}, content: '100' }
      ] }]
    })
    return parseProduct(getChild(getChild(response, 'product_catalog_edit'), 'product'))
  },

  async productDelete(productIds) {
    if (!Array.isArray(productIds) || productIds.length === 0) throw new TypeError('productIds must contain at least one ID')
    const ids = productIds.map((id) => ensureId(id, 'productId'))
    const response = await this.query({
      tag: 'iq', attrs: { to: S, type: 'set', xmlns: 'w:biz:catalog' },
      content: [{ tag: 'product_catalog_delete', attrs: { v: '1' }, content: ids.map((id) => ({
        tag: 'product', attrs: {}, content: [{ tag: 'id', attrs: {}, content: Buffer.from(id) }]
      })) }]
    })
    const deleted = Number(getChild(response, 'product_catalog_delete')?.attrs?.deleted_count || 0)
    return { deleted }
  },

  async updateBusinessProfile(profile) {
    if (!profile || typeof profile !== 'object') throw new TypeError('profile is required')
    const content = []
    for (const field of ['address', 'email', 'description']) {
      if (profile[field] !== undefined && profile[field] !== null) {
        if (typeof profile[field] !== 'string') throw new TypeError(`${field} must be a string`)
        content.push({ tag: field, attrs: {}, content: profile[field] })
      }
    }
    if (profile.websites !== undefined) {
      if (!Array.isArray(profile.websites) || profile.websites.some((website) => typeof website !== 'string')) throw new TypeError('websites must be an array of URL strings')
      for (const website of profile.websites) content.push({ tag: 'website', attrs: {}, content: website })
    }
    if (profile.hours !== undefined) {
      const { timezone, days } = profile.hours || {}
      if (typeof timezone !== 'string' || !Array.isArray(days)) throw new TypeError('hours requires timezone and days')
      content.push({ tag: 'business_hours', attrs: { timezone }, content: days.map((day) => {
        if (!day || !['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].includes(day.day)) throw new TypeError('invalid business-hours day')
        if (!['specific_hours', 'open_24h', 'appointment_only'].includes(day.mode)) throw new TypeError('invalid business-hours mode')
        const attrs = { day_of_week: day.day, mode: day.mode }
        if (day.mode === 'specific_hours') {
          const open = Number(day.openTimeInMinutes)
          const close = Number(day.closeTimeInMinutes)
          if (!Number.isInteger(open) || !Number.isInteger(close) || open < 0 || open > 1439 || close < 0 || close > 1439) throw new RangeError('business hours must be between 0 and 1439 minutes')
          attrs.open_time = String(open)
          attrs.close_time = String(close)
        }
        return { tag: 'business_hours_config', attrs }
      }) })
    }
    if (!content.length) throw new TypeError('profile must include at least one field')
    return this.query({ tag: 'iq', attrs: { to: S, type: 'set', xmlns: 'w:biz' }, content: [
      { tag: 'business_profile', attrs: { v: '3', mutation_type: 'delta' }, content }
    ] })
  },

  async updateCoverPhoto(image) {
    const uploaded = await this.uploadBusinessImage(image, 'biz-cover-photo')
    if (uploaded.fbid == null || !uploaded.meta_hmac || uploaded.ts == null) throw new ZyrixError('incomplete Business upload response; cannot update the cover photo', { kind: ErrorKind.MEDIA, errorCode: 'UPLOAD_RESPONSE_INVALID' })
    return this.query({ tag: 'iq', attrs: { to: S, type: 'set', xmlns: 'w:biz' }, content: [
      { tag: 'business_profile', attrs: { v: '3', mutation_type: 'delta' }, content: [
        { tag: 'cover_photo', attrs: { id: String(uploaded.fbid), op: 'update', token: uploaded.meta_hmac, ts: String(uploaded.ts) } }
      ] }
    ] })
  },

  async removeCoverPhoto(id) {
    ensureId(id, 'id')
    return this.query({ tag: 'iq', attrs: { to: S, type: 'set', xmlns: 'w:biz' }, content: [
      { tag: 'business_profile', attrs: { v: '3', mutation_type: 'delta' }, content: [
        { tag: 'cover_photo', attrs: { op: 'delete', id } }
      ] }
    ] })
  }
}
