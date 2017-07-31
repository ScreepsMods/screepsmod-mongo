const q = require('q')
const EventEmitter = require('events').EventEmitter
const { MongoClient, ObjectId } = require('mongodb')
const Redis = require('redis')

module.exports = function (config) {
  Object.assign(exports,config.common.storage)

  return function storageConnect () {
    if (exports._connected) {
      return q.when()
    }

    let uri = process.env.MONGO_URI || 'mongodb://mongo:27017/screeps'
    let host = process.env.REDIS_HOST || 'redis'

    let redis = Redis.createClient({ host })
    let pub = Redis.createClient({ host })
    let sub = Redis.createClient({ host })

    let mongo = q.ninvoke(MongoClient, 'connect', uri, { promiseLibrary: Promise })
      .then(db => {
        function wrapCollection (collection, cname) {
          let wrap = {}
          function keyToId (obj) {
            let idRegex = /^[a-f0-9]{24}$/
            if (obj instanceof Array) return obj.map(keyToId)
            if (obj._id && obj._id.$in) {
              return Object.assign({}, obj, { _id: { $in: obj._id.$in.map(i => i.match(idRegex) ? new ObjectId(i) : i) } })
            }
            if (typeof obj._id === 'string' && obj._id.match(idRegex)) {
              return Object.assign({}, obj, { _id: new ObjectId(obj._id) })
            }
            return obj
          }
          function idToKey (obj) {
            if (obj && obj._id) {
              obj._id = obj._id.toString()
            }
            return obj
          }
          ;['find', 'findOne', 'findEx', 'by', 'count', 'ensureIndex', 'remove', 'insert', 'update'].forEach(method => {
            wrap[method] = (...a) => {
              try {
                let orig = a[0]
                if (typeof a[0] === 'object') {
                  a[0] = keyToId(a[0])
                }
                if (method === 'update') {
                  a[2] = a[2] || {}
                  if (a[2].multi !== false) a[2].multi = true
                }
                let ex = method === 'findEx'
                if (ex) method = 'find'
                let chain = collection[method](...a)
                if (method === 'insert') {
                  chain = chain.then((n) => Object.assign(orig, n))
                }
                if (method === 'update') {
                  chain = chain.then((n) => Object.assign(n, { modified: n.result.nModified }))
                }
                if (ex) {
                  let opts = a[1]
                  if (opts.sort) {
                    chain = chain.sort(opts.sort)
                  }
                  if (opts.offset) {
                    chain = chain.offset(opts.offset)
                  }
                  if (opts.limit) {
                    chain = chain.limit(opts.limit)
                  }
                }
                if (method === 'find') {
                  chain = q.ninvoke(chain, 'toArray')
                }
                return chain.then(idToKey)
                  .catch(e => {
                    console.error('DBERR', e, ex)
                    console.log('DBERR', e.stack)
                  })
              } catch (e) {
                console.error('DBERR', e)
                console.log('DBERR', e.stack)
                return Promise.reject(e)
              }
            }
          })

          wrap.drop = (...a) => {
            return q.ninvoke(collection, 'drop', ...a).catch(e => q.resolve())
          }
          wrap.clear = wrap.drop
          wrap.removeWhere = wrap.remove
          wrap.by = (_id) => wrap.find({ _id })
          wrap.bulk = function (bulk, cb) {
            let batch = collection.initializeUnorderedBulkOp()
            try {
              bulk.forEach(i => {
                if (i.op === 'insert') {
                  return batch.insert(i.data)
                }
                let q = { _id: (i.id && i.id.length === 24) ? new ObjectId(i.id + '') : i.id }
                if (i.op === 'update') {
                  return batch.find(q).update({ $set: i.$set })
                }
                if (i.op === 'remove') {
                  return batch.find(q).remove()
                }
                if (i.op === 'inc') {
                  return batch.find(q).update({$inc: { [i.key]: i.amount }})
                }
                console.error('UNKNOWN BULK!', i)
              })
              return q.ninvoke(batch, 'execute')
            } catch (e) {
              if (cb) cb(e.message)
              console.error(e)
              return q.reject(e.message)
            }
          }
          return wrap
        }
        config.common.dbCollections.forEach(i => (exports.db[i] = wrapCollection(db.collection(i), i)))

        return exports.db.users.count().then(count => {
          let ps = []
          if (!count) {
            ps.push(exports.db.users.insert({ _id: '2', username: 'Invader', usernameLower: 'invader', cpu: 100, cpuAvailable: 10000, gcl: 13966610.2, active: 0 }))
            ps.push(exports.db.users.insert({ _id: '3', username: 'Source Keeper', usernameLower: 'source keeper', cpu: 100, cpuAvailable: 10000, gcl: 13966610.2, active: 0 }))
            ps.push(exports.env.set('gameTime', 1))
          }
          return q.all(ps).catch(err => console.error(err))
        })
      })

    Object.assign(exports.pubsub, {
      ee: new EventEmitter(),
      subscribed: {},
      publish (channel, data) {
        pub.publish(channel, data)
        return q.when()
      },
      subscribe (channel, cb) {
        if (!this.subscribed[channel]) {
          if (channel.match(/[?*]/)) { sub.psubscribe(channel) } else { sub.subscribe(channel) }
          this.subscribed[channel] = true
        }
        this.ee.on(channel, cb)
        return q.when()
      },
      once (channel, cb) {
        if (!this.subscribed[channel]) {
          if (channel.match(/[?*]/)) { sub.psubscribe(channel) } else { sub.subscribe(channel) }
          this.subscribed[channel] = true
        }
        this.ee.once(channel, cb)
        return q.when()
      }
    })
    sub.on('message', (channel, message) => {
      exports.pubsub.ee.emit(channel, message)
    })
    sub.on('pmessage', (pattern, channel, message) => {
      exports.pubsub.ee.emit(channel, message)
      exports.pubsub.ee.emit(pattern, channel, message)
    })

    Object.assign(exports.env, {
      get: q.nbind(redis.get, redis),
      mget: q.nbind(redis.mget, redis),
      set: q.nbind(redis.set, redis),
      setex: q.nbind(redis.setex, redis),
      expire: q.nbind(redis.expire, redis),
      ttl: q.nbind(redis.ttl, redis),
      del: q.nbind(redis.del, redis),
      hmget: q.nbind(redis.hmget, redis),
      hmset: q.nbind(redis.hmset, redis),
      hget: q.nbind(redis.hget, redis),
      hset: q.nbind(redis.hset, redis),
      hgetall: q.nbind(redis.hgetall, redis),
      incr: q.nbind(redis.incr, redis)
    })

    exports._connected = true
    exports.resetAllData = () => q.when() // Temp dummy

    Object.assign(exports.queue, require('./queue'))
    exports.queue.wrap(redis, exports.pubsub)

    let oget = exports.env.get
    exports.env.get = function (...a) {
      return oget(...a).catch(() => exports.env.hgetall(...a))
    }

    return mongo
  }
}
