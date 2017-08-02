# screepsmod-mongo

## MongoDB And Redis for the Screeps Private Server

[![JavaScript Style Guide](https://img.shields.io/badge/code_style-standard-brightgreen.svg)](https://standardjs.com)
[![CircleCI](https://circleci.com/gh/ScreepsMods/screepsmod-mongo/tree/master.svg?style=shield)](https://circleci.com/gh/ScreepsMods/screepsmod-mongo/tree/master)

### Warning: WIP, may still contain bugs

## Requirements

* nodejs 6+
* mongodb
* redis

## Installation

1. Ensure both mongodb and redis are already installed and running
2. `npm install screepsmod-mongo` inside your server's mods folder
3. Start server!
4. On first start it will import your existing db.json
5. Once done (Check the logs) restart the server
6. Done! 

## Configuration

All options and defaults are listed below

### Mongo

* host: localhost
* port: 27017
* database: screeps

### Redis

* host: localhost
* port: 6379


## Examples

Config can be applied in two ways:

### Mod method 
```
module.exports = function (config) {
	config.mongo.host = '192.168.0.222'
	config.redis.host = '192.168.0.222'
}
```

### ENV Method

Please note that this method only works when launching modules directly, when launched via the defaul launcher they will be ignored.

```
MONGO_HOST='192.168.0.222'
```