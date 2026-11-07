import { register } from "node:module";
import "./fake-google.mjs";
if (process.env.FAKE_NOW) {
  const OriginalDate = Date;
  const fixedNow = process.env.FAKE_NOW;
  globalThis.Date = class extends OriginalDate {
    constructor(...args) {
      super(...(args.length ? args : [fixedNow]));
    }
    static now() {
      return new OriginalDate(fixedNow).getTime();
    }
  };
}
register("./hooks.mjs", import.meta.url);
