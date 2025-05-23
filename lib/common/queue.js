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
const redis = {
  funcs: ['get', 'del', 'llen', 'lrem', 'lpush', 'ltrim', 'rpoplpush']
}

module.exports = {
  wrap (nredis, npubsub) {
    redis.funcs.forEach(f => (redis[f] = wrap(nredis, f)))
    pubsub = npubsub
  },
  fetch (name, cb) {
    const defer = q.defer()
    try {
      const check = function () {
        redis.rpoplpush(queues[name].pending, queues[name].processing)
          .then(item => {
            if (!item || item === 'nil') {
              setTimeout(check, 10)
              return
            }
            defer.resolve(item)
          }).catch(err => console.error('fetch', err))
      }
      check()
    } catch (e) {
      defer.reject(e.message)
      console.error(e)
    }
    return defer.promise
  },
  markDone (name, id, cb) {
    const defer = q.defer()
    try {
      redis.lrem(queues[name].processing, 0, id)
      queues[name].emitter.emit('done')
      defer.resolve(true)
    } catch (e) {
      defer.reject(e.message)
      console.error(e)
    }
    return defer.promise
  },
  add (name, id, cb) {
    const defer = q.defer()
    try {
      redis.lpush(queues[name].pending, id)
      queues[name].emitter.emit('add')
      defer.resolve(true)
    } catch (e) {
      defer.reject(e.message)
      console.error(e)
    }
    return defer.promise
  },
  addMulti (name, array, cb) {
    const defer = q.defer()
    try {
      redis.lpush(queues[name].pending, ...array)
      queues[name].emitter.emit('add')
      defer.resolve(true)
    } catch (e) {
      defer.reject(e.message)
      console.error(e)
    }
    return defer.promise
  },
  whenAllDone (name, cb) {
    const defer = q.defer()
    try {
      const check = function (reset) {
        q.all([
          redis.llen(queues[name].pending),
          redis.llen(queues[name].processing)
        ]).then(cnts => {
          if (cnts[0] + cnts[1]) {
            // queues[name].emitter.once('done', check);
            setTimeout(check, 10)
            return
          }
          pubsub.publish('queueDone:' + name, '1')
          defer.resolve(true)
        })
      }
      check()
    } catch (e) {
      defer.reject(e.message)
      console.error(e)
    }
    return defer.promise
  },
  reset (name, cb) {
    const defer = q.defer()
    try {
      q.all([
        redis.llen(queues[name].pending),
        redis.llen(queues[name].processing)
      ]).then((ret) => {
      }).then(() => q.all([
        redis.del(queues[name].pending),
        redis.del(queues[name].processing)
      ])).then((ret) => {
        queues[name].emitter.emit('done', true)
        defer.resolve(true)
      })
    } catch (e) {
      defer.reject(e.message)
      console.error(e)
    }
    return defer.promise
  }
}
