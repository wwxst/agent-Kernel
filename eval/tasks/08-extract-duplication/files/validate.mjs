export function validateName(name) {
  if (typeof name !== "string") return "name must be a string";
  if (name.trim() === "") return "name must not be empty";
  if (name.length > 40) return "name must be at most 40 chars";
  return null;
}

export function validateTitle(title) {
  if (typeof title !== "string") return "title must be a string";
  if (title.trim() === "") return "title must not be empty";
  if (title.length > 40) return "title must be at most 40 chars";
  return null;
}
