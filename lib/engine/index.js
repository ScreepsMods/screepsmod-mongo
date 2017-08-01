module.exports = function engine (config) {
  require('./driver')(config)
  config.engine.on('init', function (processType) {
    // processType will be 'runner','processor', or 'main'
    // Useful for detecting what module you are in
    if (processType === 'main') {
      if (!config.common.db.users.count()) {
        importDB()
      }
    }
  })
}

function importDB (config) {
  let { db, env } = config.common.storage
  console.log('Importing DB')
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
  return Promise.all(ps).catch(err => console.error('Import Error', err))
}
