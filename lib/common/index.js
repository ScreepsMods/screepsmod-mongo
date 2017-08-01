module.exports = function (config) {
  Object.assign(config, {
    mongo: {
      host: process.env.MONGO_HOST || 'localhost',
      port: process.env.MONGO_PORT || 28017,
      database: 'screeps'
    },
    redis: {
      host: process.env.REDIS_HOST || 'localhost',
      port: process.env.REDIS_PORT || 6379
    }
  })
  require('./storage')(config)
}
