/** 按分数从高到低排。 */
export function byScore(scores) {
  return [...scores].sort((a, b) => a - b);
}
