declare module "pino/browser.js" {
  import type { Logger, LoggerOptions } from "pino";

  function pino(options?: LoggerOptions): Logger;

  export default pino;
}
