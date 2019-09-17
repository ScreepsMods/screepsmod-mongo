const q = require('q')
const { ObjectId } = require('mongodb')
class CollectionWrap {
  constructor (collection, name) {
    this.col = collection
    this.name = name
  }
  async find (query = {}, filter = {}, opts = {}) {
    query = this._patchQuery(query)
    const res = await this.col.find(query, filter, opts).toArray()
    return q(this._idToKey(res))
  }
  async findOne (query = {}, filter = {}, opts = {}) {
    query = this._patchQuery(query)
    const res = await this.col.findOne(query, filter, opts)
    return q(this._idToKey(res))
  }
  async findEx (query = {}, opts = {}) {
    query = this._patchQuery(query)
    const cur = this.col.find(query)
    if (opts.sort) {
      cur.sort(opts.sort)
    }
    if (opts.offset) {
      cur.offset(opts.offset)
    }
    if (opts.limit) {
      cur.limit(opts.limit)
    }
    const res = await cur.toArray()
    return q(this._idToKey(res))
  }
  async count (query = {}, opts) {
    query = this._patchQuery(query)
    const res = await this.col.count(query, opts)
    return q(res)
  }
  async ensureIndex (fieldOrSpec, opts) {
    const res = await this.col.ensureIndex(fieldOrSpec, opts)
    return q(res)
  }
  async remove (selector, opts) {
    if (typeof selector === 'object') {
      selector = this._patchQuery(selector)
    }
    if (Array.isArray(selector)) {
      const res = await this.col.removeMany(selector, opts)
      return q(res)
    } else {
      const res = await this.col.removeOne(selector, opts)
      return q(res)
    }
  }
  removeWhere (selector, opts) {
    return this.remove(selector, opts)
  }
  async insert (doc, opts) {
    const orig = doc
    doc = this._patchQuery(doc)
    if (Array.isArray(doc)) {
      const { insertedIds } = await this.col.insertMany(doc, opts)
      orig.forEach((o, i) => {
        o._id = insertedIds[i]
      })
    } else {
      const { insertedId } = await this.col.insert(doc, opts)
      orig._id = insertedId
    }
    return q(orig).then(this._idToKey)
  }
  async update (query, doc, opts = {}) {
    query = this._patchQuery(query)
    // Allows for Loki's single arg style
    if (query && !doc) {
      doc = query
      query = doc._id
      delete doc._id
    }
    if (opts.multi !== false && Object.keys(opts).find(v => v[0] === '$')) {
      opts.multi = true
    }
    if (doc.$merge) {
      doc.$set = this._flat(doc.$merge)
      delete doc.$merge
    }
    const res = await this.col.update(query, doc, opts)
    res.modified = res.result.nModified
    return q(res).then(this._idToKey)
  }
  async drop (opts) {
    try {
      await this.col.drop(opts)
    } catch (e) {}
  }
  clear () {
    return this.drop
  }
  by (_id) { // TODO: Where is this used?
    return this.find({ _id })
  }
  bulk (bulk, cb) {
    const batch = this.col.initializeUnorderedBulkOp()
    try {
      bulk.forEach(i => {
        if (i.op === 'insert') {
          return batch.insert(i.data)
        }
        let q = { _id: (i.id && i.id.length === 24) ? new ObjectId(i.id + '') : i.id }
        if (i.op === 'update') {
          return batch.find(q).update(i.update)
        }
        if (i.op === 'remove') {
          return batch.find(q).remove()
        }
        console.error('UNKNOWN BULK!', i)
      })
      return q(batch.execute())
    } catch (e) {
      if (cb) cb(e.message) // TODO: Check if screeps uses this cb
      console.error(e)
      return q.reject(e.message)
    }
  }
  _flat (obj, stack = []) {
    const ret = {}
    if (typeof obj === 'object' && !Array.isArray(obj)) {
      Object.entries(obj).forEach(([k, v]) => {
        Object.assign(ret, this._flat(v, [...stack, k]))
      })
    } else if (stack.length) {
      ret[stack.join('.')] = obj
    } else {
      return obj
    }
    return ret
  }
  _keyToId (obj) {
    const idRegex = /^[a-f0-9]{24}$/
    if (obj instanceof Array) return obj.map(this._keyToId)
    if (obj._id && obj._id.$in) {
      return Object.assign({}, obj, {
        _id: {
          $in: obj._id.$in.map(i => {
            if (typeof i === 'string' && i.match(idRegex)) {
              i = new ObjectId(i)
            }
            return i
          })
        }
      })
    }
    if (typeof obj._id === 'string' && obj._id.match(idRegex)) {
      return Object.assign({}, obj, { _id: new ObjectId(obj._id) })
    }
    return obj
  }
  _idToKey (obj) {
    if (obj instanceof Array) return obj.map(this._idToKey)
    if (obj && obj._id) {
      obj._id = obj._id.toString()
    }
    return obj
  }
  _patchLokiOps (query, depth = 5) {
    if (!depth) return
    for (const k in query) {
      const v = query[k]
      if (k === '$aeq') {
        delete query[k]
        query['$eq'] = v
      }
      if (typeof v === 'object') {
        this._patchLokiOps(v, depth - 1)
      }
    }
  }
  _patchQuery (query) {
    query = this._keyToId(query)
    this._patchLokiOps(query)
    return query
  }
}
module.exports = CollectionWrap
