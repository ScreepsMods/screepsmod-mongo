# screepsmod-mongo

## MongoDB And Redis for the Screeps Private Server

[![JavaScript Style Guide](https://img.shields.io/badge/code_style-standard-brightgreen.svg)](https://standardjs.com)
[![CircleCI](https://circleci.com/gh/ScreepsMods/screepsmod-mongo/tree/master.svg?style=shield)](https://circleci.com/gh/ScreepsMods/screepsmod-mongo/tree/master)

## Requirements

* nodejs 6+
* mongodb
* redis

## Installation

1. Ensure both mongodb and redis are already installed and running
2. `npm install screepsmod-mongo` inside your server's mods folder
3. Start server!
4. 
  A). `mongo.importDB()` in the screeps cli imports your existing DB
  B). `mongo.resetAllData()` in the screeps cli for a completely fresh DB
5. Once done restart the server
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

Config can be applied in several ways:

### .screepsrc (Recommended)

Add to the bottom of your .screepsrc file
```
[mongo]
host = 192.168.0.222

[redis]
host = 192.168.0.222
```

### ENV Method

Please note that this method only works when launching modules directly, when launched via the default launcher they will be ignored.

```
MONGO_HOST='192.168.0.222'
```
