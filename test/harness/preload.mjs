import { register } from "node:module";
import "./fake-google.mjs";
register("./hooks.mjs", import.meta.url);
