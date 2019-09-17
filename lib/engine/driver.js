const q = require('q')
const _ = require('lodash')

function checkNotificationOnline (userId) {
  return q.when(true) // TODO
}

module.exports = function (config) {
  const { common, engine } = config
  const { db, env } = common.storage
  const { driver } = engine
  Object.assign(driver, {
    saveUserIntents (userId, intents) {
      const updates = []
      for (let room in intents) {
        if (room === 'notify') {
          updates.push(async () => {
            await checkNotificationOnline(userId)
            if (intents.notify.length > 20) {
              intents.notify = _.take(intents.notify, 20)
            }

            for (const i of intents.notify) {
              if (i.groupInterval < 0) {
                i.groupInterval = 0
              }
              if (i.groupInterval > 1440) {
                i.groupInterval = 1440
              }
              i.groupInterval *= 60 * 1000
              i.groupInterval = Math.floor(i.groupInterval)
              const date = i.groupInterval ? new Date(Math.ceil(new Date().getTime() / i.groupInterval) * i.groupInterval) : new Date()

              const message = ('' + i.message).substring(0, 500)

              await db['users.notifications'].update({
                $and: [
                  { user: userId },
                  { message },
                  { date: date.getTime() },
                  { type: 'msg' }
                ]
              }, {
                $inc: { count: 1 }
              },
              { upsert: true })
            }
          })
          continue
        }

        if (room === 'market') {
          updates.push(db['market.intents'].insert({ user: userId, intents: intents[room] }))
          continue
        }

        updates.push(env.hset(env.keys.ROOM_INTENTS + room, userId, JSON.stringify(intents[room])))
      }
      return Promise.all(updates)
    },
    clearRoomIntents (roomId) {
      return env.del(env.keys.ROOM_INTENTS + roomId)
    },
    async getRoomIntents (roomId) {
      const data = await env.hgetall(env.keys.ROOM_INTENTS + roomId)
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
    },
    incrementGameTime () {
      return env.incr(env.keys.GAMETIME)
    }
  })
}
