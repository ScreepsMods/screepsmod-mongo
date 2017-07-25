const express = require('express')
const bodyParser = require('body-parser')
const jsonResponse = require('q-json-response')
const auth = require(path.join(path.dirname(require.main.filename), '../lib/game/api/auth'))

module.exports = function (config) {
  const env = config.common.storage.env
  const router = new express.Router()
  config.on('expressPreConfig', (app) => app.use('/api', authlib.router))
  router.use(bodyParser.json())
  router.post('/add-object-intent', auth.tokenAuth, jsonResponse((request) => {
    return checkGame(request)
      .then(() => {
        if (request.body.name == 'activateSafeMode') {
          return common.getGametime()
            .then(gameTime => db['rooms.objects'].count({$and: [{type: 'controller'}, {user: '' + request.user._id}, {safeMode: {$gt: gameTime}}]}))
            .then(count => count > 0 ? q.reject('safe mode active already') : undefined)
        }
      })
      .then(() => env.hmset(env.keys.ROOM_INTENTS + request.body.room, request.user._id.toString() + '.manual', JSON.stringify({ [request.body._id]: { [request.body.name]: request.body.intent }})))
      .then(() => db.rooms.update({ _id: request.body.room }, { $set: { active: true }}))
      .then(() => ({}))
      .then(() => db['rooms.intents'].update({
        room: request.body.room
      }, {
        $merge: {
          users: {
            [request.user._id.toString()]: {
              objectsManual: {
                [request.body._id]: {
                  [request.body.name]: request.body.intent
                }
              }
            }
          }
        }
      }, {
        upsert: true
      }))
      .then(() => db.rooms.update({ _id: request.body.room }, { $set: { active: true }}))
  }))
}
