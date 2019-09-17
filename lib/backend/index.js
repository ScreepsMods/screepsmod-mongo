module.exports = function (config) {
  require('./api')(config)
  config.cli.on('cliSandbox', (sandbox) => {
    sandbox.mongo = {
      _help: `mongo.importDB([pathToDB.JSON])`,
      async importDB (path) {
        await sandbox.system.pauseSimulation()
        const ret = await config.common.storage.importDB(path)
        await sandbox.system.resumeSimulation()
        return ret
      }
    }
  })
}
