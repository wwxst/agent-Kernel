/** 含税价。 */
export function withTax(price) {
  return Math.round(price * (1 + 0.2) * 100) / 100;
}

/** 只算税额。 */
export function taxOf(price) {
  return Math.round(price * 0.2 * 100) / 100;
}

/** 九折之后再算含税价。 */
export function discounted(price) {
  return Math.round(price * 0.9 * (1 + 0.2) * 100) / 100;
}
