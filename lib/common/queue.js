const q = require('q')

const queues = new Proxy({
  init (name) {
    this[name] = {
      pending: `${name}Pending`,
      processing: `${name}Processing`,
      emitter: {
        emit (channel) {
          return pubsub.publish(`queue_${name}_${channel}`, '1')
        },
        once (channel, cb) {
          return pubsub.once(`queue_${name}_${channel}`, (...a) => {
            cb(...a) // eslint-disable-line
          })
        }
      }
    }
  }
}, {
  get (target, name) {
    if (!target[name]) {
      target.init(name)
    }
    return target[name]
  }
})

function wrap (redis, name) {
  return (...a) => q.ninvoke(redis, name, ...a)
}

let pubsub
let redis = {
  funcs: ['get', 'del', 'llen', 'lrem', 'lpush', 'ltrim', 'rpoplpush']
}

module.exports = {
  wrap (nredis, npubsub) {
    redis.funcs.forEach(f => (redis[f] = wrap(nredis, f)))
    pubsub = npubsub
  },
  async fetch (name, cb) {
    while (true) {
      const item = await redis.rpoplpush(queues[name].pending, queues[name].processing)
      if (!item || item === 'nil') {
        await sleep(10)
        continue
      }
      return item
    }
  },
  async markDone (name, id, cb) {
    await redis.lrem(queues[name].processing, 0, id)
    queues[name].emitter.emit('done')
    return true
  },
  async add (name, id, cb) {
    await redis.lpush(queues[name].pending, id)
    queues[name].emitter.emit('add')
  },
  async addMulti (name, array, cb) {
    await redis.lpush(queues[name].pending, ...array)
    queues[name].emitter.emit('add')
    return true
  },
  async whenAllDone (name, cb) {
    while (true) {
      const cnts = await Promise.all([
        redis.llen(queues[name].pending),
        redis.llen(queues[name].processing)
      ])
      if (cnts[0] + cnts[1]) {
        await sleep(10)
        continue
      }
      pubsub.publish('queueDone:' + name, '1')
      return true
    }
  },
  async reset (name, cb) {
    await Promise.all([
      redis.del(queues[name].pending),
      redis.del(queues[name].processing)
    ])
    queues[name].emitter.emit('done', true)
    return true
  }
}

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
