const fs = require('fs')

module.exports = function (config) {
  require('./api')(config)
  config.cli.on('cliSandbox', (sandbox) => {
    sandbox.mongo = {
      _help: `mongo.importDB([pathToDB.JSON])`,
      importDB (path) {
        return Promise.resolve()
          .then(() => sandbox.system.pauseSimulation())
          .then(() => config.common.storage.importDB(path))
          .then(() => sandbox.system.resumeSimulation())
      }
    }
  })
}