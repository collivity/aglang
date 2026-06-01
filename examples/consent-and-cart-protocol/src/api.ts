export async function callApi(path: string): Promise<unknown> {
  return fetch(`https://api.example.com${path}`);
}
