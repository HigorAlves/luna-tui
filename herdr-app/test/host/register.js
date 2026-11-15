// Maps Herdr's host modules (`gpui-kit`, `gpui-base`, `herdr`) to the stand-in beside this file,
// so the mod's drawing code runs under `node --test`.
import { registerHooks } from "node:module";

const HOST = new Set(["gpui-kit", "gpui-base", "herdr"]);
const STUB = new URL("./stub.js", import.meta.url).href;

registerHooks({
  resolve(specifier, context, next) {
    if (HOST.has(specifier)) return { url: STUB, shortCircuit: true };
    return next(specifier, context);
  },
});
