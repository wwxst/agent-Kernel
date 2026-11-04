/** 一个最小的路由表：把 pathname 映射成响应。 */
export function handle(pathname) {
  if (pathname === "/") return { status: 200, body: { name: "demo" } };
  if (pathname === "/users") return { status: 200, body: [{ id: 1 }] };
  return { status: 404, body: { error: "not found" } };
}
