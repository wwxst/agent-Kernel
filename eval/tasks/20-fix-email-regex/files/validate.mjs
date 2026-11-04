/** 简易邮箱校验。 */
export function isEmail(text) {
  return /^\w+@\w+\.\w+$/.test(text);
}
