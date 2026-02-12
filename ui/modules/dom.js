// Get element by id
export const $ = (id) => document.getElementById(id);

// Set textContent by id
export function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}
