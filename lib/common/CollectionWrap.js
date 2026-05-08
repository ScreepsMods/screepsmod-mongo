const { ObjectId } = require('mongodb')
class CollectionWrap {
  constructor (collection, name) {
    this.col = collection
    this.name = name
  }

  async find (query = {}, filter = {}, opts = {}) {
    query = this._patchQuery(query)
    const options = /** @type {any} */ (Object.assign({}, opts))
    if (filter && Object.keys(filter).length) {
      options.projection = filter
    }
    const res = await this.col.find(query, options).toArray()
    return this._idToKey(res)
  }

  async findOne (query = {}, filter = {}, opts = {}) {
    query = this._patchQuery(query)
    const options = /** @type {any} */ (Object.assign({}, opts))
    if (filter && Object.keys(filter).length) {
      options.projection = filter
    }
    const res = await this.col.findOne(query, options)
    return this._idToKey(res)
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
    return this._idToKey(res)
  }

  async count (query = {}, opts) {
    query = this._patchQuery(query)
    const res = await this.col.countDocuments(query, opts)
    return res
  }

  async ensureIndex (fieldOrSpec, opts) {
    const res = await this.col.ensureIndex(fieldOrSpec, opts)
    return res
  }

  async remove (selector, opts) {
    if (selector && typeof selector === 'object') {
      selector = this._patchQuery(selector)
      const res = await this.col.deleteMany(selector, opts)
      return res
    }
    const query = typeof selector === 'undefined' ? {} : { _id: selector }
    const res = await this.col.deleteOne(query, opts)
    return res
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
      const { insertedId } = await this.col.insertOne(doc, opts)
      orig._id = insertedId
    }
    return this._idToKey(orig)
  }

  async update (query, doc, opts = {}) {
    // Allows for Loki's single arg style
    if (query && !doc) {
      doc = query
      query = doc._id
      delete doc._id
    }
    query = typeof query === 'object' ? query : { _id: query }
    query = this._patchQuery(query)
    if (opts.multi !== false && doc && Object.keys(doc).find(v => v[0] === '$')) {
      opts.multi = true
    }
    if (doc.$merge) {
      doc.$set = this._flat(doc.$merge)
      delete doc.$merge
    }
    const mongoOpts = /** @type {any} */ (Object.assign({}, opts))
    const isMulti = mongoOpts.multi
    delete mongoOpts.multi
    const isOperatorUpdate = Object.keys(doc).some(key => key[0] === '$')
    let res
    if (isOperatorUpdate) {
      res = isMulti
        ? await this.col.updateMany(query, doc, mongoOpts)
        : await this.col.updateOne(query, doc, mongoOpts)
    } else if (isMulti) {
      // MongoDB does not support replacement updates with multi=true.
      // Keep compatibility by treating this as a field merge.
      res = await this.col.updateMany(query, { $set: doc }, mongoOpts)
    } else {
      res = await this.col.replaceOne(query, doc, mongoOpts)
    }
    res.modified = res.modifiedCount
    res.result = {
      n: res.matchedCount,
      nModified: res.modifiedCount,
      ok: 1
    }
    return this._idToKey(res)
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
        const filter = { _id: (i.id && i.id.length === 24) ? new ObjectId(i.id + '') : i.id }
        if (i.op === 'update') {
          return batch.find(filter).update(i.update)
        }
        if (i.op === 'remove') {
          return batch.find(filter).remove()
        }
        console.error('UNKNOWN BULK!', i)
      })
      return new Promise((resolve, reject) => {
        batch.execute((err, result) => (err ? reject(err) : resolve(result)))
      })
    } catch (e) {
      if (!(e instanceof Error)) return
      if (cb) cb(e.message) // TODO: Check if screeps uses this cb
      console.error(e)
      return Promise.reject(e.message)
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
    if (obj instanceof Array) return obj.map(v => this._keyToId(v))
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
    if (obj instanceof Array) return obj.map(v => this._idToKey(v))
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
        query.$eq = v
      }
      if (k === '$regex') {
        // https://github.com/screeps/backend-local/blob/7520c8c7e6a443ad955d25e064dbd151a909d8cb/lib/cronjobs.js#L574
        // const centralRooms = await db['rooms'].find({_id: {$regex: '^[WE]\d*5[NS]\d*5$'}, status: {$ne: 'out of borders'}});
        //
        // regex is not properly escaped resulting in only a subset of possible sectors actually returning
        if (v === '^[WE]d*5[NS]d*5$') {
          query.$regex = v.replace(/\]d\*/g, ']\\d*')

          // https://github.com/screeps/backend-local/blob/7520c8c7e6a443ad955d25e064dbd151a909d8cb/lib/cronjobs.js#L393
          // https://github.com/screeps/backend-local/blob/7520c8c7e6a443ad955d25e064dbd151a909d8cb/lib/strongholds.js#L132
          //
          // ignore properly escaped sector regex queries
        } else if (typeof v === 'string' && v.match(/\^[EW]\d*\\d[NS]\d*\\d\$/g) === null && v.match(/\^\[[EW]{2}\]\\d\*5\[[NS]{2}\]\\d\*5\$/g) === null) {
          // default regex escape fix for loki regex queries to work with mongo regex queries
          query.$regex = v.replace(/\\{1,2}/g, '\\\\')
        } else {
          query.$regex = v
        }
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
