import manifest from "../package.json" with { type: "json" };

/** The package version reported by the CLI, MCP server, and companion handshake. */
export const VERSION = manifest.version;
