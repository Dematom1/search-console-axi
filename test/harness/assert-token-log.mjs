export function assertTokenExchange(log) {
  const requests = log
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  if (!requests.some((request) => request.method === "POST" && request.url.includes("oauth2.googleapis.com/token")))
    throw new Error("OAuth token exchange was not intercepted by the fake");
}
