import { AxiError } from "axi-sdk-js";

export type ParsedArgs = { positionals: string[]; flags: Map<string, string | true> };

export function parseArgs(args: string[], valueFlags: string[], booleanFlags: string[] = []): ParsedArgs {
  const values = new Set(valueFlags);
  const booleans = new Set(booleanFlags);
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (token === "-" || !token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    const equal = token.indexOf("=");
    const name = equal < 0 ? token : token.slice(0, equal);
    const inline = equal < 0 ? undefined : token.slice(equal + 1);
    if (flags.has(name)) throw usage(`Repeated option '${name}'`);
    if (values.has(name)) {
      const value = inline ?? args[++i];
      if (value === undefined || value === "" || (inline === undefined && value.startsWith("--")))
        throw usage(`${name} requires a value`);
      flags.set(name, value);
    } else if (booleans.has(name) && inline === undefined) flags.set(name, true);
    else throw usage(`Unknown option '${name}'`);
  }
  return { positionals, flags };
}

export function usage(message: string): never {
  throw new AxiError(message, "VALIDATION_ERROR", ["Run `search-console-axi --help` for valid commands and options"]);
}
