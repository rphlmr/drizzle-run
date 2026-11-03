export {
  assertSupportedTuple,
  compareVersions,
  findSupportedTuple,
  getRecommendedTuple,
  isSupportedTuple,
  listSupportedTargets,
  listSupportedTuples,
  releaseLineOf,
  resolveSupportedTuple,
  selectFromPairs,
} from "../registry/selectors.ts";
export type { ReleasePairSelection } from "../registry/selectors.ts";
export { DIALECT_IDS, DIALECTS, DialectSchema } from "../releases/dialects.ts";
export type { Dialect, DialectDescriptor } from "../releases/dialects.ts";
export { GUEST_FLAVORS, hasGuestFlavor, resolveGuestFlavor } from "../registry/guest-images.ts";
export type { GuestFlavor, GuestSelection } from "../registry/guest-images.ts";
export { listCompanionLibraries } from "../registry/approved-modules.ts";
export type { CompanionLibrary } from "../registry/approved-modules.ts";
export type {
  DatabaseTarget,
  DatabaseTargetId,
  PublicRuntimeTuple,
  RuntimeReleaseLine,
  RuntimeTupleId,
  RuntimeTupleQuery,
  RuntimeTupleSelection,
  SupportedRuntimeTuple,
} from "../registry/types.ts";
