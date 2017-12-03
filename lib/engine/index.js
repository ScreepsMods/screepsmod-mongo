const path = require('path')

module.exports = function (config) {
  if (true || config.engine.driver) {
    // TODO: For some reason this is missing on runtimes, this needs
    // investigated as it makes on('playerSandbox') never trigger
    require('./driver')(config)
  }
  config.engine.on('init', function (processType) {
    console.log('INIT', processType)
    // processType will be 'runner','processor', or 'main'
    // Useful for detecting what module you are in
    if (processType === 'main') {
      // if (!config.common.storage.db.users.count()) {
      //   importDB(config)
      // }
    }
    if (processType === 'runtime') {
      patchRuntimeGlobals(config)
    }
  })
}

function patchRuntimeGlobals (config) {
  let pathToModule = path.join(path.dirname(require.main.filename), 'user-globals.js')
  let userGlobals = require(pathToModule)
  let newUserGlobals = require('./runtime/user-globals.js')
  Object.assign(userGlobals, newUserGlobals)
}
