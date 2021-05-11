
module.exports = function (config) {
  const storage = config.common.storage
  config.common.dbIndexes = {
    users: { user: 1, username: 1, email: 1, active: 1, cpu: 1 },
    'users.code': { user: 1 },
    rooms: { active: 1, status: 1 },
    'rooms.objects': { room: 1, user: 1, type: 1, interRoom: 1 },
    'rooms.terrain': { room: 1 },
    'rooms.flags': { room: 1, user: 1 },
    transactions: { user: 1 },
    'users.console': { user: 1 },
    'users.money': { user: 1 },
    'users.notifications': { user: 1 },
    'users.power_creeps': { user: 1 },
    'users.resources': { user: 1 }
  }
  if (!storage.env.keys.STATUS_DATA) {
    // Hotfix for server bug, to be removed once patched upstream
    storage.env.keys.STATUS_DATA = storage.env.keys.ROOM_STATUS_DATA
  }
  storage._connect = require('./_connect')(config)
}
