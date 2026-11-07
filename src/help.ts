import { encode } from "@toon-format/toon";

export type Help = { purpose: string; flags: Record<string, string>; examples: string[]; next: string[] };
export function helpText(name: string, help: Help): string {
  return encode({ command: name, purpose: help.purpose, flags: help.flags, examples: help.examples, next: help.next });
}
