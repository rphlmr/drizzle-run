import * as assert from "unenv/node/assert";
import * as buffer from "unenv/node/buffer";
import * as events from "unenv/node/events";
import nodeModule from "unenv/node/module";
import * as os from "unenv/node/os";
import * as path from "unenv/node/path";
import * as process from "unenv/node/process";
import * as readline from "unenv/node/readline";
import * as stream from "unenv/node/stream";
import * as stringDecoder from "unenv/node/string_decoder";
import * as tty from "unenv/node/tty";
import * as url from "unenv/node/url";
import * as util from "unenv/node/util";

import * as crypto from "./crypto.ts";
import * as fs from "./filesystem.ts";

const modules: Record<string, unknown> = {
  readline,
  crypto,
  util,
  tty,
  events,
  fs,
  path,
  os,
  assert,
  url,
  process,
  buffer,
  stream,
  string_decoder: stringDecoder,
};

/** Resolve only the guest compatibility modules. */
export function createRequire() {
  return Object.assign(
    (specifier: string) => {
      const module = modules[specifier.replace(/^node:/, "")];

      if (module === undefined) {
        throw new Error(`Unsupported dynamic require in QuickJS runtime: ${specifier}`);
      }

      return module;
    },
    {
      resolve() {
        throw new Error("Module resolution is outside this QuickJS runtime");
      },
      extensions: {},
    },
  );
}

export default { ...nodeModule, createRequire };
