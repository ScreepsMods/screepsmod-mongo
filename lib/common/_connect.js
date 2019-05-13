const q = require('q')
const EventEmitter = require('events').EventEmitter
const { MongoClient, ObjectId } = require('mongodb')
const Redis = require('redis')
const fs = require('fs')

const DATABASE_VERSION = 3.2

let C

module.exports = function (config) {
  Object.assign(exports, config.common.storage)
  C = config.common.constants
  return function storageConnect () {
    if (exports._connected) {
      return q.when()
    }
    let uri

    if (config.mongo.uri) {
      uri = config.mongo.uri
    } else {
      uri = `mongodb://${config.mongo.host}:${config.mongo.port}/${config.mongo.database}`
    }
    delete config.mongo.host
    delete config.mongo.port
    delete config.mongo.database

    let redis = Redis.createClient(config.redis)
    let pub = Redis.createClient(config.redis)
    let sub = Redis.createClient(config.redis)

    let mongo = q.ninvoke(MongoClient, 'connect', uri, Object.assign({ promiseLibrary: Promise }, config.mongo))
      .then(db => {
        function wrapCollection (collection, cname) {
          let wrap = {}
          function keyToId (obj) {
            let idRegex = /^[a-f0-9]{24}$/
            if (obj instanceof Array) return obj.map(keyToId)
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
          function idToKey (obj) {
            if (obj instanceof Array) return obj.map(idToKey)
            if (obj && obj._id) {
              obj._id = obj._id.toString()
            }
            return obj
          }
          function patchLokiOps (query, depth = 5) {
            if (!depth) return
            for (const k in query) {
              const v = query[k]
              if (k === '$aeq') {
                delete query[k]
                query['$eq'] = v
              }
              if (typeof v === 'object') {
                patchLokiOps(v, depth - 1)
              }
            }
          }
          ;['find', 'findOne', 'findEx', 'by', 'count', 'ensureIndex', 'remove', 'insert', 'update'].forEach(method => {
            wrap[method] = (...a) => {
              try {
                let orig = a[0]
                if (typeof a[0] === 'object') {
                  a[0] = keyToId(a[0])
                  patchLokiOps(a[0])
                }
                if (method === 'update') {
                  a[2] = a[2] || {}
                  if (a[2].multi !== false && Object.keys(a[1]).reduce((l, v) => l && v[0] === '$', true)) {
                    a[2].multi = true
                  }
                  if (a[1].$merge) {
                    let merge = a[1].$merge
                    delete a[1].$merge
                    let flat = (obj, stack = []) => {
                      const ret = {}
                      if (typeof obj === 'object' && !Array.isArray(obj)) {
                        Object.entries(obj).forEach(([k, v]) => {
                          Object.assign(ret, flat(v, [...stack, k]))
                        })
                      } else if (stack.length) {
                        ret[stack.join('.')] = obj
                      } else {
                        return obj
                      }
                      return ret
                    }
                    a[1].$set = flat(merge)
                  }
                }
                let ex = method === 'findEx'
                if (ex) method = 'find'
                if (method.slice(0, 6) === 'insert') method = Array.isArray(a[0]) ? 'insertMany' : 'insertOne'

                let chain = collection[method](...a)
                if (method === 'insertOne') {
                  chain = chain.then((n) => {
                    orig._id = n.insertedId
                    return orig
                  })
                }
                if (method === 'insertMany') {
                  chain = chain.then((n) => {
                    orig.forEach((o, i) => (o._id = n.insertedIds[i]))
                    return orig
                  })
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
                chain = chain.then(idToKey)
                  .catch(e => {
                    console.error('DBERR', e, ex, a)
                    console.log('DBERR', e.stack)
                  })
                return q(chain)
              } catch (e) {
                console.error('DBERR', e)
                console.log('DBERR', e.stack)
                return q(Promise.reject(e))
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
                  if (i.data._id && typeof i.data._id === 'string' && i.data._id.length === 24) {
                    i.data._id = new ObjectId(i.data._id)
                  }
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
              return q.ninvoke(batch, 'execute')
            } catch (e) {
              if (cb) cb(e.message)
              console.error(e)
              return q.reject(e.message)
            }
          }
          return wrap
        }
        config.common.dbCollections.forEach(i => {
          let collection = db.collection(i)
          let indexes = config.common.dbIndexes[i]
          if (indexes) {
            for (let k in indexes) {
              collection.ensureIndex({ [k]: indexes[k] })
            }
          }
          exports.db[i] = wrapCollection(collection, i)
        })

        exports.upgradeDB()
      })

    Object.assign(exports.pubsub, {
      ee: new EventEmitter(),
      subscribed: {},
      publish (channel, data) {
        pub.publish(channel, data)
        pub.publish('*', channel, data)
        return q.when()
      },
      subscribe (channel, cb) {
        if (!this.subscribed[channel]) {
          sub.subscribe(channel)
          this.subscribed[channel] = true
        }
        this.ee.on(channel, (channel, ...args) => {
          cb.apply({ channel }, args)
        })
        return q.when()
      },
      once (channel, cb) {
        if (!this.subscribed[channel]) {
          sub.subscribe(channel)
          this.subscribed[channel] = true
        }
        this.ee.once(channel, (channel, ...args) => {
          cb.apply({ channel }, args)
        })
        return q.when()
      }
    })
    sub.on('message', (channel, message) => {
      exports.pubsub.ee.emit(channel, channel, message)
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
      incr: q.nbind(redis.incr, redis),
      flushall: q.nbind(redis.flushall, redis)
    })

    exports._connected = true
    exports.resetAllData = () => q.when() // Temp dummy

    Object.assign(exports.queue, require('./queue'))
    exports.queue.wrap(redis, exports.pubsub)

    let oget = exports.env.get
    exports.env.get = function (...a) {
      return oget(...a).catch(() => exports.env.hgetall(...a))
    }

    exports.resetAllData = () => {
      return exports.importDB(`${__dirname}/../../db.original.json`).then((r) => q.when(r))
    }
    Object.assign(config.common.storage, exports)
    return mongo
  }
}

exports.importDB = function importDB (path = './db.json') {
  let { db, env } = exports
  console.log('Importing DB')
  try {
    let olddb = JSON.parse(fs.readFileSync(path).toString())
    let ps = olddb.collections.map(oldcol => {
      let name = oldcol.name
      console.log('Collection', name)
      if (name === 'env') {
        return env.flushall().then(() => {
          let p = oldcol.data.map(row => {
            let ps = []
            for (let k in row.data) {
              let v = row.data[k]
              let type = k.slice(0, k.indexOf(':'))
              let hashTypes = [env.keys.MEMORY_SEGMENTS, env.keys.ROOM_HISTORY, env.keys.ROOM_EVENT_LOG]
              if (hashTypes.indexOf(type) !== -1) {
                for (let kk in v) {
                  ps.push(env.hmset(k, kk, typeof v[kk] === 'object' ? JSON.stringify(v[kk]) : v[kk]))
                }
              } else {
                ps.push(env.set(k, typeof v === 'object' ? JSON.stringify(v) : v))
              }
            }
            return Promise.all(ps)
          })
          return Promise.all(p)
        })
      } else {
        if (!db[name]) {
          console.log(`invalid collection in db.json: ${name}`)
          return
        }
        return db[name].drop().then(() => Promise.all(oldcol.data.map(row => {
          delete row.meta
          delete row.$loki
          return db[name].insert(row)
        })))
      }
    })
    ps.push(db.users.update({ _id: '2' }, { $set: { _id: '2', username: 'Invader', usernameLower: 'invader', cpu: 100, cpuAvailable: 10000, gcl: 13966610.2, active: 0 } }, { upsert: true }))
    ps.push(db.users.update({ _id: '3' }, { $set: { _id: '3', username: 'Source Keeper', usernameLower: 'source keeper', cpu: 100, cpuAvailable: 10000, gcl: 13966610.2, active: 0 } }, { upsert: true }))
    ps.push(db.users.update({ username: 'Screeps' }, { username: 'Screeps', usernameLower: 'screeps', gcl: 0, cpi: 0, active: false, cpuAvailable: 0, badge: { type: 12, color1: '#999999', color2: '#999999', color3: '#999999', flip: false, param: 26 } }, { upsert: true }))
    ps.push(env.set(env.keys.DATABASE_VERSION, DATABASE_VERSION))
    return Promise.all(ps)
      .then(() => console.log('Import complete. Restart the server for best results.'))
      .then(() => 'Import complete. Restart the server for best results.')
      .catch(e => importFail(e))
  } catch (e) {
    return importFail(e)
  }
}

function importFail (e) {
  let { db, env } = exports
  let ps = []
  ps.push(db.users.insert({ _id: '2', username: 'Invader', usernameLower: 'invader', cpu: 100, cpuAvailable: 10000, gcl: 13966610.2, active: 0 }))
  ps.push(db.users.insert({ _id: '3', username: 'Source Keeper', usernameLower: 'source keeper', cpu: 100, cpuAvailable: 10000, gcl: 13966610.2, active: 0 }))
  ps.push(db.users.insert({ username: 'Screeps', usernameLower: 'screeps', gcl: 0, cpi: 0, active: false, cpuAvailable: 0, badge: { type: 12, color1: '#999999', color2: '#999999', color3: '#999999', flip: false, param: 26 } }))
  ps.push(env.set('gameTime', 1))
  ps.push(env.set(env.keys.DATABASE_VERSION, DATABASE_VERSION))
  return Promise.resolve()
    .then(() => console.log('An error occured importing existing db, initializing blank server'))
    .then(() => console.error(e))
    .then(() => Promise.all(ps))
    .then(() => console.log('Server initialzed. Remember to generate rooms.'))
    .catch(err => console.error(err))
}

exports.upgradeDB = async function upgradeDB () {
  let { db, env } = exports
  const version = parseFloat(await env.get(env.keys.DATABASE_VERSION) || 1)
  let ps = []
  if (version === DATABASE_VERSION) return
  console.log('Database Upgrade needed')
  if (version < 2) {
    console.log('Applying version 2')
    ps.push(db.users.update({ money: { $gt: 0 } }, { $mul: { money: 1000 } }))
    ps.push(db['market.orders'].update({}, { $mul: { price: 1000 } }))
    ps.push(db.users.update({ username: 'Screeps' }, { username: 'Screeps', usernameLower: 'screeps', gcl: 0, cpi: 0, active: false, cpuAvailable: 0, badge: { type: 12, color1: '#999999', color2: '#999999', color3: '#999999', flip: false, param: 26 } }, { upsert: true }))
  }
  if (version < 3.1) {
    console.log('Applying version 3.1')
    await db.rooms.update({}, { $unset: { bus: true } })
    await db.rooms.update({ _id: /^[EW]\d*0[NS]\d+$/ }, { $set: { bus: true } })
    await db.rooms.update({ _id: /^[EW]\d+[NS]\d*0$/ }, { $set: { bus: true } })
  }
  if (version < 3.2) {
    console.log('Applying version 3.2')
    const time = +(await env.get('gameTime'))
    await db['rooms.objects'].remove({ type: 'powerCreep', ageTime: { $lt: time } })
  }

  if (version < 4 && DATABASE_VERSION >= 4) { // Factories update
    const depositTypes = [C.RESOURCE_SILICON, C.RESOURCE_METAL, C.RESOURCE_BIOMASS, C.RESOURCE_MIST]
    const busRooms = db.rooms.find({ $or: [{ _id: { $regex: /^[WE]\d*0[NS]/ } }, { _id: { $regex: /0$/ } }] })
    for (const room of busRooms) {
      const [match, longitude, latitude] = /^[WE](\d+)[NS](\d+)$/.exec(room._id)
      if (match) {
        room.depositType = depositTypes[(longitude + latitude) % 4]
        ps.push(db.rooms.update(room))
      }
    }
  }
  await Promise.all(ps)
  await env.set(env.keys.DATABASE_VERSION, '' + DATABASE_VERSION)
  console.log(`Database upgraded to version ${DATABASE_VERSION}`)
}
