module.exports = function engine (config) {
  require('./driver')(config)
  config.engine.on('init', function (processType) {
    // processType will be 'runner','processor', or 'main'
    // Useful for detecting what module you are in
  })
}
