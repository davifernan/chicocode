// Shim for @rolldown/plugin-babel which ships .d.mts types that TypeScript
// cannot resolve via the "Bundler" strategy when the package.json exports
// field has no explicit "types" entry.
declare module "@rolldown/plugin-babel" {
  import type { PluginOption } from "vite";
  export interface RolldownBabelPreset {
    preset: unknown;
    rolldown?: unknown;
    vite?: PluginOption;
  }
  export interface BabelPluginOptions {
    parserOpts?: Record<string, unknown>;
    presets?: unknown[];
    plugins?: unknown[];
    [key: string]: unknown;
  }
  function babel(options?: BabelPluginOptions): PluginOption;
  export default babel;
  export { babel };
}
