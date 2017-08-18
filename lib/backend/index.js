const fs = require('fs')

module.exports = function (config) {
  require('./api')(config)
  config.cli.on('cliSandbox',(sandbox) => {
    sandbox.mongo = {
      _help: `mongo.importDB([pathToDB.JSON])`,
      importDB(path){ 
        return Promise.resolve()
          .then(()=>sandbox.system.pauseSimulation())
          .then(()=>importDB(config, path))
          .then(()=>sandbox.system.resumeSimulation())
      }
    }
  })
}

function importDB (config, path='./db.json') {
  let { db, env } = config.common.storage
  console.log('Importing DB')
  try {
    let olddb = JSON.parse(fs.readFileSync(path).toString())
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
        return db[name].drop().then(()=>Promise.all(oldcol.data.map(row => {
          delete row.meta
          delete row.$loki
          return db[name].insert(row)
        })))
      }
    })
    return Promise.all(ps)
      .then(() => console.log('Import complete. Restart the server for best results.'))
      .catch(importFail)
  } catch (e) {
    return importFail(e)
  }
}

function importFail(e){
  let ps = []
  ps.push(db.users.insert({ _id: '2', username: 'Invader', usernameLower: 'invader', cpu: 100, cpuAvailable: 10000, gcl: 13966610.2, active: 0 }))
  ps.push(db.users.insert({ _id: '3', username: 'Source Keeper', usernameLower: 'source keeper', cpu: 100, cpuAvailable: 10000, gcl: 13966610.2, active: 0 }))
  ps.push(env.set('gameTime', 1))
  return Promise.resolve()
    .then(() => console.log('An error occured importing existing db, initializing blank server'))
    .then(() => console.error(e))
    .then(() => Promise.all(ps))
    .then(() => console.log('Server initialzed. Remember to generate rooms.'))
    .catch(err => console.error(err))
}

