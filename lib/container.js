const Docker = require('dockerode')
const tarstream = require('tar-stream')
const tarfs = require('tar-fs')
const async = require('async')
const chalk = require('chalk')

const docker = new Docker({
  socketPath: '/var/run/docker.sock'
})

class Container {
  constructor (devServer, friendlyName, type) {
    this.devServer = devServer
    this.network = devServer.network
    this.friendlyName = friendlyName
    this.name = (type === 'router') ? 'localapp' : `noop-${this.devServer.ns}-${type}-${friendlyName}`
    this.type = type
    this.container = docker.getContainer(this.name)
    this.desiredRunning = false
    this.restartAttempts = 0
  }

  start (done) {
    const image = this.getImage()
    this.desiredRunning = true
    async.auto({
      removeExisting: (done) => {        
        this.container.inspect((err) => {
          if (err && err.statusCode === 404) {
            done() // no problem if container doesn't exit
          } else if (err) {
            done(err)
          } else {
            this.container.remove({force: true}, done)
          }
        })
      },
      inspectImage: (done) => {
        docker.getImage(image).inspect((err) => {
          if (err && err.statusCode === 404) {
            this.pullImage(done)
          } else {
            done(err)
          }
        })
      },
      container: ['inspectImage', 'removeExisting', (results, done) => {
        const envMap = this.getEnv()
        const env = Object.keys(envMap).map((key) => {
          return `${key}=${envMap[key]}`
        })
        const opts = {
          'AttachStdout': true,
          'AttachStderr': true,
          'Image': image,
          'Hostname': this.name,
          'name': this.name
        }
        if (env.length) opts.Env = env
        if (this.type === 'router') {
          opts.HostConfig = {
            PortBindings: {
              '443/tcp': [{HostPort: this.devServer.port.toString()}]
            }
          }
          opts.ExposedPorts = {'443/tcp': {}, '80/tcp': {}}
        }
        docker.createContainer(opts, done)
      }],
      network: ['container', (results, done) => {
        this.network.attachContainer(this.name, done)
      }],
      output: ['container', (results, done) => this.handleOutput(done)],
      start: ['network', 'output', (results, done) => {
        console.log(`Starting '${this.friendlyName}' ${this.type} container`)
        results.container.start(done)
      }],
      watch: ['start', (results, done) => this.watchForExit(done)]
    }, done)
  }

  stop (done) {
    this.desiredRunning = false
    this.container.remove({force: true}, (err) => {
      if (err) return done(err)
      console.log(`Stopped ${this.type} '${this.friendlyName}' container`)
      done()
    })
  }

  restart () {
    this.restartAttempts++
    if (this.restartAttempts > 10) return false
    console.log(`Restarting ${this.type} '${this.friendlyName}' container attempt #${this.restartAttempts}`)
    this.start((err) => {
      if (err) console.log(`Unable to restart ${this.type} '${this.friendlyName}' container`, err)
    })
  }

  handleOutput (done) {
    if (this.type === 'resource') return done()
    const opts = {
      stream: true,
      stdout: true,
      stderr: true
    }
    this.container.attach(opts, (err, stream) => {
      if (err) return done(err)
      let spaces = ''
      let prefix
      if (this.friendlyName.length < 16) {
        spaces = Array(16 - this.friendlyName.length).join(' ')
      }
      if (this.type === 'router') {
        prefix = chalk.magenta(this.friendlyName.substr(0, 16))
      } else {
        prefix = chalk.cyan(this.friendlyName.substr(0, 16))
      }
      stream.on('data', (data) => {
        data = data.slice(8) // no idea why the first 8 bytes is garbage
        let lines = data.toString().split(/(\r\n|\r|\n)/)
        lines.forEach((line) => {
          if (/\w/.test(line)) console.log(` ${prefix}${spaces} ${line}`)
        })
      })
      done()
    })
  }

  watchForExit (done) {
    this.container.wait((err, data) => {
      if (err) return done(err)
      const capsType = this.type.charAt(0).toUpperCase() + this.type.slice(1)
      if (this.desiredRunning) {
        console.log(chalk.red(`${capsType} container '${this.friendlyName}' exited with status code ${data.StatusCode}`))
        this.restart()
      }
    })
    done()
  }

  pullImage (done) {
    const image = this.getImage()
    console.log(`Pulling container image '${image}'`)
    const complete = (err) => {
      console.log('DONE')
      if (err) {
        console.log(chalk.red(`Error pulling container image ${image}`))
        done(new ContainerPullError(err))
      } else {
        console.log(`Completed pull of container image '${image}'`)
        done()
      }
    }
    docker.createImage({fromImage: image}, (err, output) => {
      if (err) return done(err)
      docker.modem.followProgress(output, complete, (event) => {
        // nothing to do with the output
      })
    })
  }

  getEnv() {
    return {}
  }
}

module.exports = Container