import { format } from "./format.mjs";

export function render(name) {
  return format(`Hello, ${name}`);
}
