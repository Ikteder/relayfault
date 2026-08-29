import http from "node:http";

const port = Number(process.argv[2] ?? 9090);
const server = http.createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    const result = JSON.stringify({
      upstream: true,
      method: request.method,
      path: request.url,
      body,
    });
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(result),
    });
    response.end(result);
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Example upstream listening on http://127.0.0.1:${port}`);
});
