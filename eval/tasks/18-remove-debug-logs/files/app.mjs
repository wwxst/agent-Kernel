export function total(items) {
  console.log("total() called");
  let sum = 0;
  for (const item of items) {
    console.log("adding", item);
    sum += item.price;
  }
  console.log("done", sum);
  return sum;
}
