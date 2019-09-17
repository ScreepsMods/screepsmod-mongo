const { MongoClient } = require('mongodb')
const Redis = require('redis')
const fs = require('fs')
const path = require('path')
const util = require('util')

const CollectionWrap = require('./CollectionWrap')
const PubSub = require('./PubSub')

const DATABASE_VERSION = 9
const LOCK_WAIT_TIMEOUT = 300000
const LOCK_POLL_INTERVAL = 250

let C
/** @type {Function & { _connected: boolean, db: any, pubsub: any, env: any, queue: any, resetAllData(): void, importDB(path: string): void, upgradeDB(): void }} */
module.exports = function (config) {
  Object.assign(exports, config.common.storage)
  C = config.common.constants
  Object.assign(config.common.storage.env.keys, {
    DATABASE_READY: 'DATABASE_READY'
  })
  // Not sure why that one is missing from the list
  if (!config.common.dbCollections.includes('market.intents')) {
    config.common.dbCollections.push('market.intents')
  }
  return async function storageConnect () {
    if (exports._connected) {
      return
    }
    let uri
    if (config.mongo.uri) {
      uri = config.mongo.uri
      delete config.mongo.uri
    } else {
      uri = `mongodb://${config.mongo.host}:${config.mongo.port}/${config.mongo.database}`
      delete config.mongo.uri
    }
    delete config.mongo.host
    delete config.mongo.port
    delete config.mongo.database

    const redis = Redis.createClient(config.redis)
    const pub = Redis.createClient(config.redis)
    const sub = Redis.createClient(config.redis)

    config.mongo.useUnifiedTopology = true
    config.mongo.promiseLibrary = Promise
    config.mongo.validateOptions = true
    const client = await new MongoClient.connect(uri, config.mongo) // eslint-disable-line new-cap
    // await client.connect() // Can't do that because that messed up with the options
    const db = client.db()
    for (const name of config.common.dbCollections) {
      const collection = db.collection(name)
      const indexes = config.common.dbIndexes[name]
      if (indexes) {
        for (const k in indexes) {
          await collection.createIndex({ [k]: indexes[k] })
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
      flushall: util.promisify(redis.flushall.bind(redis)),
      sadd: util.promisify(redis.sadd.bind(redis)),
      smembers: util.promisify(redis.smembers.bind(redis))
    })

    exports._connected = true
    exports.resetAllData = async () => {} // Temp dummy

    Object.assign(exports.queue, require('./queue'))
    exports.queue.wrap(redis, exports.pubsub)

    exports.env.get = async function (...a) {
      try {
        return await this._get(...a)
      } catch (e) {
        // Hash keys (e.g. roomHistory:*) use HSET; plain env keys use SET. The engine
        // still calls get() for both — _get rejects with WRONGTYPE when the key is a hash.
        if (typeof e === 'object' && e !== null && 'code' in e && e.code === 'WRONGTYPE') {
          return this.hgetall(...a)
        }
        throw e
      }
    }

    const isMainProcess = process.argv[1] && process.argv[1].endsWith('engine/dist/main.js')
    if (isMainProcess) {
      const didInit = await withDatabaseLock(exports.env, exports.env.keys.DATABASE_READY, async () => {
        // Collections can be auto-created by index setup before init runs.
        // Use actual data presence to detect bootstrap state.
        const hasUsersData = (await db.collection('users').countDocuments({}, { limit: 1 })) > 0
        if (!hasUsersData) {
          try {
            console.log('Importing database…')
            await exports.importDB(path.join(__dirname, '/../../db.original.json'))
          } catch (err) {
            console.error('An error occured importing existing db, initializing blank server', err)
            await importFail()
            console.log('Server initialized. Remember to generate rooms.')
          }
        } else {
          console.log('Database already initialized, skipping import')
        }
        await exports.upgradeDB()
      })
      if (!didInit) {
        console.log('Database already initialized, skipping import')
      }
    } else {
      console.log('Waiting for database initialization…')
      await withDatabaseLock(exports.env, exports.env.keys.DATABASE_READY)
      console.log('Database initialized, continuing…')
    }

    exports.resetAllData = async () => {
      return await exports.importDB(path.join(__dirname, '/../../db.original.json'))
    }
    Object.assign(config.common.storage, exports)
  }
}

async function withDatabaseLock (env, keyName, initFn) {
  if (initFn) {
    const ready = await env.get(keyName)
    if (ready) {
      return false
    }
    await initFn()
    await env.set(keyName, '1')
    return true
  }
  const start = Date.now()

  while (Date.now() - start < LOCK_WAIT_TIMEOUT) {
    const state = await env.get(keyName)
    if (state) {
      return false
    }
    await sleep(LOCK_POLL_INTERVAL)
  }

  throw new Error(`Timed out waiting for database initialization after ${LOCK_WAIT_TIMEOUT}ms`)
}

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

exports.importDB = async function importDB (path = './db.json') {
  const { db, env } = exports
  console.log('Importing DB')
  await env.set(env.keys.MAIN_LOOP_PAUSED, '1')
  const olddb = JSON.parse(fs.readFileSync(path).toString())
  const ps = olddb.collections.map(async oldcol => {
    const name = oldcol.name
    console.log(name)
    if (name === 'env') {
      await env.flushall()
      await env.set(env.keys.MAIN_LOOP_PAUSED, '1')
      const p = oldcol.data.map(async row => {
        const ps = []
        row.data[env.keys.MAIN_LOOP_PAUSED] = '1'
        for (const k in row.data) {
          const v = row.data[k]
          const type = k.slice(0, k.indexOf(':') + 1)
          const hashTypes = [env.keys.MEMORY_SEGMENTS, env.keys.ROOM_HISTORY, env.keys.ROOM_EVENT_LOG]
          if (hashTypes.indexOf(type) !== -1) {
            for (const kk in v) {
              ps.push(env.hmset(k, kk, typeof v[kk] === 'object' ? JSON.stringify(v[kk]) : v[kk]))
            }
          } else if (k === env.keys.ACTIVE_ROOMS) {
            ps.push(env.sadd(env.keys.ACTIVE_ROOMS, v))
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
  await env.set(env.keys.DATABASE_VERSION, DATABASE_VERSION)
  return await exports.upgradeDB()
}

async function importFail () {
  const { db, env } = exports
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
}

exports.upgradeDB = async function upgradeDB () {
  const { db, env } = exports
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
      const [match, longitude, latitude] = /^[WE](\d+)[NS](\d+)$/.exec(room._id) || []
      if (match) {
        room.depositType = depositTypes[(Number(longitude) + Number(latitude)) % 4]
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
  if (version < 6 && DATABASE_VERSION >= 6) {
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

  if (version < 7 && DATABASE_VERSION >= 7) {
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

  if (version < 8 && DATABASE_VERSION >= 8) {
    console.log('Applying version 8')
    const gameTime = parseInt(await env.get(env.keys.GAMETIME))
    const roomObjects = await db['rooms.objects'].find({
      type: { $in: ['spawn', 'invaderCore'] },
      spawning: { $ne: null },
      'spawning.remainingTime': { $exists: true }
    })

    const ps = roomObjects.map(object => {
      console.log(`${object.type}#${object._id}: ${JSON.stringify(object.spawning, undefined, 2)}`)
      object.spawning.spawnTime = gameTime + object.spawning.remainingTime
      delete object.spawning.remainingTime
      const { _id, ...obj } = object
      return db['rooms.objects'].update({ _id }, obj)
    })
    await Promise.all(ps)
  }

  if (version < 9 && DATABASE_VERSION >= 9) {
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
