export async function resolve(specifier, context, next) {
  if (specifier === "node-fetch")
    return { url: new URL("./node-fetch-shim.mjs", import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
}
