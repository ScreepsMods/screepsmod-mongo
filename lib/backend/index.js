module.exports = function (config) {
  require('./api')(config)
  config.backend.features = config.backend.features || []
  config.backend.features.push({
    name: 'screepsmod-mongo',
    version: require('../../package.json').version
  })
  config.cli.on('cliSandbox', (sandbox) => {
    sandbox.mongo = {
      _help: 'mongo.importDB([pathToDB.JSON])',
      async importDB (path) {
        await sandbox.system.pauseSimulation()
        const ret = await config.common.storage.importDB(path)
        await sandbox.system.resumeSimulation()
        return ret
      }
    }
  })
}
