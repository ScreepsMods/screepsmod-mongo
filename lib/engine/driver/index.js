module.exports = function (config) {
  let bulk = require('./bulk')(config)
  const { driver } = config.engine
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
        if (room == 'notify') {
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
                var date = i.groupInterval
                  ? new Date(Math.ceil(new Date().getTime() / i.groupInterval) * i.groupInterval)
                  : new Date()

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

        if (room == 'market') {
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
    incrementGameTime () {
      return common.getGametime()
        .then(gameTime => env.set(env.keys.GAMETIME, gameTime + 1).then(() => gameTime + 1))
    }
  })
}
