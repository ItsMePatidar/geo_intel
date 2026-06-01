// Fetch H3 cells from the API
export async function fetchH3Cells() {
  const res = await fetch('/api/h3cells');
  const result = await res.json();
  return result.data;
}
