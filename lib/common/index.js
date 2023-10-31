const fs = require('fs')
const ini = require('ini')

module.exports = function (config) {
  let opts = {}
  try {
    opts = ini.parse(fs.readFileSync('./.screepsrc', { encoding: 'utf8' }))
  } catch (e) { }
  Object.assign(config, {
    mongo: Object.assign({
      host: process.env.MONGO_HOST || 'localhost',
      port: process.env.MONGO_PORT || 27017,
      database: process.env.MONGO_DATABASE || 'screeps',
      uri: process.env.MONGO_CONN || '' //  Pass complete Connection String in Env Variable (i.e. for authenticated connections)
    }, opts.mongo || {}),
    redis: Object.assign({
      host: process.env.REDIS_HOST || 'localhost',
      port: process.env.REDIS_PORT || 6379,
      namespace: process.env.REDIS_NAMESPACE || ''
    }, opts.redis || {})
  })
  config.common.storage.env.keys.ROOM_INTENTS = 'roomIntents:'
  config.common.storage.env.keys.DATABASE_VERSION = 'databaseVersion'
  require('./storage')(config)
}
