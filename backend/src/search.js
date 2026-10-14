const SEARCH_URL = process.env.SEARCH_URL || "http://localhost:9200";

export async function searchHealth() {
  const res = await fetch(`${SEARCH_URL}/_cluster/health`, {
    signal: AbortSignal.timeout(2000),
  });

  if (!res.ok) {
    throw new Error(`search returned ${res.status}`);
  }

  return res.json();
}
