const { EventEmitter } = require('events')

class PubSub extends EventEmitter {
  constructor (pub, sub) {
    super()
    this.subscribed = {}
    this.pub = pub
    this.sub = sub
    sub.on('message', (channel, message) => {
      this.emit(channel, channel, message)
    })
    sub.on('pmessage', (pattern, channel, message) => {
      this.emit(pattern, channel, message)
    })
  }
  async publish (channel, data) {
    this.pub.publish(channel, data)
  }
  async subscribe (channel, cb) {
    this.checkSub(channel)
    const wrapped = (channel, ...args) => cb.apply({ channel }, args)
    this.on(channel, wrapped)
  }
  async once (channel, cb) {
    this.checkSub(channel)
    const wrapped = (channel, ...args) => cb.apply({ channel }, args)
    EventEmitter.prototype.once.call(this, channel, wrapped)
  }
  checkSub (channel) {
    if (!this.subscribed[channel]) {
      if (channel.match(/[?*]/)) {
        this.sub.psubscribe(channel)
      } else {
        this.sub.subscribe(channel)
      }
      this.subscribed[channel] = true
    }
  }
}
module.exports = PubSub
