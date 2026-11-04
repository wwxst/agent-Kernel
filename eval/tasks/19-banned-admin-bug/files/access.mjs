export function canEdit(user, doc) {
  if (user) {
    if (doc) {
      if (user.role === "admin") {
        return true;
      }
      if (user.banned !== true) {
        if (doc.ownerId === user.id) {
          return true;
        }
      }
    }
  }
  return false;
}
