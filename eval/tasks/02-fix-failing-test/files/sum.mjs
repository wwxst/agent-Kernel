/** 求一组数字的和。 */
export function sum(numbers) {
  let total = 0;
  for (let index = 1; index < numbers.length; index += 1) {
    total += numbers[index];
  }
  return total;
}
