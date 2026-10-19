// Module resolution hook (see register.mjs). Only bare @appport/* specifiers imported by files under the checkout's
// appport-bridge/ are redirected; everything else resolves normally.
let bridge;
let base;
export function initialize(data) {
  bridge = data.bridge;
  base = data.base;
}
export function resolve(specifier, context, next) {
  if (specifier.startsWith("@appport/") && context.parentURL?.startsWith(bridge)) return next(specifier, { ...context, parentURL: base });
  return next(specifier, context);
}
