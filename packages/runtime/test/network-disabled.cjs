// Consumer acceptance only: inherited by child processes through NODE_OPTIONS.
const deny = () => {
  throw new Error("Network access is disabled in the installed SDK acceptance check");
};
globalThis.fetch = deny;
require("node:http").request = deny;
require("node:http").get = deny;
require("node:https").request = deny;
require("node:https").get = deny;
require("node:net").Socket.prototype.connect = deny;
require("node:dns").lookup = deny;
