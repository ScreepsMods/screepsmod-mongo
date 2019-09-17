const { MongoClient } = require('mongodb')
const Redis = require('redis')
const fs = require('fs')
const util = require('util')

const CollectionWrap = require('./CollectionWrap')
const PubSub = require('./PubSub')

const DATABASE_VERSION = 3.1

let C
module.exports = function (config) {
  Object.assign(exports, config.common.storage)
  C = config.common.constants
  return async function storageConnect () {
    if (exports._connected) {
      return
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

    config.mongo.promiseLibrary = Promise
    const db = await MongoClient.connect(uri, config.mongo)
    for (const name of config.common.dbCollections) {
      const collection = db.collection(name)
      const indexes = config.common.dbIndexes[name]
      if (indexes) {
        for (let k in indexes) {
          await collection.ensureIndex({ [k]: indexes[k] })
        }
      }
      exports.db[name] = new CollectionWrap(collection, name)
    }

    const pubsub = new PubSub(pub, sub)
    Object.assign(exports.pubsub, {
      publish: pubsub.publish.bind(pubsub),
      subscribe: pubsub.subscribe.bind(pubsub),
      once: pubsub.once.bind(pubsub)
    })

    Object.assign(exports.env, {
      _get: util.promisify(redis.get.bind(redis)),
      mget: util.promisify(redis.mget.bind(redis)),
      set: util.promisify(redis.set.bind(redis)),
      setex: util.promisify(redis.setex.bind(redis)),
      expire: util.promisify(redis.expire.bind(redis)),
      ttl: util.promisify(redis.ttl.bind(redis)),
      del: util.promisify(redis.del.bind(redis)),
      hmget: util.promisify(redis.hmget.bind(redis)),
      hmset: util.promisify(redis.hmset.bind(redis)),
      hget: util.promisify(redis.hget.bind(redis)),
      hset: util.promisify(redis.hset.bind(redis)),
      hgetall: util.promisify(redis.hgetall.bind(redis)),
      incr: util.promisify(redis.incr.bind(redis)),
      flushall: util.promisify(redis.flushall.bind(redis))
    })

    exports._connected = true
    exports.resetAllData = async () => {} // Temp dummy

    Object.assign(exports.queue, require('./queue'))
    exports.queue.wrap(redis, exports.pubsub)

    exports.env.get = function (...a) {
      try {
        return this._get(...a)
      } catch (e) {
        // This is to fix oddness in the screeps/storage env implementation
        // that causes an incompatibility with redis
        return this.hgetall(...a)
      }
    }
    exports.resetAllData = () => {
      return exports.importDB(`${__dirname}/../../db.original.json`)
    }
    await exports.upgradeDB()
    Object.assign(config.common.storage, exports)
  }
}

exports.importDB = async function importDB (path = './db.json') {
  const { db, env } = exports
  console.log('Importing DB')
  await env.set(env.keys.MAIN_LOOP_PAUSED, '1')
  try {
    const olddb = JSON.parse(fs.readFileSync(path).toString())
    const ps = olddb.collections.map(async oldcol => {
      const name = oldcol.name
      console.log(name)
      if (name === 'env') {
        await env.flushall()
        await env.set(env.keys.MAIN_LOOP_PAUSED, '1')
        const p = oldcol.data.map(async row => {
          let ps = []
          row.data[env.keys.MAIN_LOOP_PAUSED] = '1'
          for (let k in row.data) {
            const v = row.data[k]
            const type = k.slice(0, k.indexOf(':') + 1)
            const hashTypes = [env.keys.MEMORY_SEGMENTS, env.keys.ROOM_HISTORY, env.keys.ROOM_EVENT_LOG]
            if (hashTypes.indexOf(type) !== -1) {
              for (const kk in v) {
                ps.push(env.hmset(k, kk, typeof v[kk] === 'object' ? JSON.stringify(v[kk]) : v[kk]))
              }
            } else {
              ps.push(env.set(k, typeof v === 'object' ? JSON.stringify(v) : v))
            }
          }
          await Promise.all(ps)
        })
        return Promise.all(p)
      } else {
        if (!db[name]) {
          console.log(`Invalid collection in db.json: ${name}`)
          return
        }
        await db[name].drop()
        await Promise.all(oldcol.data.map(row => {
          delete row.meta
          delete row.$loki
          return db[name].insert(row)
        }))
      }
    })
    await Promise.all(ps)
    await db.users.update({ _id: '2' }, { $set: { _id: '2', username: 'Invader', usernameLower: 'invader', cpu: 100, cpuAvailable: 10000, gcl: 13966610.2, active: 0 } }, { upsert: true })
    await db.users.update({ _id: '3' }, { $set: { _id: '3', username: 'Source Keeper', usernameLower: 'source keeper', cpu: 100, cpuAvailable: 10000, gcl: 13966610.2, active: 0 } }, { upsert: true })
    await db.users.update({ username: 'Screeps' }, { username: 'Screeps', usernameLower: 'screeps', gcl: 0, cpu: 0, active: false, cpuAvailable: 0, badge: { type: 12, color1: '#999999', color2: '#999999', color3: '#999999', flip: false, param: 26 } }, { upsert: true })
    await env.set(env.keys.DATABASE_VERSION, DATABASE_VERSION)
    await env.set(env.keys.MAIN_LOOP_PAUSED, '0')
    return 'Import complete. Restart the server for best results.'
  } catch (e) {
    return importFail(e)
  }
}

async function importFail (e) {
  const { db, env } = exports
  console.log('An error occured importing existing db, initializing blank server')
  console.error('err', e)
  await Promise.all([
    db.users.update({ _id: '2' }, { $set: { _id: '2', username: 'Invader', usernameLower: 'invader', cpu: 100, cpuAvailable: 10000, gcl: 13966610.2, active: 0 } }, { upsert: true }),
    db.users.update({ _id: '3' }, { $set: { _id: '3', username: 'Source Keeper', usernameLower: 'source keeper', cpu: 100, cpuAvailable: 10000, gcl: 13966610.2, active: 0 } }, { upsert: true }),
    db.users.update({ username: 'Screeps' }, { username: 'Screeps', usernameLower: 'screeps', gcl: 0, cpu: 0, active: false, cpuAvailable: 0, badge: { type: 12, color1: '#999999', color2: '#999999', color3: '#999999', flip: false, param: 26 } }, { upsert: true }),
    env.set('gameTime', 1),
    env.set(env.keys.DATABASE_VERSION, DATABASE_VERSION)
  ].map(v => {
    v.catch(() => {})
    return v
  }))
  console.log('Server initialzed. Remember to generate rooms.')
  throw e
}

exports.upgradeDB = async function upgradeDB () {
  let { db, env } = exports
  const version = parseInt(await env.get(env.keys.DATABASE_VERSION) || 1)
  if (version === DATABASE_VERSION) return
  console.log('Database Upgrade needed')
  if (version < 2) {
    console.log('Applying version 2')
    await db.users.update({ money: { $gt: 0 } }, { $mul: { money: 1000 } })
    await db['market.orders'].update({}, { $mul: { price: 1000 } })
    await db.users.update({ username: 'Screeps' }, { username: 'Screeps', usernameLower: 'screeps', gcl: 0, cpi: 0, active: false, cpuAvailable: 0, badge: { type: 12, color1: '#999999', color2: '#999999', color3: '#999999', flip: false, param: 26 } }, { upsert: true })
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
    console.log('Applying version 4')
    const depositTypes = [C.RESOURCE_SILICON, C.RESOURCE_METAL, C.RESOURCE_BIOMASS, C.RESOURCE_MIST]
    const busRooms = await db.rooms.find({ $or: [{ _id: { $regex: /^[WE]\d*0[NS]/ } }, { _id: { $regex: /0$/ } }] })
    const ps = []
    for (const room of busRooms) {
      const [match, longitude, latitude] = /^[WE](\d+)[NS](\d+)$/.exec(room._id)
      if (match) {
        room.depositType = depositTypes[(longitude + latitude) % 4]
        ps.push(db.rooms.update(room))
      }
    }
    await Promise.all(ps)
  }

  if (version < 5 && DATABASE_VERSION >= 5) { // Store update
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
        ps.push(powerCreepsCollection.update({ _id: powerCreep._id }, powerCreep))
      })
    }

    const roomObjects = await db['rooms.objects'].find({ type: { $in: Object.keys(converters) } })
    roomObjects.forEach(object => {
      console.log(`${object.type}#${object._id}`)
      converters[object.type](object)
      ps.push(db['rooms.objects'].update({ _id: object._id }, object))
    })

    const nowTimestamp = new Date().getTime()
    const orders = await db['market.orders'].find({})
    orders.forEach(order => {
      if (!order.createdTimestamp) {
        console.log(`order#${order._id}`)
        order.createdTimestamp = nowTimestamp
        ps.push(db['market.orders'].update({ _id: order._id }, order))
      }
    })
    await Promise.all(ps)
  }
  await env.set(env.keys.DATABASE_VERSION, DATABASE_VERSION)
  console.log(`Database upgraded to version ${DATABASE_VERSION}`)
}
