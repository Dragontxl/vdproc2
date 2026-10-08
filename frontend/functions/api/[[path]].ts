export async function onRequest(context: { request: Request; env: { API_URL?: string } }) {
  const { request, env } = context;
  const url = new URL(request.url);
  const apiBaseUrl = env.API_URL || 'https://ai-video-worker.goodluckjiachen.workers.dev';
  const apiUrl = `${apiBaseUrl}${url.pathname}${url.search}`;
  
  const headers = new Headers(request.headers);
  const apiHost = new URL(apiBaseUrl).hostname;
  headers.set('Host', apiHost);
  
  const newRequest = new Request(apiUrl, {
    method: request.method,
    headers: headers,
    body: request.body,
    redirect: 'follow',
  });
  
  const response = await fetch(newRequest);
  
  const newResponse = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: {
      ...response.headers,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
  
  return newResponse;
}
