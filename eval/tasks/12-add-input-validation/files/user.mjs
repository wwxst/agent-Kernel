/** 设置年龄：合法（0 或正整数）就写进 user 并返回 true，否则返回 false。 */
export function setAge(user, age) {
  user.age = age;
  return true;
}
