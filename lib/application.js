'use strict';

const { node, npm, metarhia } = require('./dependencies.js');
const { path, events, fs } = node;
const { metavm, metawatch } = metarhia;

const { Interfaces } = require('./interfaces.js');
const { Modules } = require('./modules.js');
const { Resources } = require('./resources.js');
const { Schemas } = require('./schemas.js');
const { Scheduler } = require('./scheduler.js');
const auth = require('./auth.js');

class Error extends global.Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const SANDBOX = { ...metavm.COMMON_CONTEXT, Error, node, npm, metarhia };

class Application extends events.EventEmitter {
  constructor() {
    super();
    this.kind = '';
    this.initialization = true;
    this.finalization = false;
    this.root = process.cwd();
    this.path = path.join(this.root, 'application');

    this.schemas = new Schemas('schemas', this);
    this.static = new Resources('static', this);
    this.resources = new Resources('resources', this);
    this.api = new Interfaces('api', this);
    this.lib = new Modules('lib', this);
    this.db = new Modules('db', this);
    this.domain = new Modules('domain', this);
    this.scheduler = new Scheduler(this);

    this.starts = [];
    this.Application = Application;
    this.Error = Error;
    this.cert = null;
    this.config = null;
    this.logger = null;
    this.console = null;
    this.auth = null;
    this.watcher = null;
  }

  absolute(relative) {
    return path.join(this.path, relative);
  }

  async init(kind) {
    this.kind = kind;
    this.startWatch();
    this.createSandbox();
    await Promise.allSettled([
      this.schemas.load(),
      this.static.load(),
      this.resources.load(),
      (async () => {
        await this.lib.load();
        await this.db.load();
        await this.domain.load();
      })(),
    ]);
    await Promise.allSettled(this.starts.map((fn) => this.execute(fn)));
    await this.api.load();
    if (kind === 'scheduler') await this.scheduler.load();
    const { api } = this.sandbox;
    if (api.auth) {
      const { provider } = api.auth;
      if (provider) {
        this.auth = provider;
      } else {
        const provider = auth(this.config.sessions);
        this.auth = provider;
        api.auth.provider = provider;
      }
    }
    this.starts = [];
    this.initialization = false;
  }

  async shutdown() {
    this.finalization = true;
    await this.stopPlace('domain');
    await this.stopPlace('db');
    await this.stopPlace('lib');
    if (this.server) await this.server.close();
    await this.logger.close();
  }

  async stopPlace(name) {
    const place = this.sandbox[name];
    for (const moduleName of Object.keys(place)) {
      const module = place[moduleName];
      if (module.stop) await this.execute(module.stop);
    }
  }

  createSandbox() {
    const { config, console, resources, schemas, scheduler } = this;
    const { server: { host, port, protocol } = {} } = this;
    const worker = { id: 'W' + node.worker.threadId.toString() };
    const server = { host, port, protocol };
    const application = { worker, server, resources, schemas, scheduler };
    application.introspect = async (interfaces) => this.introspect(interfaces);
    const sandbox = { ...SANDBOX, console, application, config };
    sandbox.api = {};
    sandbox.lib = this.lib.tree;
    sandbox.db = this.db.tree;
    sandbox.domain = this.domain.tree;
    this.sandbox = metavm.createContext(sandbox);
  }

  getMethod(iname, ver, methodName) {
    const iface = this.api.collection[iname];
    if (!iface) return null;
    const version = ver === '*' ? iface.default : parseInt(ver, 10);
    const methods = iface[version.toString()];
    if (!methods) return null;
    const proc = methods[methodName];
    if (!proc) return null;
    return proc;
  }

  getHook(iname) {
    const iface = this.api.collection[iname];
    if (!iface) return null;
    const hook = iface[iface.default];
    if (!hook) return null;
    return hook;
  }

  execute(method) {
    return method().catch((err) => {
      this.console.error(err.stack);
    });
  }

  startWatch() {
    const timeout = this.config.server.timeouts.watch;
    this.watcher = new metawatch.DirectoryWatcher({ timeout });

    this.watcher.on('change', (filePath) => {
      const relPath = filePath.substring(this.path.length + 1);
      const sepIndex = relPath.indexOf(path.sep);
      const place = relPath.substring(0, sepIndex);
      fs.stat(filePath, (err, stat) => {
        if (err) return;
        if (stat.isDirectory()) {
          this[place].load(filePath);
          return;
        }
        if (node.worker.threadId === 1) {
          this.console.debug('Reload: /' + relPath);
        }
        this[place].change(filePath);
      });
    });

    this.watcher.on('delete', async (filePath) => {
      const relPath = filePath.substring(this.path.length + 1);
      const sepIndex = relPath.indexOf(path.sep);
      const place = relPath.substring(0, sepIndex);
      this[place].delete(filePath);
      if (node.worker.threadId === 1) {
        this.console.debug('Deleted: /' + relPath);
      }
    });
  }

  introspect(interfaces) {
    const intro = {};
    for (const interfaceName of interfaces) {
      const [iname, ver = '*'] = interfaceName.split('.');
      const iface = this.api.collection[iname];
      if (!iface) continue;
      const version = ver === '*' ? iface.default : parseInt(ver);
      intro[iname] = this.api.signatures[iname + '.' + version];
    }
    return intro;
  }

  getStaticFile(fileName) {
    return this.static.get(fileName);
  }
}

module.exports = new Application();
