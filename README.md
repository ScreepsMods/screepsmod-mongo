# screepsmod-mongo

## MongoDB And Redis for the Screeps Private Server

[![JavaScript Style Guide](https://img.shields.io/badge/code_style-standard-brightgreen.svg)](https://standardjs.com)
[![CircleCI](https://circleci.com/gh/ScreepsMods/screepsmod-mongo/tree/master.svg?style=shield)](https://circleci.com/gh/ScreepsMods/screepsmod-mongo/tree/master)

## Requirements

* nodejs 6+
* screeps 3.0+
* mongodb
* redis

## Installation

1. Ensure both mongodb and redis are already installed and running
2. `npm install screepsmod-mongo` inside your server's mods folder
3. Start server!  
4. DB Population
    1. `mongo.importDB()` in the screeps cli imports your existing DB
    2. `mongo.resetAllData()` in the screeps cli for a completely fresh DB
5. Once done restart the server
6. Done! 

## Usage

With this mod installed you can continue to manage the server as usual,
all CLI commands still function and bahave functionally identical.
The original storage module will still run, but is completely ignored.

Keep in mind that RAM requirements are slightly higher, by default mongo
uses 50% - 1G of your system RAM. Redis on the other hand, uses very little.

Mongo and Redis CLIs can be used to see and modify the data as usual,
backups and restores should be done via normal mongo and redis tools.

https://docs.mongodb.com/manual/tutorial/backup-and-restore-tools/  
https://redis.io/topics/persistence

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
