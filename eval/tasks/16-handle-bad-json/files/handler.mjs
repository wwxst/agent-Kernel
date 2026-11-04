/** 处理一个请求：body 是 JSON 文本。 */
export function handle(body) {
  const payload = JSON.parse(body);
  return { status: 200, body: payload };
}
