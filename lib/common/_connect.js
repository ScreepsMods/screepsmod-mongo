const q = require('q')
const EventEmitter = require('events').EventEmitter
const { MongoClient, ObjectId } = require('mongodb')
const Redis = require('redis')
const fs = require('fs')

const DATABASE_VERSION = 9

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

    const redis = Redis.createClient(config.redis)
    const pub = Redis.createClient(config.redis)
    const sub = Redis.createClient(config.redis)

    const mongo = q.ninvoke(MongoClient, 'connect', uri, Object.assign({ promiseLibrary: Promise, useUnifiedTopology: true }, config.mongo))
      .then(client => client.db())
      .then(db => {
        function wrapCollection (collection, cname) {
          const wrap = {}
          function keyToId (obj) {
            const idRegex = /^[a-f0-9]{24}$/
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
                query.$eq = v
              }
              if (typeof v === 'object') {
                patchLokiOps(v, depth - 1)
              }
            }
          }
          ;['find', 'findOne', 'findEx', 'by', 'count', 'ensureIndex', 'remove', 'insert', 'update'].forEach(cmethod => {
            wrap[cmethod] = (...a) => {
              let method = cmethod
              try {
                const orig = a[0]
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
                    const merge = a[1].$merge
                    delete a[1].$merge
                    const flat = (obj, stack = []) => {
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
                const ex = method === 'findEx'
                if (method === 'find' && a[1]) {
                  a[1] = { projection: a[1] }
                }
                if (ex) {
                  method = 'find'
                  a[1].skip = a[1].offset
                  delete a[1].offset
                }
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
            const batch = collection.initializeUnorderedBulkOp()
            try {
              bulk.forEach(i => {
                if (i.op === 'insert') {
                  if (i.data._id && typeof i.data._id === 'string' && i.data._id.length === 24) {
                    i.data._id = new ObjectId(i.data._id)
                  }
                  return batch.insert(i.data)
                }
                const q = { _id: (i.id && i.id.length === 24) ? new ObjectId(i.id + '') : i.id }
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
          const collection = db.collection(i)
          const indexes = config.common.dbIndexes[i]
          if (indexes) {
            for (const k in indexes) {
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
        return q.when()
      },
      subscribe (channel, cb) {
        if (!this.subscribed[channel]) {
          if (channel.match(/[?*]/)) { sub.psubscribe(channel) } else { sub.subscribe(channel) }
          this.subscribed[channel] = true
        }
        this.ee.on(channel, (channel, ...args) => {
          cb.apply({ channel }, args)
        })
        return q.when()
      },
      once (channel, cb) {
        if (!this.subscribed[channel]) {
          if (channel.match(/[?*]/)) { sub.psubscribe(channel) } else { sub.subscribe(channel) }
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
    sub.on('pmessage', (pattern, channel, message) => {
      exports.pubsub.ee.emit(pattern, channel, message)
    })

    Object.assign(exports.env, {
      get: q.nbind(redis.get, redis),
      mget: q.nbind(redis.mget, redis),
      sadd: q.nbind(redis.sadd, redis),
      smembers: q.nbind(redis.smembers, redis),
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

    const oget = exports.env.get
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

exports.importDB = async function importDB (path = './db.json') {
  const { db, env } = exports
  console.log('Importing DB')
  try {
    const olddb = JSON.parse(fs.readFileSync(path).toString())
    const ps = olddb.collections.map(oldcol => {
      const name = oldcol.name
      console.log('Collection', name)
      if (name === 'env') {
        return env.flushall().then(() => {
          const p = oldcol.data.map(row => {
            const ps = []
            for (const k in row.data) {
              const v = row.data[k]
              const type = k.slice(0, k.indexOf(':') + 1)
              const hashTypes = [env.keys.MEMORY_SEGMENTS, env.keys.ROOM_HISTORY, env.keys.ROOM_EVENT_LOG]
              if (hashTypes.includes(type)) {
                for (const kk in v) {
                  ps.push(env.hmset(k, kk, typeof v[kk] === 'object' ? JSON.stringify(v[kk]) : v[kk]))
                }
              } else if (k === env.keys.ACTIVE_ROOMS) {
                ps.push(env.sadd(env.keys.ACTIVE_ROOMS, v))
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

    await Promise.all(ps)
    await db.users.update({ _id: '2' }, { $set: { _id: '2', username: 'Invader', usernameLower: 'invader', cpu: 100, cpuAvailable: 10000, gcl: 13966610.2, active: 0 } }, { upsert: true })
    await db.users.update({ _id: '3' }, { $set: { _id: '3', username: 'Source Keeper', usernameLower: 'source keeper', cpu: 100, cpuAvailable: 10000, gcl: 13966610.2, active: 0 } }, { upsert: true })
    await db.users.update({ username: 'Screeps' }, { username: 'Screeps', usernameLower: 'screeps', gcl: 0, cpi: 0, active: false, cpuAvailable: 0, badge: { type: 12, color1: '#999999', color2: '#999999', color3: '#999999', flip: false, param: 26 } }, { upsert: true })
    await env.set(env.keys.DATABASE_VERSION, DATABASE_VERSION)
    await upgradeDB()
    console.log('Import complete. Restart the server for best results.')
    return 'Import complete. Restart the server for best results.'
  } catch (e) {
    return importFail(e)
  }
}

function importFail (e) {
  const { db, env } = exports
  const ps = []
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

async function upgradeDB () {
  const { db, env } = exports
  const version = parseFloat(await env.get(env.keys.DATABASE_VERSION) || 1)
  if (version === DATABASE_VERSION) return
  console.log('Database Upgrade needed')
  if (version < 2) {
    console.log('Applying version 2')
    const ps = []
    ps.push(db.users.update({ money: { $gt: 0 } }, { $mul: { money: 1000 } }))
    ps.push(db['market.orders'].update({}, { $mul: { price: 1000 } }))
    ps.push(db.users.update({ username: 'Screeps' }, { username: 'Screeps', usernameLower: 'screeps', gcl: 0, cpi: 0, active: false, cpuAvailable: 0, badge: { type: 12, color1: '#999999', color2: '#999999', color3: '#999999', flip: false, param: 26 } }, { upsert: true }))
    await Promise.all(ps)
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

  if (version < 4) { // Factories update
    console.log('Applying version 4')
    const depositTypes = [C.RESOURCE_SILICON, C.RESOURCE_METAL, C.RESOURCE_BIOMASS, C.RESOURCE_MIST]
    const busRooms = await db.rooms.find({ $or: [{ _id: { $regex: /^[WE]\d*0[NS]/ } }, { _id: { $regex: /0$/ } }] })
    const ps = []
    for (const room of busRooms) {
      const [match, longitude, latitude] = /^[WE](\d+)[NS](\d+)$/.exec(room._id)
      if (match) {
        room.depositType = depositTypes[(longitude + latitude) % 4]
        ps.push(db.rooms.update({ _id: room._id }, room))
      }
    }
    await Promise.all(ps)
  }

  if (version < 5) { // Store update
    console.log('Applying version 5')
    const ps = []
    const energyOnly = function energyOnly (structure) {
      structure.store = { energy: structure.energy }
      structure.storeCapacityResource = { energy: structure.energyCapacity }
      delete structure.energy
      delete structure.energyCapacity
    }

    const storeOnly = function storeOnly (structure) {
      if (typeof structure.energyCapacity !== 'undefined') {
        structure.storeCapacity = structure.energyCapacity
        delete structure.energyCapacity
      }

      structure.store = {}
      C.RESOURCES_ALL.forEach(r => {
        if (typeof structure[r] !== 'undefined') {
          structure.store[r] = structure[r]
          delete structure[r]
        }
      })
    }

    const converters = {
      spawn: energyOnly,
      extension: energyOnly,
      tower: energyOnly,
      link: energyOnly,
      storage: storeOnly,
      terminal: storeOnly,
      container: storeOnly,
      factory: storeOnly,
      creep: storeOnly,
      powerCreep: storeOnly,
      tombstone: storeOnly,
      nuker: function nuker (structure) {
        structure.store = { energy: structure.energy, G: structure.G }
        structure.storeCapacityResource = { energy: structure.energyCapacity, G: structure.GCapacity }

        delete structure.energy
        delete structure.energyCapacity
        delete structure.G
        delete structure.GCapacity
      },
      powerSpawn: function powerSpawn (structure) {
        structure.store = { energy: structure.energy, power: structure.power }
        structure.storeCapacityResource = { energy: structure.energyCapacity, power: structure.powerCapacity }

        delete structure.energy
        delete structure.energyCapacity
        delete structure.power
        delete structure.powerCapacity
      },
      lab: function lab (structure) {
        structure.store = { energy: structure.energy }
        structure.storeCapacityResource = { energy: structure.energyCapacity }
        if (structure.mineralType && structure.mineralAmount) {
          structure.store[structure.mineralType] = structure.mineralAmount
          structure.storeCapacityResource[structure.mineralType] = structure.mineralCapacity
        } else {
          structure.storeCapacity = structure.energyCapacity + structure.mineralCapacity
        }

        delete structure.energy
        delete structure.energyCapacity
        delete structure.mineralType
        delete structure.mineralAmount
        delete structure.mineralCapacity
      }
    }

    const powerCreepsCollection = db['users.power_creeps']
    if (powerCreepsCollection) {
      const powerCreeps = await powerCreepsCollection.find({})
      powerCreeps.forEach(powerCreep => {
        console.log(`powerCreep#${powerCreep._id}`)
        converters.powerCreep(powerCreep)
        const { _id, ...obj } = powerCreep
        ps.push(powerCreepsCollection.update({ _id }, obj))
      })
    }

    const roomObjects = await db['rooms.objects'].find({ type: { $in: Object.keys(converters) } })
    roomObjects.forEach(object => {
      console.log(`${object.type}#${object._id}`)
      converters[object.type](object)
      const { _id, ...obj } = object
      ps.push(db['rooms.objects'].update({ _id }, obj))
    })

    const nowTimestamp = new Date().getTime()
    const orders = await db['market.orders'].find({})
    orders.forEach(order => {
      if (!order.createdTimestamp) {
        console.log(`order#${order._id}`)
        order.createdTimestamp = nowTimestamp
        const { _id, ...obj } = order
        ps.push(db['market.orders'].update({ _id }, obj))
      }
    })
    await Promise.all(ps)
  }
  if (version < 6) {
    console.log('Applying version 6')
    const ps = []
    const roomObjects = await db['rooms.objects'].find({ type: 'powerBank' })
    roomObjects.forEach(object => {
      console.log(`${object.type}#${object._id}`)
      object.store = { power: object.power }
      delete object.power
      const { _id, ...obj } = object
      ps.push(db['rooms.objects'].update({ _id }, obj))
    })
    await Promise.all(ps)
  }

  if (version < 7) {
    console.log('Applying version 7')
    await db.users.update({ _id: '2' }, {
      $set: {
        badge: {
          type: {
            path1: 'm 60.493413,13.745781 -1.122536,7.527255 -23.302365,-6.118884 -24.097204,26.333431 6.412507,0.949878 -5.161481,19.706217 26.301441,24.114728 1.116562,-7.546193 23.350173,6.122868 24.097202,-26.318478 -6.462307,-0.95785 5.16845,-19.699243 z m -1.58271,10.611118 -0.270923,1.821013 C 57.330986,25.69819 55.969864,25.331543 54.570958,25.072546 Z m -8.952409,4.554029 c 11.653612,0 21.055294,9.408134 21.055294,21.069735 0,11.661603 -9.401682,21.068738 -21.055294,21.068738 -11.65361,0 -21.055297,-9.407135 -21.055297,-21.068738 0,-11.661601 9.401687,-21.069735 21.055297,-21.069735 z M 26.634018,40.123069 c -0.262324,0.618965 -0.494865,1.252967 -0.708185,1.895768 l -0.0508,-0.104656 -0.194228,-0.417627 c 0.261245,-0.385697 0.631962,-0.909531 0.953211,-1.373485 z m 47.391601,17.714764 0.115539,0.237219 0.214148,0.462479 c -0.380159,0.55986 -0.886342,1.281124 -1.3835,1.988466 0.400298,-0.870957 0.752837,-1.767746 1.053813,-2.688164 z M 41.364458,73.812322 c 0.694434,0.251619 1.40261,0.471895 2.123558,0.662817 l -2.303841,0.558165 z',
            path2: 'm 60.857962,24.035953 -6.397566,1.055531 c 6.084137,1.084905 11.78633,4.394548 15.786244,9.746957 5.741405,7.682749 6.465607,17.544704 2.736121,25.67958 1.511089,-2.147013 2.622575,-3.851337 2.622575,-3.851337 l 1.628526,0.241209 c 0.726895,-2.869027 1.004942,-5.843252 0.811775,-8.806053 l 1.185288,-8.634615 -3.768025,-3.072898 -2.908435,-3.21842 c -0.0103,-0.01383 -0.01958,-0.02805 -0.02988,-0.04186 -3.118009,-4.172293 -7.17889,-7.228662 -11.666624,-9.098091 z M 50.001124,37.965163 A 12.020784,12.029027 0 0 0 37.979913,49.994617 12.020784,12.029027 0 0 0 50.001124,62.024074 12.020784,12.029027 0 0 0 62.022337,49.994617 12.020784,12.029027 0 0 0 50.001124,37.965163 Z M 27.019485,39.55693 c -1.481686,2.114179 -2.5658,3.779575 -2.5658,3.779575 l -1.647451,-0.244197 c -0.69707,2.775045 -0.977606,5.64628 -0.81476,8.511019 l -1.22015,8.890775 3.768021,3.072896 3.422394,3.786551 c 2.921501,3.715734 6.608397,6.499915 10.668588,8.29872 l 5.050921,-1.223973 C 38.324728,73.038607 33.383805,69.887984 29.806406,65.100956 28.655972,63.561522 27.71377,61.932905 26.961715,60.249903 L 24.8272,48.359991 c 0.194234,-3.030146 0.935183,-6.015406 2.192285,-8.803061 z'
          },
          color1: '#735252',
          color2: '#390305',
          color3: '#ff0d39',
          flip: false
        }
      }
    })
  }

  if (version < 8) {
    console.log('Applying version 8')
    const gameTime = parseInt(await env.get(env.keys.GAMETIME))
    const roomObjects = await db['rooms.objects'].find({
      type: { $in: ['spawn', 'invaderCore'] },
      spawning: { $ne: null },
      'spawning.remainingTime': { $exists: true }
    })

    const ps = roomObjects.map(object => {
      console.log(`${object.type}#${object._id}: ${JSON.stringify(object.spawning, 0, 2)}`)
      object.spawning.spawnTime = gameTime + object.spawning.remainingTime
      delete object.spawning.remainingTime
      const { _id, ...obj } = object
      return db['rooms.objects'].update({ _id }, obj)
    })
    await Promise.all(ps)
  }

  if (version < 9) {
    console.log('Applying version 9')

    const ps = []

    const rooms = await db.rooms.find({})
    const activeRoomNames = []

    rooms.forEach(room => {
      if (room.active) {
        activeRoomNames.push(room._id)
        delete room.active

        const { _id, ...obj } = room
        ps.push(db.rooms.update({ _id }, obj))
      }
    })

    if (activeRoomNames[0]) {
      ps.push(env.sadd(env.keys.ACTIVE_ROOMS, activeRoomNames))
    }

    await Promise.all(ps)
  }

  await env.set(env.keys.DATABASE_VERSION, '' + DATABASE_VERSION)
  console.log(`Database upgraded to version ${DATABASE_VERSION}`)
}
exports.upgradeDB = upgradeDB
