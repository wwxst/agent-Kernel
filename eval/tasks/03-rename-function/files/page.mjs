import { fetchUser } from "./api.mjs";

export function render(id) {
  const user = fetchUser(id);
  return `<span>${user.name}</span>`;
}
