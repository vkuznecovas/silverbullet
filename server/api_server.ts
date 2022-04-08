import express, { Express } from "express";
import { SilverBulletHooks } from "../common/manifest";
import { EndpointHook } from "../plugos/hooks/endpoint";
import { readFile } from "fs/promises";
import { System } from "../plugos/system";
import cors from "cors";
import { DiskSpacePrimitives } from "../common/spaces/disk_space_primitives";
import path from "path";
import bodyParser from "body-parser";
import { EventHook } from "../plugos/hooks/event";
import spaceSyscalls from "./syscalls/space";
import { eventSyscalls } from "../plugos/syscalls/event";
import { pageIndexSyscalls } from "./syscalls";
import knex, { Knex } from "knex";
import shellSyscalls from "../plugos/syscalls/shell.node";
import { NodeCronHook } from "../plugos/hooks/node_cron";
import { markdownSyscalls } from "../common/syscalls/markdown";
import { EventedSpacePrimitives } from "../common/spaces/evented_space_primitives";
import { Space } from "../common/spaces/space";
import { safeRun } from "../webapp/util";
import { createSandbox } from "../plugos/environments/node_sandbox";

export class ExpressServer {
  app: Express;
  system: System<SilverBulletHooks>;
  private rootPath: string;
  private space: Space;
  private distDir: string;
  private eventHook: EventHook;
  private db: Knex<any, unknown[]>;

  constructor(
    app: Express,
    rootPath: string,
    distDir: string,
    system: System<SilverBulletHooks>
  ) {
    this.app = app;
    this.rootPath = rootPath;
    this.distDir = distDir;
    this.system = system;

    // Setup system
    this.eventHook = new EventHook();
    system.addHook(this.eventHook);
    this.space = new Space(
      new EventedSpacePrimitives(
        new DiskSpacePrimitives(rootPath),
        this.eventHook
      ),
      true
    );
    this.db = knex({
      client: "better-sqlite3",
      connection: {
        filename: path.join(rootPath, "data.db"),
      },
      useNullAsDefault: true,
    });

    system.registerSyscalls(["shell"], shellSyscalls(rootPath));
    system.addHook(new NodeCronHook());

    system.registerSyscalls([], pageIndexSyscalls(this.db));
    system.registerSyscalls([], spaceSyscalls(this.space));
    system.registerSyscalls([], eventSyscalls(this.eventHook));
    system.registerSyscalls([], markdownSyscalls());
    system.addHook(new EndpointHook(app, "/_/"));

    this.space.on({
      plugLoaded: (plugName, plug) => {
        safeRun(async () => {
          console.log("Plug load", plugName);
          await system.load(plugName, plug, createSandbox);
        });
      },
      plugUnloaded: (plugName) => {
        safeRun(async () => {
          console.log("Plug unload", plugName);
          await system.unload(plugName);
        });
      },
    });

    setInterval(() => {
      this.space.updatePageListAsync();
    }, 5000);
    this.space.updatePageListAsync();
  }

  async init() {
    console.log("Setting up router");

    let fsRouter = express.Router();

    // Page list
    fsRouter.route("/").get(async (req, res) => {
      let { nowTimestamp, pages } = await this.space.fetchPageList();
      res.header("Now-Timestamp", "" + nowTimestamp);
      res.json([...pages]);
    });

    fsRouter.route("/").post(bodyParser.json(), async (req, res) => {});

    fsRouter
      .route(/\/(.+)/)
      .get(async (req, res) => {
        let pageName = req.params[0];
        // console.log("Getting", pageName);
        try {
          let pageData = await this.space.readPage(pageName);
          res.status(200);
          res.header("Last-Modified", "" + pageData.meta.lastModified);
          res.header("Content-Type", "text/markdown");
          res.send(pageData.text);
        } catch (e) {
          // CORS
          res.status(200);
          res.header("X-Status", "404");
          res.send("");
        }
      })
      .put(bodyParser.text({ type: "*/*" }), async (req, res) => {
        let pageName = req.params[0];
        console.log("Saving", pageName);

        try {
          let meta = await this.space.writePage(
            pageName,
            req.body,
            false,
            req.header("Last-Modified")
              ? +req.header("Last-Modified")!
              : undefined
          );
          res.status(200);
          res.header("Last-Modified", "" + meta.lastModified);
          res.send("OK");
        } catch (err) {
          res.status(500);
          res.send("Write failed");
          console.error("Pipeline failed", err);
        }
      })
      .options(async (req, res) => {
        let pageName = req.params[0];
        try {
          const meta = await this.space.getPageMeta(pageName);
          res.status(200);
          res.header("Last-Modified", "" + meta.lastModified);
          res.header("Content-Type", "text/markdown");
          res.send("");
        } catch (e) {
          // CORS
          res.status(200);
          res.header("X-Status", "404");
          res.send("Not found");
        }
      })
      .delete(async (req, res) => {
        let pageName = req.params[0];
        try {
          await this.space.deletePage(pageName);
          res.status(200);
          res.send("OK");
        } catch (e) {
          console.error("Error deleting file", e);
          res.status(500);
          res.send("OK");
        }
      });

    this.app.use(
      "/fs",
      cors({
        methods: "GET,HEAD,PUT,OPTIONS,POST,DELETE",
        preflightContinue: true,
      }),
      fsRouter
    );

    let plugRouter = express.Router();

    plugRouter.post(
      "/:plug/syscall/:name",
      bodyParser.json(),
      async (req, res) => {
        const name = req.params.name;
        const plugName = req.params.plug;
        const args = req.body as any;
        const plug = this.system.loadedPlugs.get(plugName);
        if (!plug) {
          res.status(404);
          return res.send(`Plug ${plugName} not found`);
        }
        try {
          const result = await this.system.syscallWithContext(
            { plug },
            name,
            args
          );
          res.status(200);
          res.send(result);
        } catch (e: any) {
          res.status(500);
          return res.send(e.message);
        }
      }
    );
    plugRouter.post(
      "/:plug/function/:name",
      bodyParser.json(),
      async (req, res) => {
        const name = req.params.name;
        const plugName = req.params.plug;
        const args = req.body as any[];
        const plug = this.system.loadedPlugs.get(plugName);
        if (!plug) {
          res.status(404);
          return res.send(`Plug ${plugName} not found`);
        }
        try {
          console.log("Invoking", name, "with args", args);
          const result = await plug.invoke(name, args);
          res.status(200);
          res.send(result);
        } catch (e: any) {
          res.status(500);
          console.log("Error invoking function", e);
          return res.send(e.message);
        }
      }
    );

    this.app.use(
      "/plug",
      cors({
        methods: "GET,HEAD,PUT,OPTIONS,POST,DELETE",
        preflightContinue: true,
      }),
      plugRouter
    );

    // Fallback, serve index.html
    let cachedIndex: string | undefined = undefined;
    this.app.get("/*", async (req, res) => {
      if (!cachedIndex) {
        cachedIndex = await readFile(`${this.distDir}/index.html`, "utf8");
      }
      res.status(200).header("Content-Type", "text/html").send(cachedIndex);
    });
  }
}
