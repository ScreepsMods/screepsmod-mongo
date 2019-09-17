module.exports = function (config) {
  require('./common')(config) // This is for adding stuff ALL the mods/modules will see
  if (config.backend) require('./backend')(config) // API and CLI stuff
  if (config.engine) require('./engine')(config) // Engine stuff
  if (config.storage) {
    config.storage.socketListener = () => {}
    config.storage.loadDb = async () => {
      // Will never return. This is solely to disable the process while staying running.
      if (process.send) {
        process.send('storageLaunched')
      }
      console.log('screepsmod-mongo has disabled builtin storage')
      while (true) {
        // Just to keep the process 'alive' (prevents relaunching each time it dies)
        await sleep(100000)
      }
    }
  }
}

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
