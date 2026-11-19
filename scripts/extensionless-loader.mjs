// Tiny ESM resolve hook for the verification harnesses: the lib/*.js
// sources use extensionless relative imports ('./ingest'), which the
// Next.js bundler resolves but plain Node does not. Registering this
// hook lets scripts import the real lib modules unmodified.
export async function resolve(specifier, context, nextResolve) {
  if (
    (specifier.startsWith('./') || specifier.startsWith('../')) &&
    !/\.[a-z0-9]+$/i.test(specifier)
  ) {
    try {
      return await nextResolve(`${specifier}.js`, context);
    } catch {
      /* fall through to the default error */
    }
  }
  return nextResolve(specifier, context);
}
