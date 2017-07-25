const path = require('path')
const express = require('express')
const bodyParser = require('body-parser')
const jsonResponse = require('q-json-response')
const auth = require(path.join(path.dirname(require.main.filename), '../lib/game/api/auth'))

module.exports = function (config) {
  const { common } = config
  const { db, env } = common.storage
  const router = new express.Router()
  config.on('expressPreConfig', (app) => app.use('/api', auth.router))
  router.use(bodyParser.json())
  router.post('/add-object-intent', auth.tokenAuth, jsonResponse((request) => {
    return checkGame(request)
      .then(() => {
        if (request.body.name === 'activateSafeMode') {
          return common.getGametime()
            .then(gameTime => db['rooms.objects'].count({$and: [{type: 'controller'}, {user: '' + request.user._id}, {safeMode: {$gt: gameTime}}]}))
            .then(count => count > 0 ? Promise.reject(new Error('safe mode active already')) : undefined)
        }
      })
      .then(() => env.hmset(env.keys.ROOM_INTENTS + request.body.room, request.user._id.toString() + '.manual', JSON.stringify({[request.body._id]: { [request.body.name]: request.body.intent }})))
      .then(() => db.rooms.update({ _id: request.body.room }, {$set: { active: true }}))
  }))

  function checkGame (req) {
    return db.rooms.findOne({ _id: req.body.room })
      .then((room) => {
        if (!room) {
          return Promise.reject(new Error('invalid room'))
        }
        if (/^(W|E)/.test(req.body.room)) {
          if (room.status === 'out of borders' || (room.openTime && room.openTime > Date.now())) {
            return Promise.reject(new Error('out of borders'))
          }
          return true
        }
        return Promise.reject(new Error('not supported'))
      })
  }
}
