const path = require('path')
const crypto = require('crypto')
const express = require('express')
const bodyParser = require('body-parser')
const jsonResponse = require('q-json-response')
const auth = require(path.join(path.dirname(require.main.filename), '../lib/game/api/auth'))
const authlib = require(path.join(path.dirname(require.main.filename), '../lib/authlib'))
const _ = require('lodash')

module.exports = function (config) {
  const { common } = config
  const { db, env } = common.storage
  const router = new express.Router()
  config.backend.on('expressPreConfig', (app) => app.use(router))
  router.use(bodyParser.json({
    limit: '8mb',
    verify (request, response, buf, encoding) {
      request.rawBody = buf.toString(encoding)
    }
  }))
  router.post('/api/game/add-object-intent', auth.tokenAuth, jsonResponse((request) => {
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
  router.get('/api/user/messages/index', auth.tokenAuth, jsonResponse((request) => {
    return db['users.messages'].findEx({user: request.user._id}, {sort: {date: -1}})
        .then(data => {
          var messages = []
          data.forEach(message => {
            if (!messages.find(i => i._id === message.respondent)) {
              messages.push({_id: message.respondent, message})
            }
          })
          console.log(messages)
          return db.users.find({_id: {$in: _.map(messages, '_id')}})
                .then(users => {
                  users = users.map(i => _.pick(i, ['_id', 'username', 'badge']))
                  return {messages, users: _.keyBy(users, '_id')}
                })
        })
  }))
  authlib.genToken = function (id) {
    const token = crypto.createHmac('sha1', 'hsdhweh342sdbj34e').update(new Date().getTime() + id).digest('hex')
    return env.setex(`auth_${token}`, 300, id).then(() => token)
  }

  authlib.checkToken = function (token, noConsume) {
    const authKey = `auth_${token}`

    return env.get(authKey)
      .then((data) => {
        if (!data) {
          return Promise.reject(false) // eslint-disable-line prefer-promise-reject-errors
        }
        if (!noConsume) {
          env.ttl(authKey)
            .then((ttl) => {
              if (ttl > 300) {
                env.expire(authKey, 300)
              }
            })
        }
        return db.users.findOne({_id: data})
      })
      .then((user) => {
        if (!user) {
          return Promise.reject(false) // eslint-disable-line prefer-promise-reject-errors
        }
        env.set(env.keys.USER_ONLINE + user._id, Date.now())
        return user
      })
  }

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
