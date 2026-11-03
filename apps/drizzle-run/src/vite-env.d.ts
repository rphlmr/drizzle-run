/** The build's own variables, set by the deploy workflows. */
interface ImportMetaEnv {
  /** The companion package a preview build pairs with, such as a pkg.pr.new URL; unset for the npm release. */
  readonly VITE_CONNECT_PACKAGE?: string;
}
