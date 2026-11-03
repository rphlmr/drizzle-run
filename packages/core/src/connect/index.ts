export { createPairingSecret, normalizePairingSecret, PAIRING_ALPHABET, PAIRING_SECRET_LENGTH } from "./secret.ts";
export type { RandomBytes } from "./secret.ts";
export {
  CONNECT_KDF_ITERATIONS,
  ConnectCryptoError,
  deriveConnectKeys,
  fromBase64Url,
  openText,
  ROOM_ID_PATTERN,
  sealText,
  toBase64Url,
  toRoomId,
} from "./crypto.ts";
export type { ConnectCryptoOptions, ConnectKeys } from "./crypto.ts";
export {
  AGENT_EFFORTS,
  AGENT_IDS,
  AGENT_MODEL_ID_PATTERN,
  AGENT_NAMES,
  CONNECT_LIMITS,
  CONNECT_PROTOCOL,
  CONNECT_ROLES,
  CONNECT_ROOM_PROTOCOL,
  CONNECT_ROUTE_PREFIX,
  connectCommand,
  CONNECT_LOCAL_COMMAND,
  CONNECT_PACKAGE_COMMAND,
  DEFAULT_CONNECT_ORIGIN,
  fitAgentTuning,
  getAgentEfforts,
  isLocalOrigin,
  nextUtcMidnight,
  RELAY_CLOSE,
  resolveAgentTuning,
  roomProtocols,
  sharedProtocolVersion,
  utf8Length,
} from "./protocol.ts";
export type {
  AgentEffort,
  AgentId,
  AgentModel,
  AgentTuning,
  ChatContextEntry,
  ChatMode,
  ChatProject,
  ChatProjectSide,
  ProjectOrigin,
  CompanionAgent,
  CompanionInfo,
  ConnectMessage,
  ConnectMessageType,
  ConnectRole,
  RelayBusyFrame,
  RelayClientFrame,
  RelayErrorCode,
  RelayPeer,
  RelayQuotaFrame,
  RelayServerFrame,
  ToolError,
  ToolErrorCode,
  TurnState,
} from "./protocol.ts";
export { isToolErrorCode, parseRelayClientFrame, parseRelayServerFrame, readConnectMessage } from "./messages.ts";
export { ChannelNotReadyError, SecureChannel } from "./channel.ts";
export type { OpenFailure, OpenResult, SecureChannelOptions } from "./channel.ts";
export {
  CONNECT_FILE_LIMITS,
  CONNECT_TOOL_SCOPES,
  CONNECT_TOOLS,
  connectTool,
  connectToolsFor,
  isConnectToolName,
  isConnectToolScope,
  isToolInScope,
  parseToolInput,
  scopeRefusal,
} from "./tools.ts";
export type {
  ConnectToolCall,
  ConnectToolDefinition,
  ConnectToolInputs,
  ConnectToolName,
  ConnectToolScope,
  FileEditInput,
  PairSideInput,
  ParsedToolInput,
} from "./tools.ts";
export { applyFileEdits, countLineChanges } from "./edits.ts";
export type { FileChange, FileEditFailure, FileEditResult } from "./edits.ts";
export { checkDocsUrl, DOCS_INDEX_URL, DOCS_ORIGIN, DOCS_TEXT_MAX_CHARS, docsText } from "./docs.ts";
export type { DocsUrlCheck, DocsUrlKind } from "./docs.ts";
