const path = require('path')

module.exports = function engine (config) {
  require('./driver')(config)
  config.engine.on('init', function (processType) {
    // processType will be 'runner','processor', or 'main'
    // Useful for detecting what module you are in
    if (processType === 'main') {
      if (!config.common.storage.db.users.count()) {
        importDB(config)
      }
    }
    if (processType === 'runtime') {
      patchRuntimeGlobals(config)
    }
  })
}

function importDB (config) {
  let { db, env } = config.common.storage
  console.log('Importing DB')
  try {
    let olddb = require(process.env.DB_PATH)
    let ps = olddb.collections.map(oldcol => {
      let name = oldcol.name
      console.log('Collection', name)
      if (name === 'env') {
        let p = oldcol.data.map(row => {
          let ps = []
          for (let k in row.data) {
            let v = row.data[k]
            ps.push(env.set(k, typeof v === 'object' ? JSON.stringify(v) : v))
          }
          return Promise.all(ps)
        })
        return Promise.all(p)
      } else {
        return Promise.all(oldcol.data.map(row => {
          delete row.meta
          delete row.$loki
          return db[name].insert(row)
        }))
      }
    })
    return Promise.all(ps)
      .then(() => console.log('Import complete. Restart the server for best results.'))
      .catch(err => console.error('Import Error', err))
  } catch (e) {
    let ps = []
    ps.push(exports.db.users.insert({ _id: '2', username: 'Invader', usernameLower: 'invader', cpu: 100, cpuAvailable: 10000, gcl: 13966610.2, active: 0 }))
    ps.push(exports.db.users.insert({ _id: '3', username: 'Source Keeper', usernameLower: 'source keeper', cpu: 100, cpuAvailable: 10000, gcl: 13966610.2, active: 0 }))
    ps.push(exports.env.set('gameTime', 1))
    return Promise.resolve()
      .then(() => console.log('An error occured importing existing db, initializing blank server'))
      .then(() => console.error(e))
      .then(() => Promise.all(ps))
      .then(() => console.log('Server initialzed. Remember to generate rooms.'))
      .catch(err => console.error(err))
  }
}

function patchRuntimeGlobals (config) {
  let pathToModule = path.join(path.dirname(require.main.filename), 'runtime-user-globals.js')
  let userGlobals = require(pathToModule)
  let newUserGlobals = require('./runtime-user-globals.js')
  Object.assign(userGlobals, newUserGlobals)
}
