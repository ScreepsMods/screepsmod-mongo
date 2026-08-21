module.exports = function (config) {
  require('./common')(config) // This is for adding stuff ALL the mods/modules will see
  if (config.backend) require('./backend')(config) // API and CLI stuff
  if (config.engine) require('./engine')(config) // Engine stuff
  if (config.storage) {
    mockLokiStorageDb(config.storage)
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

function mockLokiStorageDb (storage) {
  // There's a stray `setInterval(function envCleanExpired()` in
  // @screeps/storage/lib/db.js that causes a crash when it hits,
  // since we're not using the real storage db. Mock enough of it
  // that it can run and do nothing.
  if (typeof storage.getDb !== 'function' || typeof storage.loadDb !== 'function') {
    return
  }
  const originalGetDb = storage.getDb
  const originalLoadDb = storage.loadDb
  storage.getDb = makeLegacyDbMock
  originalLoadDb()
    .catch(err => {
      console.warn('[screepsmod-mongo] Failed to prime legacy storage DB shim:', err && err.message ? err.message : err)
    })
    .finally(() => {
      storage.getDb = originalGetDb
    })
}

function makeLegacyDbMock () {
  const envCollection = {
    get: () => undefined,
    update: () => {},
    insert: () => {}
  }
  return {
    loadDatabase: (_opts, cb) => cb(null),
    getCollection: (name) => {
      if (name === 'env') {
        return envCollection
      }
      return null
    }
  }
}
