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

  router.post('/api/game/add-object-intent', auth.tokenAuth, jsonResponse(async (request) => {
    await checkGame(request)
    if (request.body.name === 'activateSafeMode') {
      const gameTime = parseInt(await env.get('gameTime'))
      const count = await db['rooms.objects'].count({ $and: [{ type: 'controller' }, { user: '' + request.user._id }, { safeMode: { $gt: gameTime } }] })
      if (count > 0) throw new Error('safe mode active already')
    }
    await env.hmset(env.keys.ROOM_INTENTS + request.body.room, request.user._id.toString() + '.manual', JSON.stringify({ [request.body._id]: { [request.body.name]: request.body.intent } }))
    await db.rooms.update({ _id: request.body.room }, { $set: { active: true } })
  }))

  router.get('/api/user/messages/index', auth.tokenAuth, jsonResponse(async (request) => {
    const data = await db['users.messages'].findEx({ user: request.user._id }, { sort: { date: -1 } })
    const messages = []
    data.forEach(message => {
      if (!messages.find(i => i._id === message.respondent)) {
        messages.push({ _id: message.respondent, message })
      }
    })
    const users = await db.users.find({ _id: { $in: _.map(messages, '_id') } }, { username: true, badge: true })
    return { messages, users: _.keyBy(users, '_id') }
  }))

  authlib.genToken = async function genToken (id) {
    const token = crypto.createHmac('sha1', 'hsdhweh342sdbj34e').update(new Date().getTime() + id).digest('hex')
    await env.setex(`auth_${token}`, 300, id)
    return token
  }

  authlib.checkToken = async function checkToken (token, noConsume) {
    const authKey = `auth_${token}`

    const data = await env.get(authKey)
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
    const user = await db.users.findOne({ _id: data })
    if (!user) {
      return Promise.reject(false) // eslint-disable-line prefer-promise-reject-errors
    }
    env.set(env.keys.USER_ONLINE + user._id, Date.now())
    return user
  }

  async function checkGame (req) {
    const room = await db.rooms.findOne({ _id: req.body.room })
    if (!room) {
      throw new Error('invalid room')
    }
    if (/^(W|E)/.test(req.body.room)) {
      if (room.status === 'out of borders' || (room.openTime && room.openTime > Date.now())) {
        throw new Error('out of borders')
      }
      return true
    }
    throw new Error('not supported')
  }
}
