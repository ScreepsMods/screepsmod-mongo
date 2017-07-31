const q = require('q')
const _ = require('lodash')

function checkNotificationOnline (userId) {
  return q.when(true) // TODO
}

module.exports = function (config) {
  let bulk = require('./bulk')(config)
  const { common, engine } = config
  const { db, env } = common.storage
  const { driver } = engine
  let odriver = Object.assign({}, driver)
  Object.assign(driver, {
    bulkObjectsWrite () {
      return bulk('rooms.objects')
    },
    bulkFlagsWrite () {
      return bulk('rooms.flags')
    },
    bulkUsersWrite () {
      return bulk('users')
    },
    bulkRoomsWrite () {
      return bulk('rooms')
    },
    bulkTransactionsWrite () {
      return bulk('transactions')
    },
    bulkMarketOrders () {
      return bulk('market.orders')
    },
    bulkUsersMoney () {
      return bulk('users.money')
    },
    bulkUsersResources () {
      return bulk('users.resources')
    },
    saveUserIntents (userId, intents) {
      const updates = []
      for (let room in intents) {
        if (room === 'notify') {
          updates.push(checkNotificationOnline(userId)
            .then(() => {
              if (intents.notify.length > 20) {
                intents.notify = _.take(intents.notify, 20)
              }

              var promises = [q.when()]

              intents.notify.forEach((i) => {
                if (i.groupInterval < 0) {
                  i.groupInterval = 0
                }
                if (i.groupInterval > 1440) {
                  i.groupInterval = 1440
                }
                i.groupInterval *= 60 * 1000
                i.groupInterval = Math.floor(i.groupInterval)
                var date = i.groupInterval ? new Date(Math.ceil(new Date().getTime() / i.groupInterval) * i.groupInterval) : new Date()

                var message = ('' + i.message).substring(0, 500)

                promises.push(db['users.notifications'].update({
                  $and: [
                    {user: userId},
                    {message},
                    {date: date.getTime()},
                    {type: 'msg'}
                  ]
                }, {
                  $inc: {count: 1}
                },
                {upsert: true}))
              })

              return q.all(promises)
            }))
          continue
        }

        if (room === 'market') {
          updates.push(db['market.intents'].insert({user: userId, intents: intents[room]}))
          continue
        }

        updates.push(env.hset(env.keys.ROOM_INTENTS + room, userId, JSON.stringify(intents[room])))
      }
      return q.all(updates)
    },
    clearRoomIntents (roomId) {
      return env.del(env.keys.ROOM_INTENTS + roomId)
    },
    getRoomIntents (roomId) {
      return env.hgetall(env.keys.ROOM_INTENTS + roomId)
        .then(data => {
          let users = {}
          let manual = {}
          if (!data) {
            return { users }
          }
          _.each(data, (intents, userId) => {
            intents = JSON.parse(intents)
            let [, id] = userId.match(/^(.*)\.manual$/) || []
            if (id) {
              manual[id] = { objectsManual: intents }
            } else {
              users[userId] = { objects: intents }
            }
          })
          _.each(manual, (data, userId) => {
            users[userId] = users[userId] || {}
            users[userId].objectsManual = data.objectsManual
          })
          return { users }
        })
    },
    incrementGameTime () {
      return env.incr(env.keys.GAMETIME)
      // common.getGametime()
      //  .then(gameTime => env.set(env.keys.GAMETIME, gameTime + 1).then(() => gameTime + 1))
    },
    _getRuntimeData (a, b) {
      return odriver.getRuntimeData(a, b)
        .catch(err => {
          console.log('DRIVER ERR',err.stack || err)
          console.error(err)
        })
    }
  })
}
