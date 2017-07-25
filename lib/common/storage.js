
module.exports = function (config) {
  let storage = config.common.storage
  storage._connect = require('./_connect')(config)
}
