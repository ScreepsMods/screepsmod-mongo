
module.exports = function (config) {
  let storage = config.common.storage
  config.common.dbIndexes = {
    'users': { user: 1, username: 1, email: 1 },
    'users.code': { user: 1 },
    'rooms': { active: 1, status: 1 },
    'rooms.objects': { room: 1, user: 1 },
    'rooms.terrain': { room: 1 },
    'rooms.flags': { room: 1, user: 1 },
    'transactions': { user: 1 },
    'users.console': { user: 1 },
    'users.money': { user: 1 },
    'users.notifications': { user: 1 },
    'users.resources': { user: 1 }
  }
  storage._connect = require('./_connect')(config)
}
